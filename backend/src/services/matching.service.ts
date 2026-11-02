import { z } from 'zod';
import type { DonationStatus, MatchStatus, Prisma, PrismaClient, Role, UserStatus } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import type { MatchingConfig } from '../config/matching';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import {
  checkMatchingCompatibility,
  MATCHABLE_DONATION_STATUSES,
  MATCHABLE_REQUIREMENT_STATUSES,
} from '../utils/matchingCompatibility';
import {
  MATCHING_DONATION_SELECT,
  MATCHING_REQUIREMENT_SELECT,
  toMatchingDonationInput,
  toMatchingRequirementInput,
  type MatchingDonationInput,
  type MatchingRequirementInput,
} from '../utils/matchingInput';
import { scoreMatch, type MatchScoreContext, type MatchScoreResult } from '../utils/matchingScore';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';
import { logger } from '../utils/logger';
import { canTransition } from '../utils/donationState';
import { allocateInTransaction, lockDonationForAllocation } from './allocations.service';
import { persistAuditEvent } from './audit.service';
import { loadMatchingConfig } from './settings.service';
import { findFreeVolunteers } from './volunteers.service';
import { createNotification } from './notification.service';

// ---------------------------------------------------------------------------
// MATCH-06..MATCH-10: matching engine service.
//
// - Generation composes MATCH-01 (inputs), MATCH-02 (feasibility gate),
//   MATCH-03 (distance) and MATCH-06 (weighted score) and persists ranked
//   recommendations as Match rows (status RECOMMENDED).
// - Re-running is idempotent: existing RECOMMENDED/EXPIRED rows are re-scored,
//   RECOMMENDED rows that are no longer feasible become EXPIRED, and
//   REJECTED/ACCEPTED rows are never touched.
// - D-05: matching never changes Donation.status (MATCHED stays optional), so
//   donations remain browseable/editable exactly as before.
// - Matching never writes Allocation rows or requirement quantities; acceptance
//   and delivery confirmation own those.

type Client = PrismaClient;
type Tx = Prisma.TransactionClient;

export interface MatchCaller {
  id: string;
  role: Role;
  status: UserStatus;
  organizationId: string | null;
}

export interface MatchGenerationResult {
  scope: 'donation' | 'requirement';
  id: string;
  /** Pairs left RECOMMENDED by this run (created + refreshed). */
  recommended: number;
  created: number;
  refreshed: number;
  expired: number;
}

export const MATCH_SUMMARY_SELECT = {
  id: true,
  matchingScore: true,
  distance: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  donation: {
    select: {
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
      status: true,
    },
  },
  requirement: {
    select: {
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
      organization: { select: { id: true, name: true } },
    },
  },
} as const;

export type MatchSummary = Prisma.MatchGetPayload<{ select: typeof MATCH_SUMMARY_SELECT }>;

// Donation candidate projection: MATCH-01 fields + provider organization
// coordinates (location fallback when the donation has no pickup coordinates).
const DONATION_CANDIDATE_SELECT = {
  ...MATCHING_DONATION_SELECT,
  providerId: true,
  foodName: true,
  provider: { select: { organization: { select: { latitude: true, longitude: true } } } },
} as const;

type DonationCandidateRow = Prisma.DonationGetPayload<{ select: typeof DONATION_CANDIDATE_SELECT }>;

const REQUIREMENT_CANDIDATE_SELECT = {
  ...MATCHING_REQUIREMENT_SELECT,
  organization: { select: { latitude: true, longitude: true, verificationStatus: true } },
} as const;

type RequirementCandidateRow = Prisma.RequirementGetPayload<{
  select: typeof REQUIREMENT_CANDIDATE_SELECT;
}>;

interface ScoredPair {
  donationId: string;
  requirementId: string;
  requirementOrganizationId: string;
  providerId: string;
  foodName: string;
  result: MatchScoreResult;
}

// ---------------------------------------------------------------------------
// Errors / validation helpers

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field, message: `${field} is required` },
    ]);
  }
  return value.trim();
}

function mapMatchingError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025') {
    return new AppError(404, 'NOT_FOUND', 'Match not found');
  }
  // Never leak SQL, constraint names, or connection details.
  return new AppError(500, 'MATCHING_FAILED', 'Matching failed');
}

async function loadCaller(client: Client, userId: string): Promise<MatchCaller> {
  const id = requireId(userId, 'userId');
  const user = await client.user.findUnique({
    where: { id },
    select: { id: true, role: true, status: true, organizationId: true },
  });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  return user;
}

// ---------------------------------------------------------------------------
// Input mapping

function toDonationCandidate(row: DonationCandidateRow, committed: number): MatchingDonationInput {
  const input = toMatchingDonationInput(row, committed);
  if (input.pickupLatitude === null || input.pickupLongitude === null) {
    const org = row.provider?.organization;
    // Real provider-organization coordinates, never fabricated (D-07).
    input.pickupLatitude = org ? org.latitude : null;
    input.pickupLongitude = org ? org.longitude : null;
  }
  return input;
}

async function committedByDonation(client: Client | Tx, donationIds: string[]) {
  const map = new Map<string, number>();
  if (donationIds.length === 0) return map;
  const groups = await client.allocation.groupBy({
    by: ['donationId'],
    where: { donationId: { in: donationIds } },
    _sum: { committedQuantity: true },
  });
  for (const g of groups) map.set(g.donationId, g._sum.committedQuantity ?? 0);
  return map;
}

/**
 * Donation statuses whose allocations are reserved but not yet delivered.
 * Delivered quantity is already in Requirement.quantityFulfilled, and
 * cancelled/expired donations release their reservation, so only these count.
 */
export const IN_FLIGHT_DONATION_STATUSES: readonly DonationStatus[] = [
  'ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
];

async function inFlightByRequirement(client: Client | Tx, requirementIds: string[]) {
  const map = new Map<string, number>();
  if (requirementIds.length === 0) return map;
  const groups = await client.allocation.groupBy({
    by: ['requirementId'],
    where: {
      requirementId: { in: requirementIds },
      donation: { status: { in: [...IN_FLIGHT_DONATION_STATUSES] } },
    },
    _sum: { committedQuantity: true },
  });
  for (const g of groups) map.set(g.requirementId, g._sum.committedQuantity ?? 0);
  return map;
}

/** Remaining demand for matching: excludes quantity already reserved in flight. */
function withInFlight(input: MatchingRequirementInput, inFlight: number): MatchingRequirementInput {
  return inFlight > 0 ? { ...input, remainingQuantity: input.remainingQuantity - inFlight } : input;
}

/** LOG-08: windows of free volunteers between now and the latest relevant deadline. */
async function transportContext(client: Client, now: Date, until: Date): Promise<MatchScoreContext> {
  const free = await findFreeVolunteers(client, now, until);
  return { volunteerWindows: free.flatMap((v) => v.windows) };
}

/** Degree-based bounding box prefilter for the matching radius. */
function boundingBox(lat: number, lng: number, km: number) {
  const latDelta = km / 111.32;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = cos > 1e-6 ? km / (111.32 * cos) : 180;
  return {
    latitude: { gte: lat - latDelta, lte: lat + latDelta },
    // Skip the longitude bound when it would wrap the antimeridian.
    ...(lngDelta < 180 && lng - lngDelta >= -180 && lng + lngDelta <= 180
      ? { longitude: { gte: lng - lngDelta, lte: lng + lngDelta } }
      : {}),
  };
}

function scorePairs(
  donations: Array<{ input: MatchingDonationInput; providerId: string; foodName: string }>,
  requirements: MatchingRequirementInput[],
  config: MatchingConfig,
  now: Date,
  context: MatchScoreContext
): ScoredPair[] {
  const pairs: ScoredPair[] = [];
  for (const d of donations) {
    for (const r of requirements) {
      if (!checkMatchingCompatibility(d.input, r, now).compatible) continue;
      const outcome = scoreMatch(d.input, r, config, now, context);
      if (!outcome.ok) continue;
      pairs.push({
        donationId: d.input.id,
        requirementId: r.id,
        requirementOrganizationId: r.organizationId,
        providerId: d.providerId,
        foodName: d.foodName,
        result: outcome.result,
      });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Persistence (one transaction per generation run)

async function persistPairs(
  client: Client,
  scope: { donationId: string } | { requirementId: string },
  pairs: ScoredPair[]
): Promise<Omit<MatchGenerationResult, 'scope' | 'id'>> {
  return client.$transaction(async (tx) => {
    const existing = await tx.match.findMany({
      where: scope,
      select: { id: true, donationId: true, requirementId: true, status: true },
    });
    const byPair = new Map(existing.map((m) => [`${m.donationId}:${m.requirementId}`, m]));
    const scoredKeys = new Set<string>();
    const fresh: ScoredPair[] = [];
    let refreshed = 0;

    for (const p of pairs) {
      const key = `${p.donationId}:${p.requirementId}`;
      scoredKeys.add(key);
      const prior = byPair.get(key);
      if (!prior) {
        fresh.push(p);
        continue;
      }
      if (prior.status === 'REJECTED' || prior.status === 'ACCEPTED') continue;
      // Conditional write: a concurrent reject/accept is never overwritten.
      const res = await tx.match.updateMany({
        where: { id: prior.id, status: { in: ['RECOMMENDED', 'EXPIRED'] } },
        data: {
          matchingScore: p.result.score,
          distance: p.result.distanceKm,
          status: 'RECOMMENDED',
        },
      });
      refreshed += res.count;
    }

    const staleIds = existing
      .filter((m) => m.status === 'RECOMMENDED' && !scoredKeys.has(`${m.donationId}:${m.requirementId}`))
      .map((m) => m.id);
    const expired =
      staleIds.length > 0
        ? (
            await tx.match.updateMany({
              where: { id: { in: staleIds }, status: 'RECOMMENDED' },
              data: { status: 'EXPIRED' },
            })
          ).count
        : 0;

    let created = 0;
    if (fresh.length > 0) {
      created = (
        await tx.match.createMany({
          data: fresh.map((p) => ({
            donationId: p.donationId,
            requirementId: p.requirementId,
            matchingScore: p.result.score,
            distance: p.result.distanceKm,
            status: 'RECOMMENDED' as MatchStatus,
          })),
          // A concurrent run may have inserted the same pair (unique index).
          skipDuplicates: true,
        })
      ).count;
      await notifyNewMatches(tx, fresh);
    }

    // REJECTED/ACCEPTED pairs are feasible but not (re)recommended.
    return { recommended: created + refreshed, created, refreshed, expired };
  });
}

async function notifyNewMatches(tx: Tx, fresh: ScoredPair[]): Promise<void> {
  const orgIds = [...new Set(fresh.map((p) => p.requirementOrganizationId))];
  const recipients = await tx.user.findMany({
    where: { organizationId: { in: orgIds }, role: 'RECIPIENT', status: 'ACTIVE' },
    select: { id: true, organizationId: true },
  });

  // One notice per recipient user and per provider, regardless of pair count.
  const perRecipient = new Map<string, ScoredPair[]>();
  for (const u of recipients) {
    perRecipient.set(
      u.id,
      fresh.filter((p) => p.requirementOrganizationId === u.organizationId)
    );
  }
  for (const [userId, list] of perRecipient) {
    if (list.length === 0) continue;
    const top = [...list].sort((a, b) => b.result.score - a.result.score)[0];
    await createNotification(
      {
        userId,
        type: NotificationType.DONATION_MATCHED,
        title: 'New donation match',
        message:
          list.length === 1
            ? `"${top.foodName}" matches one of your requirements (${top.result.distanceKm} km away).`
            : `${list.length} new donation matches for your requirements, including "${top.foodName}".`,
        entityType: 'Match',
        entityId: top.requirementId,
      },
      tx
    );
  }

  const perProvider = new Map<string, ScoredPair[]>();
  for (const p of fresh) {
    perProvider.set(p.providerId, [...(perProvider.get(p.providerId) ?? []), p]);
  }
  for (const [userId, list] of perProvider) {
    const names = [...new Set(list.map((p) => p.foodName))];
    await createNotification(
      {
        userId,
        type: NotificationType.DONATION_MATCHED,
        title: 'Donation matched',
        message: `Your donation "${names[0]}"${names.length > 1 ? ` and ${names.length - 1} more` : ''} matched ${list.length} recipient requirement${list.length === 1 ? '' : 's'}.`,
        entityType: 'Donation',
        entityId: list[0].donationId,
      },
      tx
    );
  }
}

// ---------------------------------------------------------------------------
// Generation

export async function generateMatchesForDonation(
  donationId: string,
  now: Date = new Date(),
  configOverride?: MatchingConfig
): Promise<MatchGenerationResult> {
  // ADMIN-04: administrator overrides apply unless the caller pins a config.
  const config = configOverride ?? (await loadMatchingConfig());
  const id = requireId(donationId, 'donationId');
  const client = getPrisma();
  try {
    const row = await client.donation.findUnique({ where: { id }, select: DONATION_CANDIDATE_SELECT });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Donation not found');
    const committed = (await committedByDonation(client, [id])).get(id) ?? 0;
    const donation = toDonationCandidate(row, committed);

    let requirements: MatchingRequirementInput[] = [];
    const matchable =
      MATCHABLE_DONATION_STATUSES.includes(donation.status) &&
      donation.remainingQuantity > 0 &&
      donation.availableUntil.getTime() > now.getTime();
    if (matchable && donation.pickupLatitude !== null && donation.pickupLongitude !== null) {
      const earliest = Math.max(now.getTime(), donation.availableFrom.getTime());
      const rows: RequirementCandidateRow[] = await client.requirement.findMany({
        where: {
          status: { in: [...MATCHABLE_REQUIREMENT_STATUSES] },
          requiredBy: { gt: new Date(earliest) },
          organization: {
            verificationStatus: 'VERIFIED',
            ...boundingBox(donation.pickupLatitude, donation.pickupLongitude, config.maxDistanceKm),
          },
        },
        select: REQUIREMENT_CANDIDATE_SELECT,
        orderBy: [{ requiredBy: 'asc' }, { id: 'asc' }],
        take: config.candidateLimit,
      });
      const inFlight = await inFlightByRequirement(
        client,
        rows.map((r) => r.id)
      );
      requirements = rows.map((r) => withInFlight(toMatchingRequirementInput(r), inFlight.get(r.id) ?? 0));
    }

    const pairs = scorePairs(
      [{ input: donation, providerId: row.providerId, foodName: row.foodName }],
      requirements,
      config,
      now,
      requirements.length > 0 ? await transportContext(client, now, donation.availableUntil) : {}
    );
    const counts = await persistPairs(client, { donationId: id }, pairs);
    return { scope: 'donation', id, ...counts };
  } catch (err) {
    throw mapMatchingError(err);
  }
}

export async function generateMatchesForRequirement(
  requirementId: string,
  now: Date = new Date(),
  configOverride?: MatchingConfig
): Promise<MatchGenerationResult> {
  // ADMIN-04: administrator overrides apply unless the caller pins a config.
  const config = configOverride ?? (await loadMatchingConfig());
  const id = requireId(requirementId, 'requirementId');
  const client = getPrisma();
  try {
    const row = await client.requirement.findUnique({ where: { id }, select: REQUIREMENT_CANDIDATE_SELECT });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Requirement not found');
    const inFlight = (await inFlightByRequirement(client, [id])).get(id) ?? 0;
    const requirement = withInFlight(toMatchingRequirementInput(row), inFlight);

    let donations: Array<{ input: MatchingDonationInput; providerId: string; foodName: string }> = [];
    const matchable =
      row.organization?.verificationStatus === 'VERIFIED' &&
      MATCHABLE_REQUIREMENT_STATUSES.includes(requirement.status) &&
      requirement.remainingQuantity > 0 &&
      requirement.requiredBy.getTime() > now.getTime();
    if (matchable) {
      const rows: DonationCandidateRow[] = await client.donation.findMany({
        where: {
          status: { in: [...MATCHABLE_DONATION_STATUSES] },
          availableUntil: { gt: now },
          availableFrom: { lt: requirement.requiredBy },
        },
        select: DONATION_CANDIDATE_SELECT,
        orderBy: [{ availableUntil: 'asc' }, { id: 'asc' }],
        take: config.candidateLimit,
      });
      const committed = await committedByDonation(
        client,
        rows.map((r) => r.id)
      );
      donations = rows.map((r) => ({
        input: toDonationCandidate(r, committed.get(r.id) ?? 0),
        providerId: r.providerId,
        foodName: r.foodName,
      }));
    }

    const pairs = scorePairs(
      donations,
      [requirement],
      config,
      now,
      donations.length > 0 ? await transportContext(client, now, requirement.requiredBy) : {}
    );
    const counts = await persistPairs(client, { requirementId: id }, pairs);
    return { scope: 'requirement', id, ...counts };
  } catch (err) {
    throw mapMatchingError(err);
  }
}

/**
 * Best-effort trigger used after donation/requirement writes. Matching must
 * never fail or roll back the business write that triggered it.
 */
export async function refreshMatchesSafely(
  scope: 'donation' | 'requirement',
  id: string
): Promise<void> {
  try {
    if (scope === 'donation') await generateMatchesForDonation(id);
    else await generateMatchesForRequirement(id);
  } catch (err) {
    logger.warn(
      { scope, id, code: err instanceof AppError ? err.code : undefined },
      'Match refresh failed'
    );
  }
}

/**
 * MATCH-11: periodic maintenance. Expires RECOMMENDED rows whose donation or
 * requirement is no longer live, then re-scores every live donation so the
 * time-dependent urgency component (and new pairs) stay current.
 */
export async function refreshAllActiveMatches(
  now: Date = new Date(),
  configOverride?: MatchingConfig
): Promise<{ donations: number; failed: number; expired: number; created: number }> {
  const client = getPrisma();
  const config = configOverride ?? (await loadMatchingConfig());
  const stale = await client.match.updateMany({
    where: {
      status: 'RECOMMENDED',
      OR: [
        { donation: { status: { notIn: [...MATCHABLE_DONATION_STATUSES] } } },
        { donation: { availableUntil: { lte: now } } },
        { requirement: { status: { notIn: [...MATCHABLE_REQUIREMENT_STATUSES] } } },
        { requirement: { requiredBy: { lte: now } } },
      ],
    },
    data: { status: 'EXPIRED' },
  });

  // Every pair involves a live donation, so donation-side runs cover all pairs.
  const live = await client.donation.findMany({
    where: { status: { in: [...MATCHABLE_DONATION_STATUSES] }, availableUntil: { gt: now } },
    select: { id: true },
    orderBy: [{ availableUntil: 'asc' }, { id: 'asc' }],
  });
  let failed = 0;
  let expired = stale.count;
  let created = 0;
  for (const { id } of live) {
    try {
      const r = await generateMatchesForDonation(id, now, config);
      expired += r.expired;
      created += r.created;
    } catch (err) {
      failed += 1;
      logger.warn({ id, code: err instanceof AppError ? err.code : undefined }, 'Scheduled match refresh failed');
    }
  }
  return { donations: live.length, failed, expired, created };
}

// ---------------------------------------------------------------------------
// ACCEPT-01: accept a donation for one requirement (match-driven or direct).
//
// One transaction: donation row lock → re-validate both sides → allocate
// min(donation remaining, requirement remaining) → Donation ACCEPTED → Match
// ACCEPTED → the donation's other recommendations EXPIRED → audit + provider
// notification. Requirement.quantityFulfilled is NOT changed here; delivery
// confirmation owns it.

export interface AcceptanceResult {
  donation: { id: string; status: DonationStatus };
  allocation: { id: string; requirementId: string; committedQuantity: number };
  match: { id: string; status: MatchStatus } | null;
}

interface AcceptingRecipient {
  id: string;
  organizationId: string;
}

async function loadAcceptingRecipient(client: Client, userId: string): Promise<AcceptingRecipient> {
  const id = requireId(userId, 'userId');
  const user = await client.user.findUnique({
    where: { id },
    select: {
      id: true,
      role: true,
      status: true,
      organization: { select: { id: true, verificationStatus: true } },
    },
  });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  if (user.role !== 'RECIPIENT') throw new AppError(403, 'FORBIDDEN', 'Only recipients can accept donations');
  if (!user.organization || user.organization.verificationStatus !== 'VERIFIED') {
    throw new AppError(403, 'FORBIDDEN', 'Organization is not verified');
  }
  return { id: user.id, organizationId: user.organization.id };
}

async function acceptInTransaction(
  tx: Tx,
  recipient: AcceptingRecipient,
  donationId: string,
  requirementId: string,
  matchId: string | null,
  now: Date
): Promise<AcceptanceResult> {
  // Serializes against concurrent acceptances/allocations of this donation.
  const lock = await lockDonationForAllocation(tx, donationId);
  const donationRemaining = lock.remaining;

  const donation = await tx.donation.findUnique({
    where: { id: donationId },
    select: { id: true, status: true, providerId: true, foodName: true, unit: true, availableUntil: true },
  });
  if (!donation) throw new AppError(404, 'NOT_FOUND', 'Donation not found');
  if (!canTransition(donation.status, 'ACCEPTED')) {
    throw new AppError(409, 'CONFLICT', 'Donation is not available');
  }
  if (donation.availableUntil.getTime() <= now.getTime()) {
    throw new AppError(409, 'CONFLICT', 'Donation has expired');
  }

  const requirement = await tx.requirement.findUnique({
    where: { id: requirementId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      quantityRequired: true,
      quantityFulfilled: true,
      requiredBy: true,
    },
  });
  // Same 404 for missing and foreign requirements so ids cannot be probed.
  if (!requirement || requirement.organizationId !== recipient.organizationId) {
    throw new AppError(404, 'NOT_FOUND', 'Requirement not found');
  }
  if (!MATCHABLE_REQUIREMENT_STATUSES.includes(requirement.status)) {
    throw new AppError(409, 'CONFLICT', 'Requirement is no longer open');
  }
  if (requirement.requiredBy.getTime() <= now.getTime()) {
    throw new AppError(409, 'CONFLICT', 'Requirement deadline has passed');
  }

  const inFlight = (await inFlightByRequirement(tx, [requirementId])).get(requirementId) ?? 0;
  const requirementRemaining = requirement.quantityRequired - requirement.quantityFulfilled - inFlight;
  const quantity = Math.min(donationRemaining, requirementRemaining);
  if (!(quantity > 0)) {
    throw new AppError(409, 'CONFLICT', 'Nothing left to allocate for this requirement');
  }

  // Lock already held and requirement verified above: no duplicate round trips.
  const allocation = await allocateInTransaction(tx, donationId, requirementId, quantity, lock);

  const moved = await tx.donation.updateMany({
    where: { id: donationId, status: { in: [...MATCHABLE_DONATION_STATUSES] } },
    data: { status: 'ACCEPTED' },
  });
  if (moved.count !== 1) throw new AppError(409, 'CONFLICT', 'Donation is not available');

  let match: AcceptanceResult['match'] = null;
  if (matchId) {
    const res = await tx.match.updateMany({
      where: { id: matchId, status: 'RECOMMENDED' },
      data: { status: 'ACCEPTED' },
    });
    if (res.count !== 1) throw new AppError(409, 'CONFLICT', 'Match is no longer recommended');
    match = { id: matchId, status: 'ACCEPTED' };
  } else {
    // Direct acceptance: record the outcome on the pair's recommendation if one exists.
    const pair = await tx.match.findUnique({
      where: { donationId_requirementId: { donationId, requirementId } },
      select: { id: true, status: true },
    });
    if (pair && pair.status !== 'REJECTED') {
      await tx.match.update({ where: { id: pair.id }, data: { status: 'ACCEPTED' } });
      match = { id: pair.id, status: 'ACCEPTED' };
    }
  }

  // The donation is taken: its other recommendations are no longer actionable.
  await tx.match.updateMany({
    where: { donationId, status: 'RECOMMENDED' },
    data: { status: 'EXPIRED' },
  });

  await persistAuditEvent(
    {
      actorId: recipient.id,
      action: 'DONATION_ACCEPTED',
      entityType: 'Donation',
      entityId: donationId,
      oldValue: { status: donation.status },
      newValue: {
        status: 'ACCEPTED',
        requirementId,
        allocationId: allocation.id,
        committedQuantity: quantity,
        matchId: match?.id ?? null,
      },
    },
    tx
  );
  await createNotification(
    {
      userId: donation.providerId,
      type: NotificationType.DONATION_ACCEPTED,
      title: 'Donation accepted',
      message: `Your donation "${donation.foodName}" was accepted (${quantity} ${donation.unit}).`,
      entityType: 'Donation',
      entityId: donationId,
    },
    tx
  );

  return {
    donation: { id: donationId, status: 'ACCEPTED' },
    allocation: { id: allocation.id, requirementId, committedQuantity: quantity },
    match,
  };
}

function mapAcceptanceError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'ACCEPTANCE_FAILED', 'Acceptance failed');
}

export async function acceptDonationForRequirement(
  donationId: string,
  requirementId: string,
  userId: string,
  now: Date = new Date()
): Promise<AcceptanceResult> {
  const dId = requireId(donationId, 'donationId');
  const rId = requireId(requirementId, 'requirementId');
  const client = getPrisma();
  const recipient = await loadAcceptingRecipient(client, userId);
  let result: AcceptanceResult;
  try {
    result = await client.$transaction((tx) => acceptInTransaction(tx, recipient, dId, rId, null, now));
  } catch (err) {
    throw mapAcceptanceError(err);
  }
  // Covered demand drops out of the requirement's other recommendations.
  await refreshMatchesSafely('requirement', rId);
  return result;
}

export async function acceptMatch(
  matchId: string,
  userId: string,
  now: Date = new Date()
): Promise<AcceptanceResult> {
  const id = requireId(matchId, 'matchId');
  const client = getPrisma();
  const recipient = await loadAcceptingRecipient(client, userId);
  let result: AcceptanceResult;
  try {
    result = await client.$transaction(async (tx) => {
      const match = await tx.match.findUnique({
        where: { id },
        select: {
          id: true,
          donationId: true,
          requirementId: true,
          status: true,
          requirement: { select: { organizationId: true } },
        },
      });
      if (!match || match.requirement.organizationId !== recipient.organizationId) {
        throw new AppError(404, 'NOT_FOUND', 'Match not found');
      }
      if (match.status !== 'RECOMMENDED') {
        throw new AppError(409, 'CONFLICT', 'Match is no longer recommended');
      }
      return acceptInTransaction(tx, recipient, match.donationId, match.requirementId, match.id, now);
    });
  } catch (err) {
    throw mapAcceptanceError(err);
  }
  await refreshMatchesSafely('requirement', result.allocation.requirementId);
  return result;
}

// ---------------------------------------------------------------------------
// Authorization for owner-triggered refresh

export async function refreshDonationMatches(donationId: string, userId: string) {
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  const id = requireId(donationId, 'donationId');
  if (caller.role !== 'ADMIN') {
    const donation = await client.donation.findUnique({ where: { id }, select: { providerId: true } });
    if (!donation) throw new AppError(404, 'NOT_FOUND', 'Donation not found');
    if (caller.role !== 'PROVIDER' || donation.providerId !== caller.id) {
      throw new AppError(403, 'FORBIDDEN', 'Not authorized for this donation');
    }
  }
  return generateMatchesForDonation(id);
}

export async function refreshRequirementMatches(requirementId: string, userId: string) {
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  const id = requireId(requirementId, 'requirementId');
  if (caller.role !== 'ADMIN') {
    const requirement = await client.requirement.findUnique({
      where: { id },
      select: { organizationId: true },
    });
    if (!requirement) throw new AppError(404, 'NOT_FOUND', 'Requirement not found');
    if (
      caller.role !== 'RECIPIENT' ||
      !caller.organizationId ||
      requirement.organizationId !== caller.organizationId
    ) {
      throw new AppError(403, 'FORBIDDEN', 'Not authorized for this requirement');
    }
  }
  return generateMatchesForRequirement(id);
}

// ---------------------------------------------------------------------------
// Read APIs

export const listMatchesQuerySchema = z
  .object({
    status: z.enum(['RECOMMENDED', 'ACCEPTED', 'REJECTED', 'EXPIRED']).default('RECOMMENDED'),
    donationId: z.string().trim().min(1).max(255).optional(),
    requirementId: z.string().trim().min(1).max(255).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ListMatchesQuery = z.infer<typeof listMatchesQuerySchema>;

/** Role scope: ADMIN all, PROVIDER own donations, RECIPIENT own organization's requirements. */
function scopeWhere(caller: MatchCaller): Prisma.MatchWhereInput {
  switch (caller.role) {
    case 'ADMIN':
      return {};
    case 'PROVIDER':
      return { donation: { providerId: caller.id } };
    case 'RECIPIENT':
      if (!caller.organizationId) {
        throw new AppError(403, 'FORBIDDEN', 'Organization required to view matches');
      }
      return { requirement: { organizationId: caller.organizationId } };
    default:
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
  }
}

/** A RECOMMENDED match is only shown while both sides are still matchable. */
function liveRecommendationWhere(now: Date): Prisma.MatchWhereInput {
  return {
    donation: {
      status: { in: [...MATCHABLE_DONATION_STATUSES] },
      availableUntil: { gt: now },
    },
    requirement: {
      status: { in: [...MATCHABLE_REQUIREMENT_STATUSES] },
      requiredBy: { gt: now },
    },
  };
}

export async function listMatches(
  userId: string,
  query: unknown,
  now: Date = new Date()
): Promise<PaginationResult<MatchSummary>> {
  const parsed = listMatchesQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const q = parsed.data;
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  const params = parsePagination({ page: q.page, limit: q.limit });

  const and: Prisma.MatchWhereInput[] = [scopeWhere(caller), { status: q.status }];
  if (q.donationId) and.push({ donationId: q.donationId });
  if (q.requirementId) and.push({ requirementId: q.requirementId });
  if (q.status === 'RECOMMENDED') and.push(liveRecommendationWhere(now));
  const where: Prisma.MatchWhereInput = { AND: and };

  try {
    const [rows, total] = await client.$transaction([
      client.match.findMany({
        where,
        select: MATCH_SUMMARY_SELECT,
        // Best score first; ties favour the donation expiring soonest.
        orderBy: [{ matchingScore: 'desc' }, { donation: { availableUntil: 'asc' } }, { id: 'asc' }],
        skip: params.offset,
        take: params.limit,
      }),
      client.match.count({ where }),
    ]);
    return paginate(rows, total, params);
  } catch (err) {
    throw mapMatchingError(err);
  }
}

function canViewMatch(caller: MatchCaller, match: MatchSummary): boolean {
  if (caller.role === 'ADMIN') return true;
  if (caller.role === 'PROVIDER') return match.donation.providerId === caller.id;
  if (caller.role === 'RECIPIENT') {
    return caller.organizationId !== null && match.requirement.organizationId === caller.organizationId;
  }
  return false;
}

export async function getMatch(matchId: string, userId: string): Promise<{ match: MatchSummary }> {
  const id = requireId(matchId, 'matchId');
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  let match: MatchSummary | null;
  try {
    match = await client.match.findUnique({ where: { id }, select: MATCH_SUMMARY_SELECT });
  } catch (err) {
    throw mapMatchingError(err);
  }
  // Same 404 for missing and out-of-scope so ids cannot be probed.
  if (!match || !canViewMatch(caller, match)) throw new AppError(404, 'NOT_FOUND', 'Match not found');
  return { match };
}

// ---------------------------------------------------------------------------
// Reject (recipient owner of the requirement, or ADMIN)

export async function rejectMatch(matchId: string, userId: string): Promise<{ match: MatchSummary }> {
  const id = requireId(matchId, 'matchId');
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  if (caller.role !== 'RECIPIENT' && caller.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can reject matches');
  }

  try {
    const match = await client.$transaction(async (tx) => {
      const current = await tx.match.findUnique({ where: { id }, select: MATCH_SUMMARY_SELECT });
      if (!current || !canViewMatch(caller, current)) {
        throw new AppError(404, 'NOT_FOUND', 'Match not found');
      }
      if (current.status !== 'RECOMMENDED') {
        throw new AppError(409, 'CONFLICT', 'Only recommended matches can be rejected');
      }
      // Conditional transition: loses cleanly against a concurrent accept/expire.
      const res = await tx.match.updateMany({
        where: { id, status: 'RECOMMENDED' },
        data: { status: 'REJECTED' },
      });
      if (res.count !== 1) {
        throw new AppError(409, 'CONFLICT', 'Only recommended matches can be rejected');
      }
      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'MATCH_REJECTED',
          entityType: 'Match',
          entityId: id,
          oldValue: { status: 'RECOMMENDED' },
          newValue: { status: 'REJECTED' },
        },
        tx
      );
      return { ...current, status: 'REJECTED' as MatchStatus };
    });
    return { match };
  } catch (err) {
    throw mapMatchingError(err);
  }
}
