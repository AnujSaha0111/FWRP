import type {
  PrismaClient,
  Requirement,
  RequirementHistoryAction,
  User,
} from '@prisma/client';
import { Priority, RequirementStatus } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { persistAuditEvent } from './audit.service';
import { strictDateField } from '../utils/validation';
import { assertCategoryActive } from '../utils/categoryValidation';
import {
  canRequirementTransition,
  requirementStatusesLeadingTo,
} from '../utils/requirementState';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';

// ---------------------------------------------------------------------------
// REQ-01: recipient requirement creation (PRD FR-07, §24.4).
//
// Recipient-only and verified-organization-only. The owning organization comes
// EXCLUSIVELY from the authenticated session user row (never from the body or
// query). The initial status is always OPEN and `quantity_fulfilled` keeps its
// model default (0); both are server-controlled and rejected if supplied.
//
// Scope: creation only. REQ-03 wires active-category validation (ADR-007
// String-validation variant) at this boundary; editing lives in REQ-02.
// `quantity_fulfilled` keeps its model default (0); no allocation/
// partial-fulfillment (D-06 unresolved) and no schema change. REQ-01 defines
// no audit/notification (none emitted here).

export const createRequirementSchema = z
  .object({
    food_category: z.string().trim().min(1, 'food_category is required').max(200),
    food_type: z.string().trim().min(1, 'food_type is required').max(200),
    quantity_required: z
      .number({ invalid_type_error: 'quantity_required must be a number' })
      .positive('quantity_required must be greater than 0')
      .finite(),
    required_by: strictDateField('required_by'),
    priority: z.nativeEnum(Priority, {
      errorMap: () => ({ message: 'priority must be a valid Priority' }),
    }),
    location: z.string().trim().min(1, 'location is required').max(500),
  })
  .strict();

export type CreateRequirementInput = z.input<typeof createRequirementSchema>;

// Safe response projection (snake_case per PRD §24.4 field naming). The
// Requirement model carries no secret fields; this is still an explicit
// mapping so server-managed fields cannot drift into the response implicitly.
export interface RequirementProfile {
  id: string;
  organization_id: string;
  food_category: string;
  food_type: string;
  quantity_required: number;
  quantity_fulfilled: number;
  required_by: Date;
  priority: Priority;
  location: string;
  status: RequirementStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateRequirementResult {
  requirement: RequirementProfile;
}

type RecipientWithOrg = Pick<User, 'id' | 'role' | 'status'> & {
  organization: { id: string; verificationStatus: string } | null;
};

function mapRequirementMutationError(
  err: unknown,
  operation: 'create' | 'update' | 'cancel'
): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2003'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Referenced record not found');
  }
  // Never leak SQL, connection details, or row internals.
  if (operation === 'cancel') {
    return new AppError(500, 'REQUIREMENT_CANCEL_FAILED', 'Failed to cancel requirement');
  }
  if (operation === 'update') {
    return new AppError(500, 'REQUIREMENT_UPDATE_FAILED', 'Failed to update requirement');
  }
  return new AppError(500, 'REQUIREMENT_CREATE_FAILED', 'Failed to create requirement');
}

function toRequirementProfile(requirement: Requirement): RequirementProfile {
  return {
    id: requirement.id,
    organization_id: requirement.organizationId,
    food_category: requirement.foodCategory,
    food_type: requirement.foodType,
    quantity_required: requirement.quantityRequired,
    quantity_fulfilled: requirement.quantityFulfilled,
    required_by: requirement.requiredBy,
    priority: requirement.priority,
    location: requirement.location,
    status: requirement.status,
    created_at: requirement.createdAt,
    updated_at: requirement.updatedAt,
  };
}

export async function createRequirement(
  userId: string,
  input: unknown
): Promise<CreateRequirementResult> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  const parsed = createRequirementSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const data = parsed.data;

  // FR-07: the requirement deadline must be in the future.
  if (data.required_by.getTime() <= Date.now()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'required_by', message: 'required_by must be in the future' },
    ]);
  }

  const client: PrismaClient = getPrisma();

  // REQ-01 gate: identity comes ONLY from the authenticated session user row.
  let caller: RecipientWithOrg | null;
  try {
    caller = (await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true, verificationStatus: true } },
      },
    })) as RecipientWithOrg | null;
  } catch (err) {
    throw mapRequirementMutationError(err, 'create');
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Belt-and-suspenders behind the route's requireRole('RECIPIENT').
  if (caller.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can create requirements');
  }
  if (!caller.organization || caller.organization.verificationStatus !== 'VERIFIED') {
    throw new AppError(403, 'FORBIDDEN', 'Organization is not verified');
  }
  // Capture primitive before the transaction so narrowing is preserved.
  const organizationId = caller.organization.id;

  // REQ-03: food_category must resolve to an ACTIVE Category (ADR-007).
  try {
    await assertCategoryActive(client, data.food_category, 'food_category');
  } catch (err) {
    throw mapRequirementMutationError(err, 'create');
  }

  try {
    // REQ-06: the requirement and its authoritative CREATE history record are
    // written in the SAME transaction — a history failure rolls back creation.
    const requirement = await client.$transaction(async (tx) => {
      const created = await tx.requirement.create({
        data: {
          // Ownership is derived from the session caller's verified organization.
          organizationId,
          foodCategory: data.food_category,
          foodType: data.food_type,
          quantityRequired: data.quantity_required,
          requiredBy: data.required_by,
          priority: data.priority,
          location: data.location,
          // quantityFulfilled keeps the model default (0).
          status: 'OPEN',
        },
      });
      await tx.requirementHistory.create({
        data: {
          requirementId: created.id,
          organizationId: created.organizationId,
          actorId: caller.id,
          action: 'CREATE',
          ...requirementHistorySnapshot(created),
        },
      });
      return created;
    });
    return { requirement: toRequirementProfile(requirement) };
  } catch (err) {
    throw mapRequirementMutationError(err, 'create');
  }
}

export interface RequirementsService {
  createRequirement(userId: string, input: unknown): Promise<CreateRequirementResult>;
  updateRequirement(
    requirementId: string,
    userId: string,
    input: unknown
  ): Promise<UpdateRequirementResult>;
  cancelRequirement(requirementId: string, userId: string): Promise<CancelRequirementResult>;
  listRequirements(
    userId: string,
    query: Record<string, unknown>
  ): Promise<PaginationResult<RequirementProfile>>;
  getRequirementHistory(
    userId: string,
    query: Record<string, unknown>
  ): Promise<PaginationResult<RequirementHistoryItem>>;
}

export const requirementsService: RequirementsService = {
  createRequirement: (userId, input) => createRequirement(userId, input),
  updateRequirement: (requirementId, userId, input) =>
    updateRequirement(requirementId, userId, input),
  cancelRequirement: (requirementId, userId) => cancelRequirement(requirementId, userId),
  listRequirements: (userId, query) => listRequirements(userId, query),
  getRequirementHistory: (userId, query) => getRequirementHistory(userId, query),
};

// ---------------------------------------------------------------------------
// REQ-02: owner-organization requirement editing (PRD FR-07, §24.4).
//
// Only the recipient organization that owns the requirement may edit it, and
// only while status is OPEN or PARTIALLY_FULFILLED. Partial update (project PUT
// convention): the create contract is reused via `.partial()` with an
// at-least-one-field rule, so an empty body is rejected rather than a silent
// no-op. Ownership comes ONLY from the session caller's persisted organization.
//
// The `quantity_fulfilled <= quantity_required` invariant is preserved against
// the EFFECTIVE quantity (a reduction below the already-fulfilled amount is
// rejected). `status` is never changed here (lifecycle transitions are REQ-04),
// and no allocation/remaining-quantity semantics are introduced (D-06 remains
// unresolved). The edit + one `REQUIREMENT_UPDATED` audit event commit in the
// SAME transaction (audit failure rolls back).

export const updateRequirementSchema = createRequirementSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one editable field is required',
    path: ['food_category'],
  });

export type UpdateRequirementInput = z.input<typeof updateRequirementSchema>;

export interface UpdateRequirementResult {
  requirement: RequirementProfile;
}

// Statuses in which REQ-02 permits editing (do not expand).
export const EDITABLE_REQUIREMENT_STATUSES = ['OPEN', 'PARTIALLY_FULFILLED'] as const;

// Editable requirement state captured for audit old/new values. `updatedAt`
// (the server-managed marker) is included so the change is auditable.
function requirementAuditSnapshot(requirement: Requirement) {
  return {
    foodCategory: requirement.foodCategory,
    foodType: requirement.foodType,
    quantityRequired: requirement.quantityRequired,
    quantityFulfilled: requirement.quantityFulfilled,
    requiredBy: requirement.requiredBy,
    priority: requirement.priority,
    location: requirement.location,
    status: requirement.status,
    updatedAt: requirement.updatedAt,
  };
}

// REQ-06: requirement state snapshot persisted into RequirementHistory. Unlike
// the audit snapshot this is the immutable history payload (no `updatedAt`).
function requirementHistorySnapshot(requirement: Requirement) {
  return {
    foodCategory: requirement.foodCategory,
    foodType: requirement.foodType,
    quantityRequired: requirement.quantityRequired,
    quantityFulfilled: requirement.quantityFulfilled,
    requiredBy: requirement.requiredBy,
    priority: requirement.priority,
    location: requirement.location,
    status: requirement.status,
  };
}

export async function updateRequirement(
  requirementId: string,
  userId: string,
  input: unknown
): Promise<UpdateRequirementResult> {
  if (typeof requirementId !== 'string' || requirementId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'requirementId', message: 'Requirement id is required' },
    ]);
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  const parsed = updateRequirementSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const data = parsed.data;

  const client: PrismaClient = getPrisma();

  let caller: RecipientWithOrg | null;
  try {
    caller = (await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true, verificationStatus: true } },
      },
    })) as RecipientWithOrg | null;
  } catch (err) {
    throw mapRequirementMutationError(err, 'update');
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Belt-and-suspenders behind the route's requireRole('RECIPIENT').
  if (caller.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can edit requirements');
  }
  if (!caller.organization) {
    throw new AppError(403, 'FORBIDDEN', 'Organization required');
  }
  const organizationId = caller.organization.id;

  try {
    const requirement = await client.$transaction(async (tx) => {
      const existing = await tx.requirement.findUnique({ where: { id: requirementId } });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Requirement not found');
      }
      // Ownership: only the persisted owning organization may edit.
      if (existing.organizationId !== organizationId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized for this requirement');
      }
      // Editable statuses only (no lifecycle transition here).
      if (!(EDITABLE_REQUIREMENT_STATUSES as readonly string[]).includes(existing.status)) {
        throw new AppError(409, 'CONFLICT', 'Requirement is not editable in its current status');
      }

      // Effective-value re-validation.
      const effectiveRequiredBy = data.required_by ?? existing.requiredBy;
      if (effectiveRequiredBy.getTime() <= Date.now()) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
          { field: 'required_by', message: 'required_by must be in the future' },
        ]);
      }
      const effectiveQuantity = data.quantity_required ?? existing.quantityRequired;
      if (effectiveQuantity < existing.quantityFulfilled) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
          {
            field: 'quantity_required',
            message: 'quantity_required cannot be less than the already fulfilled quantity',
          },
        ]);
      }

      // REQ-03: validate an edited food_category against the ACTIVE Category set
      // (ADR-007) — only when the edit actually changes it.
      if (data.food_category !== undefined) {
        await assertCategoryActive(tx, data.food_category, 'food_category');
      }

      const updateData: {
        foodCategory?: string;
        foodType?: string;
        quantityRequired?: number;
        requiredBy?: Date;
        priority?: Priority;
        location?: string;
      } = {};
      if (data.food_category !== undefined) updateData.foodCategory = data.food_category;
      if (data.food_type !== undefined) updateData.foodType = data.food_type;
      if (data.quantity_required !== undefined) updateData.quantityRequired = data.quantity_required;
      if (data.required_by !== undefined) updateData.requiredBy = data.required_by;
      if (data.priority !== undefined) updateData.priority = data.priority;
      if (data.location !== undefined) updateData.location = data.location;

      // Conditional update keyed on id + owning organization + editable status
      // so a concurrent status change cannot be overwritten.
      const mutated = await tx.requirement.updateMany({
        where: {
          id: requirementId,
          organizationId,
          status: { in: [...EDITABLE_REQUIREMENT_STATUSES] },
        },
        data: updateData,
      });
      if (mutated.count !== 1) {
        throw new AppError(409, 'CONFLICT', 'Requirement is not editable in its current status');
      }

      const updated = await tx.requirement.findUnique({ where: { id: requirementId } });
      if (!updated) {
        throw new AppError(409, 'CONFLICT', 'Requirement was modified concurrently');
      }

      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'REQUIREMENT_UPDATED',
          entityType: 'Requirement',
          entityId: updated.id,
          oldValue: requirementAuditSnapshot(existing),
          newValue: requirementAuditSnapshot(updated),
        },
        tx,
      );

      // REQ-06: authoritative UPDATE history record for the post-update state,
      // written in the SAME transaction as the update + REQUIREMENT_UPDATED
      // audit. A history failure rolls back all three.
      await tx.requirementHistory.create({
        data: {
          requirementId: updated.id,
          organizationId: updated.organizationId,
          actorId: caller.id,
          action: 'UPDATE',
          ...requirementHistorySnapshot(updated),
        },
      });
      return updated;
    });
    return { requirement: toRequirementProfile(requirement) };
  } catch (err) {
    throw mapRequirementMutationError(err, 'update');
  }
}

// ---------------------------------------------------------------------------
// REQ-07: owner-organization requirement cancellation (action-style endpoint
// POST /api/requirements/:id/cancel).
//
// Only the authenticated RECIPIENT whose persisted organization owns the
// requirement may cancel it. Ownership and role come ONLY from the session
// caller row; PROVIDER/VOLUNTEER/ADMIN are denied via the route guard and the
// service re-check. The target status is fixed server-side (never client
// supplied) and the REQ-04 authoritative guard `canRequirementTransition` is the
// single source of truth for validity (no second transition matrix). The
// conditional update is guarded by id + organizationId + the statuses leading
// to CANCELLED (derived from that same map) and must affect exactly one row.
//
// The cancellation and its authoritative RequirementHistory CANCEL record commit
// in the SAME transaction; a history failure rolls the cancellation back. No
// allocation/fulfillment (D-06) and no expiry automation (D-10); quantity is
// never mutated. No new AuditLog action is invented (none is authoritative for
// requirement cancellation).

export interface CancelRequirementResult {
  requirement: RequirementProfile;
}

export async function cancelRequirement(
  requirementId: string,
  userId: string
): Promise<CancelRequirementResult> {
  if (typeof requirementId !== 'string' || requirementId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'requirementId', message: 'Requirement id is required' },
    ]);
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  const client: PrismaClient = getPrisma();

  let caller: RecipientWithOrg | null;
  try {
    caller = (await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true, verificationStatus: true } },
      },
    })) as RecipientWithOrg | null;
  } catch (err) {
    throw mapRequirementMutationError(err, 'cancel');
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Belt-and-suspenders behind the route's requireRole('RECIPIENT').
  if (caller.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can cancel requirements');
  }
  if (!caller.organization) {
    throw new AppError(403, 'FORBIDDEN', 'Organization required');
  }
  const organizationId = caller.organization.id;
  const actorId = caller.id;

  try {
    const requirement = await client.$transaction(async (tx) => {
      const existing = await tx.requirement.findUnique({ where: { id: requirementId } });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Requirement not found');
      }
      // Ownership: only the persisted owning organization may cancel.
      if (existing.organizationId !== organizationId) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized for this requirement');
      }
      // REQ-04 authoritative lifecycle guard (do not add a second matrix).
      if (!canRequirementTransition(existing.status, 'CANCELLED')) {
        throw new AppError(409, 'CONFLICT', 'Requirement cannot be cancelled in its current status');
      }

      // Conditional update derived from the same authoritative map so a
      // concurrent status change cannot be overwritten.
      const cancelledStatuses = requirementStatusesLeadingTo('CANCELLED');
      const mutated = await tx.requirement.updateMany({
        where: {
          id: requirementId,
          organizationId,
          status: { in: cancelledStatuses },
        },
        data: { status: 'CANCELLED' },
      });
      if (mutated.count !== 1) {
        throw new AppError(409, 'CONFLICT', 'Requirement cannot be cancelled in its current status');
      }

      const cancelled = await tx.requirement.findUnique({ where: { id: requirementId } });
      if (!cancelled) {
        throw new AppError(409, 'CONFLICT', 'Requirement was modified concurrently');
      }

      // Authoritative domain-history CANCEL record, same transaction.
      await tx.requirementHistory.create({
        data: {
          requirementId: cancelled.id,
          organizationId: cancelled.organizationId,
          actorId,
          action: 'CANCEL',
          ...requirementHistorySnapshot(cancelled),
        },
      });
      return cancelled;
    });
    return { requirement: toRequirementProfile(requirement) };
  } catch (err) {
    throw mapRequirementMutationError(err, 'cancel');
  }
}

// ---------------------------------------------------------------------------
// REQ-05: requirement browsing (read-only).
//
// Visibility (authoritative REQ-05 line): ADMIN → all requirements;
// RECIPIENT → requirements owned by the session recipient's organization OR
// any OPEN requirement. PROVIDER and VOLUNTEER have no requirement browse
// capability (403). Caller identity/role/organization come ONLY from the
// authenticated session user row; query/body identity parameters cannot
// influence visibility.
//
// Supported filters: `food_category` (exact, validated against the active
// Category set per ADR-007 / REQ-03), `priority` (Priority enum) and `status`
// (RequirementStatus enum). Every filter is ANDed with the visibility
// predicate, so a RECIPIENT cannot use `status` to escape own+OPEN.
//
// Location/radius (`radiusKm`) is DEFERRED under the unresolved D-07 decision
// (same boundary recorded for DON-07): `Requirement.location` is a String
// address and the project has NO approved spatial/geocoding architecture. A
// supplied `radiusKm` is rejected with 400 VALIDATION_ERROR, never silently
// ignored. No geocoding/PostGIS/raw SQL/new schema/dependency is introduced.
//
// Pure read: an explicit safe scalar projection, `count` + paged `findMany`
// share the SAME effective `where`, pagination is applied after filtering and
// ordering is `createdAt DESC, id DESC` (deterministic). No mutation, status
// transition, audit, notification or expiry is performed.

export const requirementListingFilterSchema = z
  .object({
    food_category: z.string().trim().min(1, 'food_category must be non-empty').optional(),
    priority: z
      .nativeEnum(Priority, { errorMap: () => ({ message: 'priority must be a valid Priority' }) })
      .optional(),
    status: z
      .nativeEnum(RequirementStatus, {
        errorMap: () => ({ message: 'status must be a valid RequirementStatus' }),
      })
      .optional(),
  })
  // page/limit and client-supplied identity fields are ignored, not rejected
  // (DON-06 convention), except the explicitly unsupported radiusKm.
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.radiusKm !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['radiusKm'],
        message: 'radiusKm is not supported (location/radius filtering is deferred)',
      });
    }
  });

type RequirementListingFilters = z.infer<typeof requirementListingFilterSchema>;

type BrowsingCaller = Pick<User, 'id' | 'role' | 'status'> & {
  organization: { id: string } | null;
};

// Explicit safe scalar projection for the listing (no relations; mirrors the
// REQ-01/REQ-02 `RequirementProfile` surface).
export const REQUIREMENT_LIST_SELECT = {
  id: true,
  organizationId: true,
  foodCategory: true,
  foodType: true,
  quantityRequired: true,
  quantityFulfilled: true,
  requiredBy: true,
  priority: true,
  location: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

function mapRequirementReadError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Requirement not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'REQUIREMENT_READ_FAILED', 'Failed to read requirements');
}

// Visibility and filters are composed as DATABASE predicates. Role visibility
// is an `OR` (recipient own-org OR OPEN); filters are ANDed on top so they can
// only narrow, never broaden.
function buildRequirementListingWhere(
  caller: BrowsingCaller,
  filters: RequirementListingFilters
): Record<string, unknown> {
  const where: {
    OR?: Array<Record<string, unknown>>;
    AND?: Array<Record<string, unknown>>;
  } = {};

  if (caller.role === 'RECIPIENT') {
    where.OR = caller.organization
      ? [{ organizationId: caller.organization.id }, { status: 'OPEN' }]
      : [{ status: 'OPEN' }];
  }

  const and: Array<Record<string, unknown>> = [];
  if (filters.food_category !== undefined) {
    and.push({ foodCategory: filters.food_category });
  }
  if (filters.priority !== undefined) {
    and.push({ priority: filters.priority });
  }
  if (filters.status !== undefined) {
    and.push({ status: filters.status });
  }
  if (and.length > 0) {
    where.AND = and;
  }
  return where;
}

export async function listRequirements(
  userId: string,
  query: Record<string, unknown>
): Promise<PaginationResult<RequirementProfile>> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  // Validate filter input BEFORE any DB work (fail fast, zero queries on
  // malformed input). radiusKm is explicitly rejected, never ignored.
  const parsedFilters = requirementListingFilterSchema.safeParse(query ?? {});
  if (!parsedFilters.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Validation failed',
      formatZodError(parsedFilters.error)
    );
  }
  const filters = parsedFilters.data;
  const params = parsePagination(query ?? {});
  const client: PrismaClient = getPrisma();

  let caller: BrowsingCaller | null;
  try {
    caller = (await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true } },
      },
    })) as BrowsingCaller | null;
  } catch (err) {
    throw mapRequirementReadError(err);
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Only ADMIN (all) and RECIPIENT (own+OPEN) can browse; PROVIDER/VOLUNTEER
  // and any unknown role are denied rather than silently unrestricted.
  if (caller.role !== 'ADMIN' && caller.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Not authorized to browse requirements');
  }

  // A supplied food_category must resolve to the active Category set
  // (ADR-007/REQ-03 shared validation); never auto-created, never a FK.
  if (filters.food_category !== undefined) {
    try {
      await assertCategoryActive(client, filters.food_category, 'food_category');
    } catch (err) {
      throw mapRequirementReadError(err);
    }
  }

  const where = buildRequirementListingWhere(caller, filters);

  try {
    const [rows, total] = await client.$transaction([
      client.requirement.findMany({
        where,
        select: REQUIREMENT_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: params.offset,
        take: params.limit,
      }),
      client.requirement.count({ where }),
    ]);
    return paginate(rows.map(toRequirementProfile), total, params);
  } catch (err) {
    throw mapRequirementReadError(err);
  }
}

// ---------------------------------------------------------------------------
// REQ-06: requirement history (read-only).
//
// Authoritative source = the dedicated immutable `RequirementHistory` model
// (NOT `AuditLog`). CREATE/UPDATE rows are written atomically by REQ-01/REQ-02;
// existing AuditLog behavior is unchanged and no history is reconstructed or
// fabricated (no retroactive rows for pre-feature requirements).
//
// Visibility (session-authorized): RECIPIENT → rows whose persisted
// `organizationId` equals the session caller's persisted organization;
// ADMIN → all organizations; PROVIDER/VOLUNTEER → 403. Identity/organization
// come ONLY from the authenticated session user row; query/body parameters can
// never influence scope. Deterministic ordering `timestamp DESC, id DESC`;
// existing pagination; explicit safe projection. Matched-donation linkage is
// DEFERRED to Phase 8 MATCH-* / D-06 — no Match lookup, no fabricated linkage.
// Pure read: no writes/status mutation/audit/notification/expiry.

export interface RequirementHistoryItem {
  id: string;
  requirement_id: string;
  organization_id: string;
  actor_id: string | null;
  action: RequirementHistoryAction;
  timestamp: Date;
  food_category: string;
  food_type: string;
  quantity_required: number;
  quantity_fulfilled: number;
  required_by: Date;
  priority: Priority;
  location: string;
  status: RequirementStatus;
}

// Explicit safe scalar projection (no relations, no sensitive fields).
export const REQUIREMENT_HISTORY_SELECT = {
  id: true,
  requirementId: true,
  organizationId: true,
  actorId: true,
  action: true,
  timestamp: true,
  foodCategory: true,
  foodType: true,
  quantityRequired: true,
  quantityFulfilled: true,
  requiredBy: true,
  priority: true,
  location: true,
  status: true,
} as const;

interface RequirementHistoryRow {
  id: string;
  requirementId: string;
  organizationId: string;
  actorId: string | null;
  action: RequirementHistoryAction;
  timestamp: Date;
  foodCategory: string;
  foodType: string;
  quantityRequired: number;
  quantityFulfilled: number;
  requiredBy: Date;
  priority: Priority;
  location: string;
  status: RequirementStatus;
}

function toRequirementHistoryItem(row: RequirementHistoryRow): RequirementHistoryItem {
  return {
    id: row.id,
    requirement_id: row.requirementId,
    organization_id: row.organizationId,
    actor_id: row.actorId,
    action: row.action,
    timestamp: row.timestamp,
    food_category: row.foodCategory,
    food_type: row.foodType,
    quantity_required: row.quantityRequired,
    quantity_fulfilled: row.quantityFulfilled,
    required_by: row.requiredBy,
    priority: row.priority,
    location: row.location,
    status: row.status,
  };
}

export async function getRequirementHistory(
  userId: string,
  query: Record<string, unknown>
): Promise<PaginationResult<RequirementHistoryItem>> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  // Only the existing pagination convention is consumed; any client-supplied
  // identity/organization parameter is ignored and can never alter scope.
  const params = parsePagination(query ?? {});
  const client: PrismaClient = getPrisma();

  let caller: BrowsingCaller | null;
  try {
    caller = (await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true } },
      },
    })) as BrowsingCaller | null;
  } catch (err) {
    throw mapRequirementReadError(err);
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  if (caller.role !== 'ADMIN' && caller.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Not authorized to view requirement history');
  }

  // Scoping comes ONLY from the session caller's persisted organization.
  let where: Record<string, unknown>;
  if (caller.role === 'RECIPIENT') {
    if (!caller.organization) {
      // A recipient with no organization owns no requirement history.
      return paginate([], 0, params);
    }
    where = { organizationId: caller.organization.id };
  } else {
    where = {};
  }

  try {
    const [rows, total] = await client.$transaction([
      client.requirementHistory.findMany({
        where,
        select: REQUIREMENT_HISTORY_SELECT,
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: params.offset,
        take: params.limit,
      }),
      client.requirementHistory.count({ where }),
    ]);
    return paginate(rows.map(toRequirementHistoryItem), total, params);
  } catch (err) {
    throw mapRequirementReadError(err);
  }
}
