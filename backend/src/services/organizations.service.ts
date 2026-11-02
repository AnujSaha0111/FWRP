import { z } from 'zod';
import type { NotificationType, Organization, PrismaClient, User } from '@prisma/client';
import { VerificationStatus } from '@prisma/client';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { persistAuditEvent } from './audit.service';
import { refreshMatchesSafely } from './matching.service';
import { createNotification } from './notification.service';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';

// AUTH-09: organization self-service for the caller's own organization.
// The organization id ALWAYS comes from the session user row, never from
// path/body input, so a caller cannot read or mutate another org's record.
// Member-editable fields are name/address/contactInformation only: type,
// coordinates, and verificationStatus stay under Phase 5/D-07/Phase 16
// workflows, and the strict schema below rejects them (no privilege change).
// Joining an existing organization by id is NOT offered here: unsponsored
// joins would enable exactly the org spoofing this task forbids; membership
// changes belong to the Phase 5 verification workflow.

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
const MAX_CONTACT_LENGTH = 500;

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1, 'Name must be non-empty').max(MAX_NAME_LENGTH).optional(),
    address: z.string().trim().min(1, 'Address must be non-empty').max(MAX_ADDRESS_LENGTH).optional(),
    contactInformation: z
      .string()
      .trim()
      .min(1, 'Contact information must be non-empty')
      .max(MAX_CONTACT_LENGTH)
      .optional(),
    // Location correction (moved premises, wrong pin). Always as a pair.
    latitude: z.number({ invalid_type_error: 'latitude must be a number' }).finite().min(-90).max(90).optional(),
    longitude: z.number({ invalid_type_error: 'longitude must be a number' }).finite().min(-180).max(180).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.address !== undefined ||
      value.contactInformation !== undefined ||
      value.latitude !== undefined ||
      value.longitude !== undefined,
    { message: 'At least one of name, address, contactInformation, latitude/longitude is required', path: ['name'] },
  )
  .superRefine((value, ctx) => {
    if ((value.latitude === undefined) !== (value.longitude === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.latitude === undefined ? 'latitude' : 'longitude'],
        message: 'latitude and longitude must be provided together',
      });
    }
    if (value.latitude === 0 && value.longitude === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latitude'],
        message: 'Coordinates 0, 0 are not a real organization location',
      });
    }
  });

export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;

// The Organization model holds no secrets; all scalar fields are safe to return.
export type OrganizationProfile = Pick<
  Organization,
  | 'id'
  | 'name'
  | 'type'
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'contactInformation'
  | 'verificationStatus'
  | 'createdAt'
  | 'updatedAt'
>;

function toOrganizationProfile(org: Organization): OrganizationProfile {
  const {
    id,
    name,
    type,
    address,
    latitude,
    longitude,
    contactInformation,
    verificationStatus,
    createdAt,
    updatedAt,
  } = org;
  return {
    id,
    name,
    type,
    address,
    latitude,
    longitude,
    contactInformation,
    verificationStatus,
    createdAt,
    updatedAt,
  };
}

type UserWithOrg = User & { organization: Organization | null };

function mapOrganizationError(err: unknown, operation: 'read' | 'update'): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Organization not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(
    500,
    operation === 'read' ? 'ORGANIZATION_READ_FAILED' : 'ORGANIZATION_UPDATE_FAILED',
    operation === 'read' ? 'Failed to read organization' : 'Failed to update organization',
  );
}

function requireActiveMember(user: UserWithOrg | null): asserts user is UserWithOrg {
  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
}

function requireOwnOrganization(user: UserWithOrg): Organization {
  if (!user.organizationId || !user.organization) {
    throw new AppError(404, 'NOT_FOUND', 'Organization not found');
  }
  return user.organization;
}

async function loadCaller(client: PrismaClient, userId: string): Promise<UserWithOrg> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  let user: UserWithOrg | null;
  try {
    user = await client.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });
  } catch (err) {
    throw mapOrganizationError(err, 'read');
  }
  requireActiveMember(user);
  return user;
}

// Owner and organization both resolve from the session identity.
export async function getMyOrganization(userId: string): Promise<OrganizationProfile> {
  const client: PrismaClient = getPrisma();
  const user = await loadCaller(client, userId);
  return toOrganizationProfile(requireOwnOrganization(user));
}

export async function updateMyOrganization(
  userId: string,
  input: UpdateOrganizationInput,
): Promise<OrganizationProfile> {
  const parsed = updateOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const client: PrismaClient = getPrisma();
  const user = await loadCaller(client, userId).catch((err: unknown) => {
    throw mapOrganizationError(err, 'update');
  });
  const existing = requireOwnOrganization(user);

  const data: { name?: string; address?: string; contactInformation?: string; latitude?: number; longitude?: number } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.address !== undefined) data.address = parsed.data.address;
  if (parsed.data.contactInformation !== undefined) data.contactInformation = parsed.data.contactInformation;
  if (parsed.data.latitude !== undefined && parsed.data.longitude !== undefined) {
    data.latitude = parsed.data.latitude;
    data.longitude = parsed.data.longitude;
  }
  const moved =
    data.latitude !== undefined && (data.latitude !== existing.latitude || data.longitude !== existing.longitude);

  try {
    const profile = await client.$transaction(async (tx) => {
      const organization = await tx.organization.update({
        where: { id: existing.id },
        data,
      });
      await persistAuditEvent(
        {
          actorId: userId,
          action: 'ORGANIZATION_UPDATE',
          entityType: 'Organization',
          entityId: existing.id,
          oldValue: {
            id: existing.id,
            name: existing.name,
            address: existing.address,
            ...(moved ? { latitude: existing.latitude, longitude: existing.longitude } : {}),
          },
          newValue: {
            id: organization.id,
            name: organization.name,
            address: organization.address,
            ...(moved ? { latitude: organization.latitude, longitude: organization.longitude } : {}),
          },
        },
        tx,
      );
      return toOrganizationProfile(organization);
    });
    // MATCH-06: distances changed, so re-score this organization's matches (best-effort).
    if (moved) await refreshOrganizationMatches(client, existing.id);
    return profile;
  } catch (err) {
    throw mapOrganizationError(err, 'update');
  }
}

async function refreshOrganizationMatches(client: PrismaClient, organizationId: string): Promise<void> {
  try {
    const [requirements, donations] = await Promise.all([
      client.requirement.findMany({
        where: { organizationId, status: { in: ['OPEN', 'PARTIALLY_FULFILLED'] } },
        select: { id: true },
      }),
      // Donations without their own pickup coordinates use the provider organization location.
      client.donation.findMany({
        where: { provider: { organizationId }, status: { in: ['AVAILABLE', 'MATCHED'] }, pickupLatitude: null },
        select: { id: true },
      }),
    ]);
    for (const r of requirements) await refreshMatchesSafely('requirement', r.id);
    for (const d of donations) await refreshMatchesSafely('donation', d.id);
  } catch {
    // Never fail the profile update; the scheduled refresh (MATCH-11) catches up.
  }
}

export interface OrganizationsService {
  getMyOrganization(userId: string): Promise<OrganizationProfile>;
  updateMyOrganization(userId: string, input: UpdateOrganizationInput): Promise<OrganizationProfile>;
  reviewOrganization(organizationId: string, adminId: string, hooks?: VerificationHooks): Promise<OrganizationProfile>;
  verifyOrganization(
    organizationId: string,
    adminId: string,
    input: VerifyOrganizationInput,
    hooks?: VerificationHooks,
  ): Promise<OrganizationProfile>;
  listOrganizations(
    filter: ListOrganizationsFilter,
    paging?: ListOrganizationsPaging,
  ): Promise<PaginationResult<OrganizationProfile>>;
}

export const organizationsService: OrganizationsService = {
  getMyOrganization: (userId) => getMyOrganization(userId),
  updateMyOrganization: (userId, input) => updateMyOrganization(userId, input),
  reviewOrganization: (organizationId, adminId, hooks) => reviewOrganization(organizationId, adminId, hooks),
  verifyOrganization: (organizationId, adminId, input, hooks) =>
    verifyOrganization(organizationId, adminId, input, hooks),
  listOrganizations: (filter, paging) => listOrganizations(filter, paging),
};

// ---------------------------------------------------------------------------
// ORG-01: verification state machine (PRD FR-03). Single source of truth for
// allowed transitions; every admin transition funnels through
// assertVerificationTransition — the requested target is never trusted.
// Terminal VERIFIED/REJECTED accept no outgoing transitions: PRD defines no
// reopening, so none is invented here.

export const VERIFICATION_TRANSITIONS: Record<VerificationStatus, VerificationStatus[]> = {
  PENDING: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['VERIFIED', 'REJECTED'],
  VERIFIED: [],
  REJECTED: [],
};

export function assertVerificationTransition(from: VerificationStatus, to: VerificationStatus): void {
  if (!VERIFICATION_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'verificationStatus', message: `Invalid verification transition from ${from} to ${to}` },
    ]);
  }
}

// ---------------------------------------------------------------------------
// ORG-03: verification hooks. The transition core below invokes these inside
// the SAME transaction as the status update, so side effects stay atomic with
// the state change. The interface is deliberately separable: ORG-06 owns the
// final audit contract and may replace defaultAuditTransition without
// touching transition logic; notification fan-out stays behind
// defaultNotifyOwners. No infrastructure is reimplemented — both defaults
// delegate to the established auditService/notificationService APIs.

export interface VerificationTransitionEvent {
  organizationId: string;
  organizationName: string;
  from: VerificationStatus;
  to: VerificationStatus;
  adminId: string;
  reason?: string;
}

// Subset of the Prisma transaction client actually touched by the hooks.
// The real $transaction handle satisfies this structurally.
export type VerificationTransactionClient = Pick<
  PrismaClient,
  'organization' | 'user' | 'auditLog' | 'notification'
>;

export interface VerificationHooks {
  auditTransition?: (
    event: VerificationTransitionEvent,
    tx: VerificationTransactionClient,
  ) => Promise<void>;
  notifyOwners?: (
    event: VerificationTransitionEvent,
    tx: VerificationTransactionClient,
  ) => Promise<void>;
}

function auditActionFor(target: VerificationStatus): string {
  if (target === 'VERIFIED') return 'ORGANIZATION_VERIFIED';
  if (target === 'REJECTED') return 'ORGANIZATION_REJECTED';
  return 'ORGANIZATION_UNDER_REVIEW';
}

async function defaultAuditTransition(
  event: VerificationTransitionEvent,
  tx: VerificationTransactionClient,
): Promise<void> {
  await persistAuditEvent(
    {
      actorId: event.adminId,
      action: auditActionFor(event.to),
      entityType: 'Organization',
      entityId: event.organizationId,
      oldValue: { verificationStatus: event.from },
      newValue: {
        verificationStatus: event.to,
        ...(event.reason !== undefined && event.reason !== '' ? { reason: event.reason } : {}),
      },
    },
    tx,
  );
}

function verificationNotice(event: VerificationTransitionEvent): { title: string; message: string } {
  if (event.to === 'VERIFIED') {
    return {
      title: 'Organization verified',
      message: `${event.organizationName} has been verified.`,
    };
  }
  return {
    title: 'Organization not verified',
    message: `${event.organizationName} was not verified. Reason: ${event.reason ?? ''}`,
  };
}

async function defaultNotifyOwners(
  event: VerificationTransitionEvent,
  tx: VerificationTransactionClient,
): Promise<void> {
  // Owner notices go out on terminal outcomes only (ORG-03 scope). UNDER_REVIEW
  // transitions invoke no notification behavior.
  if (event.to !== 'VERIFIED' && event.to !== 'REJECTED') return;
  const members = await tx.user.findMany({
    where: { organizationId: event.organizationId },
    select: { id: true },
  });
  const notice = verificationNotice(event);
  for (const member of members) {
    await createNotification(
      {
        userId: member.id,
        type: event.to === 'VERIFIED' ? 'ORGANIZATION_VERIFIED' : 'ORGANIZATION_REJECTED',
        title: notice.title,
        message: notice.message,
        entityType: 'Organization',
        entityId: event.organizationId,
      },
      tx,
    );
  }
}

export const defaultVerificationHooks: Required<VerificationHooks> = {
  auditTransition: defaultAuditTransition,
  notifyOwners: defaultNotifyOwners,
};

// ORG-02 transition core, extended by ORG-03: pre-read, machine assert, then
// ONE transaction holding the status update plus the hook side effects. Any
// failure propagates out of $transaction, rolling everything back: no partial
// status, no orphan audit rows, no orphan notifications.
async function transitionOrganization(
  organizationId: string,
  adminId: string,
  target: VerificationStatus,
  reason: string | undefined,
  hooks: VerificationHooks = defaultVerificationHooks,
): Promise<Organization> {
  const orgId = requireOrganizationId(organizationId);
  const client: PrismaClient = getPrisma();
  let current: Organization | null;
  try {
    current = await client.organization.findUnique({ where: { id: orgId } });
  } catch (err) {
    throw mapVerificationError(err);
  }
  if (!current) {
    throw new AppError(404, 'NOT_FOUND', 'Organization not found');
  }
  const existing: Organization = current;
  assertVerificationTransition(existing.verificationStatus, target);
  const event: VerificationTransitionEvent = {
    organizationId: orgId,
    organizationName: existing.name,
    from: existing.verificationStatus,
    to: target,
    adminId,
    reason,
  };
  try {
    return await client.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: orgId },
        data: { verificationStatus: target },
      });
      await (hooks.auditTransition ?? defaultVerificationHooks.auditTransition)(event, tx);
      await (hooks.notifyOwners ?? defaultVerificationHooks.notifyOwners)(event, tx);
      return updated;
    });
  } catch (err) {
    throw mapVerificationError(err);
  }
}

// PUT /api/admin/organizations/:id/review — PENDING → UNDER_REVIEW.
export async function reviewOrganization(
  organizationId: string,
  adminId: string,
  hooks?: VerificationHooks,
): Promise<OrganizationProfile> {
  return toOrganizationProfile(await transitionOrganization(organizationId, adminId, 'UNDER_REVIEW', undefined, hooks));
}

// PUT /api/admin/organizations/:id/verify — UNDER_REVIEW → VERIFIED/REJECTED.
// Reason is validated (required on REJECT) and forwarded to the hooks.
export async function verifyOrganization(
  organizationId: string,
  adminId: string,
  input: VerifyOrganizationInput,
  hooks?: VerificationHooks,
): Promise<OrganizationProfile> {
  const parsed = verifyOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const target = parsed.data.action === 'VERIFY' ? 'VERIFIED' : 'REJECTED';
  return toOrganizationProfile(
    await transitionOrganization(organizationId, adminId, target as VerificationStatus, parsed.data.reason, hooks),
  );
}

const MAX_REASON_LENGTH = 1000;

export const verifyOrganizationSchema = z
  .object({
    action: z.enum(['VERIFY', 'REJECT']),
    reason: z.string().trim().max(MAX_REASON_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'REJECT' && (value.reason === undefined || value.reason === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Reason is required when rejecting',
      });
    }
  });

export type VerifyOrganizationInput = z.input<typeof verifyOrganizationSchema>;

export const listOrganizationsQuerySchema = z
  .object({
    status: z.nativeEnum(VerificationStatus).optional(),
  })
  // Passthrough so validateQuery keeps page/limit for parsePagination downstream.
  .passthrough();

export interface ListOrganizationsFilter {
  status?: VerificationStatus;
}

export interface ListOrganizationsPaging {
  page?: string | number;
  limit?: string | number;
}

function requireOrganizationId(organizationId: unknown): string {
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'organizationId', message: 'Organization id is required' },
    ]);
  }
  return organizationId.trim();
}

function mapVerificationError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Organization not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'ORGANIZATION_UPDATE_FAILED', 'Organization verification failed');
}

// GET /api/admin/organizations — optional status filter, paginated newest-first.
export async function listOrganizations(
  filter: ListOrganizationsFilter,
  paging?: ListOrganizationsPaging,
): Promise<PaginationResult<OrganizationProfile>> {
  const params = parsePagination({ page: paging?.page, limit: paging?.limit });
  const client: PrismaClient = getPrisma();
  const where = filter.status ? { verificationStatus: filter.status } : {};
  try {
    const [total, items] = await Promise.all([
      client.organization.count({ where }),
      client.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.offset,
        take: params.limit,
      }),
    ]);
    return paginate(items.map(toOrganizationProfile), total, params);
  } catch (err) {
    if (err instanceof AppError) throw err;
    return Promise.reject(new AppError(500, 'ORGANIZATION_READ_FAILED', 'Failed to read organizations'));
  }
}
