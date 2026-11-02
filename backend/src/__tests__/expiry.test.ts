import { describe, it, expect, vi } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { startExpiryJob } from '../jobs/expiry';
import { expireDueRecords } from '../services/expiry.service';
import { canTransition } from '../utils/donationState';
import { canRequirementTransition } from '../utils/requirementState';

// EXP-01: automatic expiry against an in-memory store.

const NOW = new Date('2026-09-20T12:00:00.000Z');
const past = new Date(NOW.getTime() - 60_000);
const future = new Date(NOW.getTime() + 60_000);

type Row = Record<string, unknown> & { id: string };

function store(donations: Row[], requirements: Row[], matches: Row[] = []) {
  const notifications: Row[] = [];
  const audits: Row[] = [];
  const history: Row[] = [];
  const due = (rows: Row[], statuses: string[], field: string) =>
    rows.filter((r) => statuses.includes(r.status as string) && (r[field] as Date) <= NOW);
  const client: Record<string, unknown> = {
    donation: {
      findMany: vi.fn(async () => due(donations, ['AVAILABLE', 'MATCHED'], 'availableUntil')),
      updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = due(donations, ['AVAILABLE', 'MATCHED'], 'availableUntil').find((x) => x.id === where.id);
        if (d) d.status = 'EXPIRED';
        return { count: d ? 1 : 0 };
      }),
    },
    requirement: {
      findMany: vi.fn(async () => due(requirements, ['OPEN'], 'requiredBy')),
      updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = due(requirements, ['OPEN'], 'requiredBy').find((x) => x.id === where.id);
        if (r) r.status = 'EXPIRED';
        return { count: r ? 1 : 0 };
      }),
    },
    match: {
      updateMany: vi.fn(async ({ where }: { where: { donationId?: string; requirementId?: string } }) => {
        const hits = matches.filter(
          (m) => m.status === 'RECOMMENDED' && (m.donationId === where.donationId || m.requirementId === where.requirementId)
        );
        hits.forEach((m) => (m.status = 'EXPIRED'));
        return { count: hits.length };
      }),
    },
    requirementHistory: { create: vi.fn(async ({ data }: { data: Row }) => (history.push(data), data)) },
    notification: { create: vi.fn(async ({ data }: { data: Row }) => (notifications.push(data), data)) },
    auditLog: { create: vi.fn(async ({ data }: { data: Row }) => (audits.push(data), data)) },
  };
  client.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client));
  return { client: client as unknown as PrismaClient, notifications, audits, history };
}

function donation(id: string, status: string, availableUntil: Date): Row {
  return { id, status, availableUntil, providerId: 'prov', foodName: `Food ${id}` };
}

function requirement(id: string, status: string, requiredBy: Date): Row {
  return {
    id,
    status,
    requiredBy,
    organizationId: 'org',
    foodCategory: 'Bakery',
    foodType: 'Bread',
    quantityRequired: 10,
    quantityFulfilled: 0,
    priority: 'LOW',
    location: 'x',
  };
}

describe('EXP-01 expiry', () => {
  it('only uses transitions the state machines allow', () => {
    expect(canTransition('AVAILABLE', 'EXPIRED')).toBe(true);
    expect(canTransition('MATCHED', 'EXPIRED')).toBe(true);
    expect(canTransition('ACCEPTED', 'EXPIRED')).toBe(false);
    expect(canRequirementTransition('OPEN', 'EXPIRED')).toBe(true);
    expect(canRequirementTransition('PARTIALLY_FULFILLED', 'EXPIRED')).toBe(false);
  });

  it('expires past-window donations, expires their recommendations and notifies the provider', async () => {
    const donations = [
      donation('d-old', 'AVAILABLE', past),
      donation('d-matched', 'MATCHED', past),
      donation('d-live', 'AVAILABLE', future),
      donation('d-accepted', 'ACCEPTED', past),
    ];
    const matches: Row[] = [
      { id: 'm1', donationId: 'd-old', status: 'RECOMMENDED' },
      { id: 'm2', donationId: 'd-old', status: 'REJECTED' },
    ];
    const { client, notifications, audits } = store(donations, [], matches);
    const summary = await expireDueRecords(NOW, client);
    expect(summary).toEqual({ donationsExpired: 2, requirementsExpired: 0, failed: 0 });
    expect(Object.fromEntries(donations.map((d) => [d.id, d.status]))).toEqual({
      'd-old': 'EXPIRED',
      'd-matched': 'EXPIRED',
      'd-live': 'AVAILABLE',
      'd-accepted': 'ACCEPTED',
    });
    expect(matches.map((m) => m.status)).toEqual(['EXPIRED', 'REJECTED']);
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({ userId: 'prov', type: 'DONATION_EXPIRED', entityType: 'Donation', entityId: 'd-old' });
    expect(audits.every((a) => a.action === 'DONATION_EXPIRED' && a.userId === null)).toBe(true);
  });

  it('expires only OPEN past-deadline requirements and records history', async () => {
    const requirements = [
      requirement('r-open', 'OPEN', past),
      requirement('r-partial', 'PARTIALLY_FULFILLED', past),
      requirement('r-live', 'OPEN', future),
    ];
    const { client, history, audits } = store([], requirements);
    const summary = await expireDueRecords(NOW, client);
    expect(summary.requirementsExpired).toBe(1);
    expect(requirements.map((r) => r.status)).toEqual(['EXPIRED', 'PARTIALLY_FULFILLED', 'OPEN']);
    expect(history).toEqual([expect.objectContaining({ requirementId: 'r-open', action: 'UPDATE', status: 'EXPIRED', actorId: null })]);
    expect(audits[0]).toMatchObject({ action: 'REQUIREMENT_EXPIRED', entityId: 'r-open' });
  });

  it('is idempotent and skips rows that changed concurrently', async () => {
    const donations = [donation('d1', 'AVAILABLE', past)];
    const s = store(donations, []);
    // Accepted between the scan and the write: the conditional update finds nothing.
    (s.client.donation.updateMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    expect((await expireDueRecords(NOW, s.client)).donationsExpired).toBe(0);
    expect(s.notifications).toHaveLength(0);
    expect((await expireDueRecords(NOW, s.client)).donationsExpired).toBe(1);
    expect((await expireDueRecords(NOW, s.client)).donationsExpired).toBe(0);
  });

  it('one failing row does not stop the rest', async () => {
    const donations = [donation('d1', 'AVAILABLE', past), donation('d2', 'AVAILABLE', past)];
    const s = store(donations, []);
    (s.client.$transaction as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await expireDueRecords(NOW, s.client)).toEqual({ donationsExpired: 1, requirementsExpired: 0, failed: 1 });
  });

  it('job is disabled at 0 minutes', () => {
    expect(startExpiryJob(0, vi.fn())).toBeNull();
  });
});
