import type { Allocation, PrismaClient } from '@prisma/client';
import { AppError } from '../middleware/error';
import { getPrisma } from '../lib/prisma';

// ---------------------------------------------------------------------------
// REQ-08 / D-06 (Model A): authoritative allocation domain service.
//
// Establishes the committed partial-fulfillment representation used by the
// later ACCEPT-* (Phase 9) and DELCONF-* (Phase 11) workflows. This module
// deliberately exposes NO HTTP routes and does NOT implement acceptance or
// delivery confirmation.
//
// Invariants enforced here (transactionally):
//   - allocation.committedQuantity > 0
//   - SUM(committedQuantity) per donation <= donation.quantity
//
// Allocation is a reservation only: it never changes Requirement.quantityFulfilled
// or Requirement.status. Only confirmed delivery (later phase) changes those,
// deriving status through REQ-04.
//
// Concurrency: the donation row is locked with `SELECT ... FOR UPDATE` inside the
// transaction (the DB-13 concurrency pattern in docs/database.md §13) so two
// concurrent allocations cannot both read the same committed total and over-allocate.
// Prisma parameterizes `$queryRaw` — no string interpolation/SQL injection.

export interface AllocationProfile {
  id: string;
  donation_id: string;
  requirement_id: string;
  committed_quantity: number;
  created_at: Date;
  updated_at: Date;
}

export interface AllocateResult {
  allocation: AllocationProfile;
}

export interface AllocateInput {
  donation_id?: unknown;
  requirement_id?: unknown;
  quantity?: unknown;
}

function toAllocationProfile(allocation: Allocation): AllocationProfile {
  return {
    id: allocation.id,
    donation_id: allocation.donationId,
    requirement_id: allocation.requirementId,
    committed_quantity: allocation.committedQuantity,
    created_at: allocation.createdAt,
    updated_at: allocation.updatedAt,
  };
}

function mapAllocationError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'ALLOCATION_FAILED', 'Failed to allocate requirement');
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field, message: `${field} is required` },
    ]);
  }
  return value;
}

function requirePositiveQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'quantity', message: 'quantity must be a positive finite number' },
    ]);
  }
  return value;
}

type AllocationTx = Pick<PrismaClient, '$queryRaw' | 'requirement' | 'allocation'>;

/**
 * Locks the donation row (`SELECT ... FOR UPDATE`) inside the caller's
 * transaction and returns its quantity and committed total. Callers that size
 * an allocation from the remainder (ACCEPT-*) must read it through this lock.
 */
export async function lockDonationForAllocation(
  tx: AllocationTx,
  donationId: string
): Promise<{ quantity: number; committed: number; remaining: number }> {
  const locked = await tx.$queryRaw<Array<{ donation_id: string; quantity: number }>>`
    SELECT "donation_id", "quantity" FROM "donations" WHERE "donation_id" = ${donationId} FOR UPDATE
  `;
  if (!Array.isArray(locked) || locked.length === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  const quantity = locked[0].quantity;
  const sum = await tx.allocation.aggregate({
    where: { donationId },
    _sum: { committedQuantity: true },
  });
  const committed = sum._sum.committedQuantity ?? 0;
  return { quantity, committed, remaining: quantity - committed };
}

/**
 * Transaction-participating allocation: never opens its own transaction, so
 * callers can combine it with status changes atomically. Enforces both
 * invariants under the donation row lock.
 */
export interface LockedDonation {
  quantity: number;
  committed: number;
}

export async function allocateInTransaction(
  tx: AllocationTx,
  donationId: string,
  requirementId: string,
  quantity: number,
  /**
   * Pass the result of `lockDonationForAllocation` (same transaction) when the
   * caller already holds the lock and has verified the requirement; skips the
   * duplicate lock/lookup round trips. Invariants are still checked here.
   */
  locked?: LockedDonation
): Promise<Allocation> {
  requirePositiveQuantity(quantity);
  let donationQuantity: number;
  let alreadyCommitted: number;
  if (locked) {
    donationQuantity = locked.quantity;
    alreadyCommitted = locked.committed;
  } else {
    // Lock the donation row (serialize concurrent allocations for this donation).
    const rows = await tx.$queryRaw<Array<{ donation_id: string; quantity: number }>>`
      SELECT "donation_id", "quantity" FROM "donations" WHERE "donation_id" = ${donationId} FOR UPDATE
    `;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Donation not found');
    }
    donationQuantity = rows[0].quantity;

    const requirement = await tx.requirement.findUnique({
      where: { id: requirementId },
      select: { id: true },
    });
    if (!requirement) {
      throw new AppError(404, 'NOT_FOUND', 'Requirement not found');
    }

    const committed = await tx.allocation.aggregate({
      where: { donationId },
      _sum: { committedQuantity: true },
    });
    alreadyCommitted = committed._sum.committedQuantity ?? 0;
  }
  if (alreadyCommitted + quantity > donationQuantity) {
    throw new AppError(409, 'CONFLICT', 'Allocation exceeds the donation available quantity');
  }

  return tx.allocation.create({
    data: { donationId, requirementId, committedQuantity: quantity },
  });
}

export async function allocateRequirement(input: unknown): Promise<AllocateResult> {
  const raw = (input ?? {}) as AllocateInput;
  const donationId = requireNonEmptyString(raw.donation_id, 'donation_id');
  const requirementId = requireNonEmptyString(raw.requirement_id, 'requirement_id');
  const quantity = requirePositiveQuantity(raw.quantity);

  const client: PrismaClient = getPrisma();

  try {
    const allocation = await client.$transaction((tx) =>
      allocateInTransaction(tx, donationId, requirementId, quantity)
    );
    return { allocation: toAllocationProfile(allocation) };
  } catch (err) {
    throw mapAllocationError(err);
  }
}

export async function listAllocationsForDonation(donationId: string): Promise<AllocationProfile[]> {
  const id = requireNonEmptyString(donationId, 'donationId');
  const client: PrismaClient = getPrisma();
  try {
    const rows = await client.allocation.findMany({
      where: { donationId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toAllocationProfile);
  } catch (err) {
    throw mapAllocationError(err);
  }
}

export async function listAllocationsForRequirement(
  requirementId: string
): Promise<AllocationProfile[]> {
  const id = requireNonEmptyString(requirementId, 'requirementId');
  const client: PrismaClient = getPrisma();
  try {
    const rows = await client.allocation.findMany({
      where: { requirementId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toAllocationProfile);
  } catch (err) {
    throw mapAllocationError(err);
  }
}

export interface AllocationsService {
  allocateRequirement(input: unknown): Promise<AllocateResult>;
  listAllocationsForDonation(donationId: string): Promise<AllocationProfile[]>;
  listAllocationsForRequirement(requirementId: string): Promise<AllocationProfile[]>;
}

export const allocationsService: AllocationsService = {
  allocateRequirement: (input) => allocateRequirement(input),
  listAllocationsForDonation: (donationId) => listAllocationsForDonation(donationId),
  listAllocationsForRequirement: (requirementId) => listAllocationsForRequirement(requirementId),
};
