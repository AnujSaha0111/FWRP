import type { Donation, PrismaClient, User } from '@prisma/client';
import { DonationStatus, NotificationType } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { persistAuditEvent } from './audit.service';
import { createNotification } from './notification.service';
import { validateAvailabilityWindow, timeRemainingMs } from '../utils/timeWindow';
import { validateCoordinates } from '../utils/distance';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';
import { canTransition, canAdminOverride, donationStatusesLeadingTo } from '../utils/donationState';
import { strictDateField } from '../utils/validation';

export interface AcceptDonationResult {
  donation: Pick<Donation, 'id' | 'status'>;
}

type RecipientWithOrg = User & {
  organization: { id: string; verificationStatus: string } | null;
};

function mapAcceptanceError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'ACCEPTANCE_FAILED', 'Acceptance failed');
}

export async function acceptDonation(donationId: string, userId: string): Promise<AcceptDonationResult> {
  if (typeof donationId !== 'string' || donationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'donationId', message: 'Donation id is required' },
    ]);
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  let recipient: RecipientWithOrg | null;
  try {
    recipient = (await client.user.findUnique({
      where: { id: userId },
      include: { organization: { select: { id: true, verificationStatus: true } } },
    })) as RecipientWithOrg | null;
  } catch (err) {
    throw mapAcceptanceError(err);
  }
  if (!recipient) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (recipient.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Belt-and-suspenders behind the route's requireRole('RECIPIENT').
  if (recipient.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can accept donations');
  }
  if (!recipient.organization || recipient.organization.verificationStatus !== 'VERIFIED') {
    throw new AppError(403, 'FORBIDDEN', 'Organization is not verified');
  }

  let donation: Donation | null;
  try {
    donation = await client.donation.findUnique({ where: { id: donationId } });
  } catch (err) {
    throw mapAcceptanceError(err);
  }
  if (!donation) {
    throw new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  if (!canTransition(donation.status, 'ACCEPTED')) {
    throw new AppError(409, 'CONFLICT', 'Donation is not available');
  }

  try {
    const updated = await client.donation.update({
      where: { id: donationId },
      data: { status: 'ACCEPTED' },
    });
    return { donation: { id: updated.id, status: updated.status } };
  } catch (err) {
    throw mapAcceptanceError(err);
  }
}

export interface DonationsService {
  acceptDonation(donationId: string, userId: string): Promise<AcceptDonationResult>;
  createDonation(userId: string, input: unknown): Promise<CreateDonationResult>;
  updateDonation(donationId: string, userId: string, input: unknown): Promise<UpdateDonationResult>;
  cancelDonation(donationId: string, userId: string): Promise<CancelDonationResult>;
  overrideDonation(donationId: string, userId: string, input: unknown): Promise<AdminOverrideResult>;
  getDonation(donationId: string, userId: string): Promise<GetDonationResult>;
  listDonations(userId: string, query: Record<string, unknown>): Promise<PaginationResult<DonationListItem>>;
  getDonationHistory(
    userId: string,
    query: Record<string, unknown>
  ): Promise<PaginationResult<DonationHistoryItem>>;
}

export const donationsService: DonationsService = {
  acceptDonation: (donationId, userId) => acceptDonation(donationId, userId),
  createDonation: (userId, input) => createDonation(userId, input),
  updateDonation: (donationId, userId, input) => updateDonation(donationId, userId, input),
  cancelDonation: (donationId, userId) => cancelDonation(donationId, userId),
  overrideDonation: (donationId, userId, input) => overrideDonation(donationId, userId, input),
  getDonation: (donationId, userId) => getDonation(donationId, userId),
  listDonations: (userId, query) => listDonations(userId, query),
  getDonationHistory: (userId, query) => getDonationHistory(userId, query),
};

export interface CreateDonationResult {
  donation: DonationProfile;
}

export interface DonationProfile {
  id: string;
  providerId: string;
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: Date;
  availableUntil: Date;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  storageRequirement: string | null;
  description: string | null;
  status: DonationStatus;
  createdAt: Date;
  updatedAt: Date;
}

const donationDateField = strictDateField;

export const createDonationSchema = z
  .object({
    foodName: z.string().trim().min(1, 'Food name is required').max(500),
    category: z.string().trim().min(1, 'Category is required').max(200),
    foodType: z.string().trim().min(1, 'Food type is required').max(200),
    quantity: z
      .number({ invalid_type_error: 'Quantity must be a number' })
      .positive('Quantity must be greater than 0')
      .finite(),
    unit: z.string().trim().min(1, 'Unit is required').max(100),
    availableFrom: donationDateField('availableFrom'),
    availableUntil: donationDateField('availableUntil'),
    pickupLocation: z.string().trim().min(1, 'Pickup location is required').max(500),
    pickupLatitude: z.number({ invalid_type_error: 'pickupLatitude must be a number' }).finite().optional(),
    pickupLongitude: z.number({ invalid_type_error: 'pickupLongitude must be a number' }).finite().optional(),
    storageRequirement: z.string().trim().max(500).optional(),
    description: z.string().trim().max(10000).optional(),
  })
  .strict();

export type CreateDonationInput = z.infer<typeof createDonationSchema>;

export const updateDonationSchema = createDonationSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one editable field is required',
    path: ['foodName'],
  });

export type UpdateDonationInput = z.infer<typeof updateDonationSchema>;

export interface UpdateDonationResult {
  donation: DonationProfile;
}

export const EDITABLE_DONATION_STATUSES: readonly DonationStatus[] = ['DRAFT', 'AVAILABLE'];

export const CANCELLABLE_DONATION_STATUSES: readonly DonationStatus[] =
  donationStatusesLeadingTo('CANCELLED');

export interface CancelDonationResult {
  donation: DonationProfile;
}

export interface AdminOverrideResult {
  donation: DonationProfile;
}

export const adminOverrideSchema = z
  .object({
    to: z.enum(['CANCELLED', 'AVAILABLE'], {
      errorMap: () => ({ message: "to must be 'CANCELLED' or 'AVAILABLE'" }),
    }),
  })
  .strict();

type CallerUser = Pick<User, 'id' | 'role' | 'status'>;

function mapDonationMutationError(err: unknown, operation: 'create' | 'update' | 'cancel' | 'override'): AppError {
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
  if (operation === 'update') {
    return new AppError(500, 'DONATION_UPDATE_FAILED', 'Failed to update donation');
  }
  if (operation === 'cancel') {
    return new AppError(500, 'DONATION_CANCEL_FAILED', 'Failed to cancel donation');
  }
  if (operation === 'override') {
    return new AppError(500, 'DONATION_OVERRIDE_FAILED', 'Failed to override donation');
  }
  return new AppError(500, 'DONATION_CREATE_FAILED', 'Failed to create donation');
}

// Shared DON-01/DON-02 validation assertions. Used by BOTH create and update
// so the two paths cannot drift into subtly different contracts.
function assertQuantityPositive(quantity: number): void {
  if (!(quantity > 0)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'quantity', message: 'Quantity must be greater than 0' },
    ]);
  }
}

// FR-16 invariants via BE-09 utils: until > from, until > now (UTC).
function assertAvailabilityWindow(from: Date, until: Date): void {
  const window = validateAvailabilityWindow(from, until);
  if (!window.valid) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'availableUntil', message: window.error ?? 'Invalid availability window' },
    ]);
  }
}

// Direct coordinates (D-07 unresolved: no geocoding); DB-12 CHECK ranges are
// enforced here since DB-14 live CHECKs are not yet applied. Coordinates are a
// pair: both supplied or neither.
function assertCoordinateContract(latitude?: number, longitude?: number): void {
  const hasLat = latitude !== undefined;
  const hasLng = longitude !== undefined;
  if (hasLat !== hasLng) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'pickupLocation', message: 'latitude and longitude must be provided together' },
    ]);
  }
  if (hasLat && hasLng) {
    const coords = validateCoordinates(latitude as number, longitude as number);
    if (!coords.valid) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
        { field: 'pickupLocation', message: coords.error ?? 'Invalid coordinates' },
      ]);
    }
  }
}

function toDonationProfile(donation: Donation): DonationProfile {
  return {
    id: donation.id,
    providerId: donation.providerId,
    foodName: donation.foodName,
    category: donation.category,
    foodType: donation.foodType,
    quantity: donation.quantity,
    unit: donation.unit,
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
    pickupLocation: donation.pickupLocation,
    pickupLatitude: donation.pickupLatitude,
    pickupLongitude: donation.pickupLongitude,
    storageRequirement: donation.storageRequirement,
    description: donation.description,
    status: donation.status,
    createdAt: donation.createdAt,
    updatedAt: donation.updatedAt,
  };
}

// Defense-in-depth behind the route's authenticate + requireRole('PROVIDER').
// The caller is re-loaded from the database (never token-trusted for state).
async function loadProviderCaller(
  client: PrismaClient,
  userId: string,
  operation: 'create' | 'update' | 'cancel'
): Promise<CallerUser> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  let user: CallerUser | null = null;
  try {
    user = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
  } catch (err) {
    throw mapDonationMutationError(err, operation);
  }
  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  if (user.role !== 'PROVIDER') {
    throw new AppError(403, 'FORBIDDEN', 'Only providers can manage donations');
  }
  return user;
}

// DON-12: defense-in-depth behind the route's authenticate + requireRole('ADMIN').
// The caller is re-loaded from the DB (never token-trusted for state/role).
async function loadAdminCaller(client: PrismaClient, userId: string): Promise<CallerUser> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  let user: CallerUser | null = null;
  try {
    user = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
  } catch (err) {
    throw mapDonationMutationError(err, 'override');
  }
  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  if (user.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Only administrators can override donations');
  }
  return user;
}

async function assertCategoryActive(
  client: Pick<PrismaClient, 'category'>,
  name: string
): Promise<void> {
  let active: { id: string } | null = null;
  try {
    active = await client.category.findFirst({
      where: { name, isActive: true },
      select: { id: true },
    });
  } catch (err) {
    throw mapDonationMutationError(err, 'create');
  }
  if (!active) {
    // ADR 007: an unknown/inactive category is a validation failure, and the
    // active category set is administrator-configurable — never auto-create.
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'category', message: 'Category must be one of the active categories' },
    ]);
  }
}

export async function createDonation(userId: string, input: unknown): Promise<CreateDonationResult> {
  const parsed = createDonationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const data = parsed.data;

  assertQuantityPositive(data.quantity);
  assertAvailabilityWindow(data.availableFrom, data.availableUntil);
  assertCoordinateContract(data.pickupLatitude, data.pickupLongitude);

  const client: PrismaClient = getPrisma();
  const caller = await loadProviderCaller(client, userId, 'create');

  try {
    const donation: Donation = await client.$transaction(async (tx) => {
      await assertCategoryActive(tx, data.category);
      const created = await tx.donation.create({
        data: {
          providerId: caller.id,
          foodName: data.foodName,
          category: data.category,
          foodType: data.foodType,
          quantity: data.quantity,
          unit: data.unit,
          availableFrom: data.availableFrom,
          availableUntil: data.availableUntil,
          pickupLocation: data.pickupLocation,
          pickupLatitude: data.pickupLatitude ?? null,
          pickupLongitude: data.pickupLongitude ?? null,
          storageRequirement: data.storageRequirement ?? null,
          description: data.description ?? null,
          status: 'AVAILABLE',
        },
      });
      // Audit + notification participate in the SAME transaction as the
      // donation insert (rejected/failed creation leaves zero side effects).
      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'DONATION_CREATED',
          entityType: 'Donation',
          entityId: created.id,
          oldValue: null,
          newValue: {
            id: created.id,
            foodName: created.foodName,
            category: created.category,
            quantity: created.quantity,
            unit: created.unit,
            status: created.status,
          },
        },
        tx,
      );
      await createNotification(
        {
          userId: caller.id,
          type: NotificationType.DONATION_CREATED,
          title: 'Donation created',
          message: `Your donation "${created.foodName}" is now available.`,
          entityType: 'Donation',
          entityId: created.id,
        },
        tx,
      );
      return created;
    });
    return { donation: toDonationProfile(donation) };
  } catch (err) {
    throw mapDonationMutationError(err, 'create');
  }
}

// ---------------------------------------------------------------------------
// DON-03: provider-owned donation editing (PRD UC-04, FR-04..FR-06).
//
// - `donationId` comes from the path; the provider identity comes ONLY from
//   the authenticated session user row (never from the body).
// - Ownership: the persisted `providerId` must equal the session provider.
// - Status gate: only DRAFT/AVAILABLE may be edited; every other status 409.
// - Partial PUT (project PUT convention): the request reuses the create
//   schema via `.partial()`, so every editable field is re-validated with the
//   exact DON-01/DON-02 contract (strict dates, quantity > 0, active
//   Category, effective availability window, coordinate pair/ranges).
// - Atomicity/races: the write is a conditional `updateMany` guarded by
//   id + providerId + editable status, so a donation that transitioned to a
//   non-editable status concurrently cannot be mutated (no SERIALIZABLE, no
//   invented version field — DB-13 READ COMMITTED guidance).
// - Version: the Donation model has no dedicated `version` column and no such
//   field exists in PRD/ADR/schema, so none is invented. The existing
//   server-managed `updatedAt` (`@updatedAt`) is the version marker; it is
//   bumped by the successful update and captured as old/new in the audit.
// - Audit: exactly one DONATION_UPDATED event (business update + audit in the
//   SAME transaction handle; a failed audit rolls the edit back). DON-03
//   requires an audit change only — no notification is emitted.
export async function updateDonation(
  donationId: string,
  userId: string,
  input: unknown
): Promise<UpdateDonationResult> {
  if (typeof donationId !== 'string' || donationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'donationId', message: 'Donation id is required' },
    ]);
  }
  const parsed = updateDonationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const data = parsed.data;

  const client: PrismaClient = getPrisma();
  const caller = await loadProviderCaller(client, userId, 'update');

  try {
    const donation: Donation = await client.$transaction(async (tx) => {
      const existing = await tx.donation.findUnique({ where: { id: donationId } });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Donation not found');
      }
      if (existing.providerId !== caller.id) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized for this donation');
      }
      if (!EDITABLE_DONATION_STATUSES.includes(existing.status)) {
        throw new AppError(409, 'CONFLICT', 'Donation is not editable in its current status');
      }

      // Re-validate against the EFFECTIVE state: a partial edit that changes
      // only part of the window/coordinates must still satisfy the invariant.
      const effectiveFrom = data.availableFrom ?? existing.availableFrom;
      const effectiveUntil = data.availableUntil ?? existing.availableUntil;
      assertAvailabilityWindow(effectiveFrom, effectiveUntil);
      assertCoordinateContract(data.pickupLatitude, data.pickupLongitude);

      // Category is only checked when the edit actually changes it.
      if (data.category !== undefined) {
        await assertCategoryActive(tx, data.category);
      }

      const updateData: {
        foodName?: string;
        category?: string;
        foodType?: string;
        quantity?: number;
        unit?: string;
        availableFrom?: Date;
        availableUntil?: Date;
        pickupLocation?: string;
        pickupLatitude?: number;
        pickupLongitude?: number;
        storageRequirement?: string;
        description?: string;
      } = {};
      if (data.foodName !== undefined) updateData.foodName = data.foodName;
      if (data.category !== undefined) updateData.category = data.category;
      if (data.foodType !== undefined) updateData.foodType = data.foodType;
      if (data.quantity !== undefined) updateData.quantity = data.quantity;
      if (data.unit !== undefined) updateData.unit = data.unit;
      if (data.availableFrom !== undefined) updateData.availableFrom = data.availableFrom;
      if (data.availableUntil !== undefined) updateData.availableUntil = data.availableUntil;
      if (data.pickupLocation !== undefined) updateData.pickupLocation = data.pickupLocation;
      if (data.pickupLatitude !== undefined && data.pickupLongitude !== undefined) {
        updateData.pickupLatitude = data.pickupLatitude;
        updateData.pickupLongitude = data.pickupLongitude;
      }
      if (data.storageRequirement !== undefined) updateData.storageRequirement = data.storageRequirement;
      if (data.description !== undefined) updateData.description = data.description;

      // Atomic conditional update: guarded by id + providerId + editable
      // status so a concurrent ACCEPT/CANCEL/expiry (or a concurrent edit that
      // leaves the row in a non-editable status) cannot be overwritten.
      const mutated = await tx.donation.updateMany({
        where: {
          id: donationId,
          providerId: caller.id,
          status: { in: [...EDITABLE_DONATION_STATUSES] },
        },
        data: updateData,
      });
      if (mutated.count !== 1) {
        throw new AppError(409, 'CONFLICT', 'Donation is not editable in its current status');
      }

      const updated = await tx.donation.findUnique({ where: { id: donationId } });
      if (!updated) {
        throw new AppError(409, 'CONFLICT', 'Donation was modified concurrently');
      }

      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'DONATION_UPDATED',
          entityType: 'Donation',
          entityId: updated.id,
          oldValue: donationAuditSnapshot(existing),
          newValue: donationAuditSnapshot(updated),
        },
        tx,
      );
      return updated;
    });
    return { donation: toDonationProfile(donation) };
  } catch (err) {
    throw mapDonationMutationError(err, 'update');
  }
}

// Editable donation state captured for audit old/new values. `updatedAt` (the
// server-managed version marker) is included so the version bump is auditable.
function donationAuditSnapshot(donation: Donation) {
  return {
    foodName: donation.foodName,
    category: donation.category,
    foodType: donation.foodType,
    quantity: donation.quantity,
    unit: donation.unit,
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
    pickupLocation: donation.pickupLocation,
    pickupLatitude: donation.pickupLatitude,
    pickupLongitude: donation.pickupLongitude,
    storageRequirement: donation.storageRequirement,
    description: donation.description,
    status: donation.status,
    updatedAt: donation.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// DON-04: provider-owned donation cancellation.
//
// - `donationId` comes from the path; the provider identity comes ONLY from the
//   authenticated session user row (never from the body — there is no body).
// - Ownership: the persisted `providerId` must equal the session provider
//   (404 unknown, 403 cross-provider).
// - Status gate: only the explicitly enumerated pre-ACCEPTED cancellations
//   `AVAILABLE → CANCELLED` and `MATCHED → CANCELLED` are allowed (PRD §33 /
//   docs/database.md §11.2). Every other status — including DRAFT (not an
//   enumerated transition), ACCEPTED and later, EXPIRED and CANCELLED — is
//   409. Post-ACCEPTED admin override is DON-12 scope and is not implemented.
// - Concurrency: conditional `updateMany` guarded by id + providerId +
//   cancellable status (DB-13 READ COMMITTED pattern; no SERIALIZABLE, no
//   version column/ETag/revision table).
// - Audit: exactly one DONATION_CANCELLED event in the SAME transaction as the
//   status change; audit failure rolls the cancellation back. No notification
//   is emitted: DON-04 requires "audit cancellation" only, and no existing
//   NotificationType represents donation cancellation (no type is invented).
export async function cancelDonation(
  donationId: string,
  userId: string
): Promise<CancelDonationResult> {
  if (typeof donationId !== 'string' || donationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'donationId', message: 'Donation id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  const caller = await loadProviderCaller(client, userId, 'cancel');

  try {
    const donation: Donation = await client.$transaction(async (tx) => {
      const existing = await tx.donation.findUnique({ where: { id: donationId } });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Donation not found');
      }
      if (existing.providerId !== caller.id) {
        throw new AppError(403, 'FORBIDDEN', 'Not authorized for this donation');
      }
      if (!canTransition(existing.status, 'CANCELLED')) {
        throw new AppError(409, 'CONFLICT', 'Donation cannot be cancelled in its current status');
      }

      // Atomic conditional transition: a concurrent ACCEPT/EXPIRY (or any
      // other status change) cannot be overwritten.
      const mutated = await tx.donation.updateMany({
        where: {
          id: donationId,
          providerId: caller.id,
          status: { in: [...CANCELLABLE_DONATION_STATUSES] },
        },
        data: { status: 'CANCELLED' },
      });
      if (mutated.count !== 1) {
        throw new AppError(409, 'CONFLICT', 'Donation cannot be cancelled in its current status');
      }

      const updated = await tx.donation.findUnique({ where: { id: donationId } });
      if (!updated) {
        throw new AppError(409, 'CONFLICT', 'Donation was modified concurrently');
      }

      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'DONATION_CANCELLED',
          entityType: 'Donation',
          entityId: updated.id,
          oldValue: donationAuditSnapshot(existing),
          newValue: donationAuditSnapshot(updated),
        },
        tx,
      );
      return updated;
    });
    return { donation: toDonationProfile(donation) };
  } catch (err) {
    throw mapDonationMutationError(err, 'cancel');
  }
}

// ---------------------------------------------------------------------------
// DON-05: donation details (read-only).
//
// The visibility contract is the recorded product decision in
// TASK_CHECKLIST.md §"DON-05 Donation Detail Visibility Decision":
//   - unauthenticated → 401; unknown id → 404; other visibility failures → 403
//   - owning provider (donation.providerId === session user id) → any status
//   - unrelated provider / volunteer → 403
//   - ADMIN → any status (read-only)
//   - RECIPIENT → only when their organization is VERIFIED and the donation is
//     AVAILABLE or MATCHED; every other recipient case → 403
//   - "verification-aware" = recipient-organization verification; the provider
//     organization's state is NOT a gate (Donation has no provider-org relation)
// The provider projection is an explicit safe scalar select (never email/phone/
// passwordHash/tokens). time_remaining is computed at read time via the BE-09
// `timeRemainingMs` utility (milliseconds; 0 at/after available_until) and is
// never persisted. This is a pure read: no transaction, no audit, no
// notification, no status transition.

export interface DonationDetailProvider {
  id: string;
  name: string;
  organization: { id: string; name: string; verificationStatus: string } | null;
}

export interface DonationDetail {
  id: string;
  providerId: string;
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: Date;
  availableUntil: Date;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  storageRequirement: string | null;
  description: string | null;
  status: DonationStatus;
  createdAt: Date;
  updatedAt: Date;
  provider: DonationDetailProvider;
  time_remaining: number;
}

export interface GetDonationResult {
  donation: DonationDetail;
}

// Provider projection is fixed by the recorded decision — do not expand.
export const DONATION_DETAIL_SELECT = {
  id: true,
  providerId: true,
  foodName: true,
  category: true,
  foodType: true,
  quantity: true,
  unit: true,
  availableFrom: true,
  availableUntil: true,
  pickupLocation: true,
  pickupLatitude: true,
  pickupLongitude: true,
  storageRequirement: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  provider: {
    select: {
      id: true,
      name: true,
      organization: { select: { id: true, name: true, verificationStatus: true } },
    },
  },
} as const;

type ViewingCaller = Pick<User, 'id' | 'role' | 'status'> & {
  organization: { id: string; verificationStatus: string } | null;
};

function mapDonationReadError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'DONATION_READ_FAILED', 'Failed to read donation');
}

// The recorded visibility matrix. Identity/role/org come only from the DB row
// for the authenticated session user; nothing is trusted from the request.
function canViewDonation(
  caller: ViewingCaller,
  donation: { providerId: string; status: DonationStatus }
): boolean {
  if (caller.role === 'ADMIN') return true;
  if (donation.providerId === caller.id) return true;
  if (
    caller.role === 'RECIPIENT' &&
    caller.organization !== null &&
    caller.organization.verificationStatus === 'VERIFIED' &&
    (donation.status === 'AVAILABLE' || donation.status === 'MATCHED')
  ) {
    return true;
  }
  return false;
}

export async function getDonation(
  donationId: string,
  userId: string
): Promise<GetDonationResult> {
  if (typeof donationId !== 'string' || donationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'donationId', message: 'Donation id is required' },
    ]);
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();

  let caller: ViewingCaller | null;
  try {
    caller = await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true, verificationStatus: true } },
      },
    });
  } catch (err) {
    throw mapDonationReadError(err);
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }

  let donation: Omit<DonationDetail, 'time_remaining'> | null;
  try {
    donation = await client.donation.findUnique({
      where: { id: donationId },
      select: DONATION_DETAIL_SELECT,
    });
  } catch (err) {
    throw mapDonationReadError(err);
  }
  if (!donation) {
    throw new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  if (!canViewDonation(caller, donation)) {
    throw new AppError(403, 'FORBIDDEN', 'Not authorized to view this donation');
  }

  const time_remaining = timeRemainingMs({
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
  });
  return { donation: toDonationDetail(donation, time_remaining) };
}

// Explicit mapping of the projected row so the response can never accidentally
// include extra/sensitive fields even if a query widened.
function toDonationDetail(donation: Omit<DonationDetail, 'time_remaining'>, timeRemaining: number): DonationDetail {
  return {
    id: donation.id,
    providerId: donation.providerId,
    foodName: donation.foodName,
    category: donation.category,
    foodType: donation.foodType,
    quantity: donation.quantity,
    unit: donation.unit,
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
    pickupLocation: donation.pickupLocation,
    pickupLatitude: donation.pickupLatitude,
    pickupLongitude: donation.pickupLongitude,
    storageRequirement: donation.storageRequirement,
    description: donation.description,
    status: donation.status,
    createdAt: donation.createdAt,
    updatedAt: donation.updatedAt,
    provider: {
      id: donation.provider.id,
      name: donation.provider.name,
      organization: donation.provider.organization
        ? {
            id: donation.provider.organization.id,
            name: donation.provider.organization.name,
            verificationStatus: donation.provider.organization.verificationStatus,
          }
        : null,
    },
    time_remaining: timeRemaining,
  };
}

// ---------------------------------------------------------------------------
// DON-06: donation listing (read-only).
//
// Visibility is the recorded product decision in TASK_CHECKLIST.md
// §"DON-06 Donation Listing Visibility Decision": PROVIDER → own
// (providerId === session id); RECIPIENT → persisted status AVAILABLE; ADMIN →
// all; VOLUNTEER → 403 (no browse/list capability). Every role's results are
// additionally constrained by the universal read-time availability rule
// (availableFrom <= now AND availableUntil > now), which EXCLUDES not-yet-
// available and expired rows at the database level. This is a pure read: no
// status transition, no audit, no notification, no expiry mutation.
//
// Pagination reuses the project utility (page default 1, limit default 20,
// max 100) and the ORG-02 listing convention (count + paged query in one
// $transaction, orderBy createdAt desc). time_remaining is computed at request
// time with BE-09 `timeRemainingMs` (milliseconds) and never persisted.
// DON-06 does not require the DON-05 provider projection, so the listing
// projection is donation scalars only.

export interface DonationListItem {
  id: string;
  providerId: string;
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: Date;
  availableUntil: Date;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  storageRequirement: string | null;
  description: string | null;
  status: DonationStatus;
  createdAt: Date;
  updatedAt: Date;
  time_remaining: number;
}

// Explicit safe scalar projection for the listing (no provider, no relations).
export const DONATION_LIST_SELECT = {
  id: true,
  providerId: true,
  foodName: true,
  category: true,
  foodType: true,
  quantity: true,
  unit: true,
  availableFrom: true,
  availableUntil: true,
  pickupLocation: true,
  pickupLatitude: true,
  pickupLongitude: true,
  storageRequirement: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ListingCaller = Pick<User, 'id' | 'role' | 'status'>;

// A structural WHERE shape — the service never filters in JavaScript.
// DON-07 filter predicates are added to the top-level `AND` array so they are
// always composed additively with DON-06 role visibility and the universal
// current-availability predicate (a supplied `status` filter therefore can
// never replace the RECIPIENT AVAILABLE-only rule).
interface DonationListingWhere {
  providerId?: string;
  status?: DonationStatus;
  availableFrom: { lte: Date };
  availableUntil: { gt: Date };
  AND?: Array<Record<string, unknown>>;
}

// DON-07: validated filter inputs (see the authoritative DON-07 semantics
// decision). Location/radius is DEFERRED and is rejected upstream.
type ListingFilters = z.infer<typeof donationListingFilterSchema>;

// Strict query-string numeric parsing: rejects arrays/objects/empty strings and
// non-finite values instead of relying on JavaScript coercion.
function listingQuantityField(field: 'minQuantity' | 'maxQuantity') {
  return z.preprocess(
    (value) => {
      if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return Number.NaN;
      if (typeof value === 'string' && value.trim() === '') return Number.NaN;
      return typeof value === 'number' ? value : Number(value);
    },
    z
      .number({ invalid_type_error: `${field} must be a number` })
      .finite(`${field} must be a finite number`)
  );
}

export const donationListingFilterSchema = z
  .object({
    status: z
      .nativeEnum(DonationStatus, { errorMap: () => ({ message: 'status must be a valid DonationStatus' }) })
      .optional(),
    category: z.string().trim().min(1, 'category must be non-empty').optional(),
    foodType: z.string().trim().min(1, 'foodType must be non-empty').optional(),
    minQuantity: listingQuantityField('minQuantity').optional(),
    maxQuantity: listingQuantityField('maxQuantity').optional(),
    availableFrom: donationDateField('availableFrom').optional(),
    availableUntil: donationDateField('availableUntil').optional(),
  })
  // page/limit and any client-supplied identity fields are ignored, not
  // rejected (DON-06 behavior), except the explicitly unsupported radiusKm.
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.radiusKm !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['radiusKm'],
        message: 'radiusKm is not supported (location/radius filtering is deferred)',
      });
    }
    const hasFrom = value.availableFrom !== undefined;
    const hasUntil = value.availableUntil !== undefined;
    if (hasFrom !== hasUntil) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasFrom ? 'availableUntil' : 'availableFrom'],
        message: 'availableFrom and availableUntil must be supplied together',
      });
    }
    if (
      value.availableFrom instanceof Date &&
      value.availableUntil instanceof Date &&
      value.availableFrom.getTime() >= value.availableUntil.getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availableUntil'],
        message: 'availableFrom must be before availableUntil',
      });
    }
    if (
      typeof value.minQuantity === 'number' &&
      typeof value.maxQuantity === 'number' &&
      value.minQuantity > value.maxQuantity
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxQuantity'],
        message: 'minQuantity must be less than or equal to maxQuantity',
      });
    }
  });

function buildListingWhere(
  caller: ListingCaller,
  now: Date,
  filters: ListingFilters
): DonationListingWhere {
  const where: DonationListingWhere = {
    availableFrom: { lte: now },
    availableUntil: { gt: now },
  };
  if (caller.role === 'PROVIDER') {
    where.providerId = caller.id;
  } else if (caller.role === 'RECIPIENT') {
    where.status = 'AVAILABLE';
  }

  // DON-07 filters, ANDed with the DON-06 predicates. Overlap is expressed as
  // two separate conditions so it composes with (rather than replaces) the
  // universal current-availability bounds.
  const and: Array<Record<string, unknown>> = [];
  if (filters.availableFrom !== undefined && filters.availableUntil !== undefined) {
    and.push({ availableFrom: { lt: filters.availableUntil } });
    and.push({ availableUntil: { gt: filters.availableFrom } });
  }
  if (filters.minQuantity !== undefined) {
    and.push({ quantity: { gte: filters.minQuantity } });
  }
  if (filters.maxQuantity !== undefined) {
    and.push({ quantity: { lte: filters.maxQuantity } });
  }
  if (filters.category !== undefined) {
    and.push({ category: filters.category });
  }
  if (filters.foodType !== undefined) {
    and.push({ foodType: filters.foodType });
  }
  if (filters.status !== undefined) {
    and.push({ status: filters.status });
  }
  if (and.length > 0) {
    where.AND = and;
  }
  return where;
}

// Explicit mapping so extra/sensitive fields can never leak from the query.
function toDonationListItem(
  donation: Omit<DonationListItem, 'time_remaining'>,
  timeRemaining: number
): DonationListItem {
  return {
    id: donation.id,
    providerId: donation.providerId,
    foodName: donation.foodName,
    category: donation.category,
    foodType: donation.foodType,
    quantity: donation.quantity,
    unit: donation.unit,
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
    pickupLocation: donation.pickupLocation,
    pickupLatitude: donation.pickupLatitude,
    pickupLongitude: donation.pickupLongitude,
    storageRequirement: donation.storageRequirement,
    description: donation.description,
    status: donation.status,
    createdAt: donation.createdAt,
    updatedAt: donation.updatedAt,
    time_remaining: timeRemaining,
  };
}

export async function listDonations(
  userId: string,
  query: Record<string, unknown>
): Promise<PaginationResult<DonationListItem>> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  // DON-07: validate filter input BEFORE any DB work (fail fast, zero queries
  // on malformed input). radiusKm is explicitly rejected, never ignored.
  const parsedFilters = donationListingFilterSchema.safeParse(query ?? {});
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

  let caller: ListingCaller | null;
  try {
    caller = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
  } catch (err) {
    throw mapDonationReadError(err);
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // VOLUNTEER has no listing capability (DON-06 decision); any unknown role is
  // likewise denied rather than silently treated as unrestricted.
  if (caller.role !== 'PROVIDER' && caller.role !== 'RECIPIENT' && caller.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Not authorized to list donations');
  }

  // A supplied category must correspond to the active Category set
  // (ADR-007 string-validation); never auto-created, never a FK.
  if (filters.category !== undefined) {
    let active: { id: string } | null = null;
    try {
      active = await client.category.findFirst({
        where: { name: filters.category, isActive: true },
        select: { id: true },
      });
    } catch (err) {
      throw mapDonationReadError(err);
    }
    if (!active) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
        { field: 'category', message: 'Category must be one of the active categories' },
      ]);
    }
  }

  const now = new Date();
  const where = buildListingWhere(caller, now, filters);

  try {
    const [rows, total] = await client.$transaction([
      client.donation.findMany({
        where,
        select: DONATION_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: params.offset,
        take: params.limit,
      }),
      client.donation.count({ where }),
    ]);
    const items = rows.map((row) =>
      toDonationListItem(
        row,
        timeRemainingMs({ availableFrom: row.availableFrom, availableUntil: row.availableUntil }, now)
      )
    );
    return paginate(items, total, params);
  } catch (err) {
    throw mapDonationReadError(err);
  }
}

// ---------------------------------------------------------------------------
// DON-08: provider donation history (read-only).
//
// Exactly per the recorded decision in TASK_CHECKLIST.md
// §"DON-08 Donation History Decision":
//   - PROVIDER only; identity from the session; `provider_id=me` is the only
//     accepted value (anything else, including omitted/repeated/array → 400).
//   - RECIPIENT / VOLUNTEER / ADMIN → 403 (no admin access, no reuse of
//     DON-05/DON-06 visibility).
//   - HISTORICAL: no DON-06 current-availability predicate — future, expired,
//     cancelled and every other persisted status are included.
//   - ordering createdAt DESC, then id DESC; pagination reuses parsePagination
//     with the same WHERE for findMany and count; strictly read-only.
//   - timeline source = EXISTING AuditLog rows for the donation (entityType
//     'Donation'); only persisted actions may appear (DONATION_CREATED /
//     DONATION_UPDATED / DONATION_CANCELLED). No fabricated transitions and no
//     acceptance-audit repair.

export interface DonationTimelineEvent {
  action: string;
  timestamp: Date;
  oldValue: string | null;
  newValue: string | null;
}

export interface DonationHistoryItem {
  id: string;
  providerId: string;
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: Date;
  availableUntil: Date;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  storageRequirement: string | null;
  description: string | null;
  status: DonationStatus;
  createdAt: Date;
  updatedAt: Date;
  timeline: DonationTimelineEvent[];
}

// `me` is the only supported provider_id; everything else (omitted, other
// value, repeated/array) is a client validation error. page/limit pass through
// to parsePagination; unrelated client identity params are ignored and can
// never influence ownership.
export const donationHistoryQuerySchema = z
  .object({
    provider_id: z.literal('me', {
      errorMap: () => ({ message: "provider_id must be 'me'" }),
    }),
  })
  .passthrough();

function toDonationHistoryItem(
  donation: Omit<DonationHistoryItem, 'timeline'>,
  timeline: DonationTimelineEvent[]
): DonationHistoryItem {
  return {
    id: donation.id,
    providerId: donation.providerId,
    foodName: donation.foodName,
    category: donation.category,
    foodType: donation.foodType,
    quantity: donation.quantity,
    unit: donation.unit,
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
    pickupLocation: donation.pickupLocation,
    pickupLatitude: donation.pickupLatitude,
    pickupLongitude: donation.pickupLongitude,
    storageRequirement: donation.storageRequirement,
    description: donation.description,
    status: donation.status,
    createdAt: donation.createdAt,
    updatedAt: donation.updatedAt,
    timeline,
  };
}

export async function getDonationHistory(
  userId: string,
  query: Record<string, unknown>
): Promise<PaginationResult<DonationHistoryItem>> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  const parsed = donationHistoryQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const params = parsePagination(query ?? {});
  const client: PrismaClient = getPrisma();

  let caller: ListingCaller | null;
  try {
    caller = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
  } catch (err) {
    throw mapDonationReadError(err);
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Provider history is provider-only; RECIPIENT/VOLUNTEER/ADMIN get 403.
  if (caller.role !== 'PROVIDER') {
    throw new AppError(403, 'FORBIDDEN', 'Not authorized to view donation history');
  }

  // Ownership comes ONLY from the session caller; no current-availability
  // predicate (this is history, not a findable listing).
  const where = { providerId: caller.id };

  try {
    const [rows, total] = await client.$transaction([
      client.donation.findMany({
        where,
        select: DONATION_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: params.offset,
        take: params.limit,
      }),
      client.donation.count({ where }),
    ]);

    // One audit query for the whole page (no N+1); grouped by donation id.
    const ids = rows.map((row) => row.id);
    const timelineByDonation = new Map<string, DonationTimelineEvent[]>();
    if (ids.length > 0) {
      const audits = await client.auditLog.findMany({
        where: { entityType: 'Donation', entityId: { in: ids } },
        select: { entityId: true, action: true, timestamp: true, oldValue: true, newValue: true },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      });
      for (const audit of audits) {
        const events = timelineByDonation.get(audit.entityId) ?? [];
        events.push({
          action: audit.action,
          timestamp: audit.timestamp,
          oldValue: audit.oldValue,
          newValue: audit.newValue,
        });
        timelineByDonation.set(audit.entityId, events);
      }
    }

    const items = rows.map((row) => toDonationHistoryItem(row, timelineByDonation.get(row.id) ?? []));
    return paginate(items, total, params);
  } catch (err) {
    throw mapDonationReadError(err);
  }
}

// ---------------------------------------------------------------------------
// DON-12: ADMIN-only donation override (D-19 resolved decision).
//
// Exactly two authorized pairs — `ACCEPTED → CANCELLED` and
// `COMPLETED → AVAILABLE` — validated via the SEPARATE narrow
// `canAdminOverride()` matrix (the ordinary `canTransition()` lifecycle is NOT
// broadened; COMPLETED stays terminal for normal paths). The source status is
// always read from persistence; the client supplies only `to`. Reuses the
// existing conditional-update concurrency pattern and writes exactly one
// `DONATION_ADMIN_OVERRIDE` audit row in the SAME transaction (rollback on
// audit failure). No expiry automation, no transaction/audit architecture
// changes, no schema change.
export async function overrideDonation(
  donationId: string,
  userId: string,
  input: unknown
): Promise<AdminOverrideResult> {
  if (typeof donationId !== 'string' || donationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'donationId', message: 'Donation id is required' },
    ]);
  }
  const parsed = adminOverrideSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const target = parsed.data.to;

  const client: PrismaClient = getPrisma();
  const caller = await loadAdminCaller(client, userId);

  try {
    const donation: Donation = await client.$transaction(async (tx) => {
      const existing = await tx.donation.findUnique({ where: { id: donationId } });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Donation not found');
      }
      // Source status comes ONLY from persistence; the exact authorized pair is
      // required (everything else → 409, no mutation).
      if (!canAdminOverride(existing.status, target)) {
        throw new AppError(409, 'CONFLICT', 'Transition is not an authorized administrative override');
      }

      // Conditional update keyed on id + expected persisted source status.
      const mutated = await tx.donation.updateMany({
        where: { id: donationId, status: existing.status },
        data: { status: target },
      });
      if (mutated.count !== 1) {
        throw new AppError(409, 'CONFLICT', 'Donation was modified concurrently');
      }

      const updated = await tx.donation.findUnique({ where: { id: donationId } });
      if (!updated) {
        throw new AppError(409, 'CONFLICT', 'Donation was modified concurrently');
      }

      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'DONATION_ADMIN_OVERRIDE',
          entityType: 'Donation',
          entityId: updated.id,
          oldValue: donationAuditSnapshot(existing),
          newValue: donationAuditSnapshot(updated),
        },
        tx,
      );
      return updated;
    });
    return { donation: toDonationProfile(donation) };
  } catch (err) {
    throw mapDonationMutationError(err, 'override');
  }
}
