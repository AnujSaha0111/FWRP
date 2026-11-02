import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { startMatchingRefreshJob } from '../jobs/matchingRefresh';
import {
  acceptDonationForRequirement,
  acceptMatch,
  generateMatchesForDonation,
  generateMatchesForRequirement,
  listMatches,
  refreshAllActiveMatches,
  refreshMatchesSafely,
  rejectMatch,
} from '../services/matching.service';
import { signAccessToken } from '../utils/jwt';

// MATCH-06..MATCH-10: generation, persistence, scoping and rejection.

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const BERLIN = { latitude: 52.52, longitude: 13.405 };

interface MatchRow {
  id: string;
  donationId: string;
  requirementId: string;
  matchingScore: number;
  distance: number;
  status: string;
}

function donationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'don-1',
    providerId: 'prov-1',
    foodName: 'Veg curry',
    pickupLocation: 'Main St',
    pickupLatitude: BERLIN.latitude,
    pickupLongitude: BERLIN.longitude,
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 100,
    availableFrom: new Date(NOW.getTime() - HOUR),
    availableUntil: new Date(NOW.getTime() + 6 * HOUR),
    status: 'AVAILABLE',
    createdAt: NOW,
    provider: { organization: { ...BERLIN } },
    ...overrides,
  };
}

function requirementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    organizationId: 'org-r1',
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 80,
    quantityFulfilled: 0,
    requiredBy: new Date(NOW.getTime() + 12 * HOUR),
    priority: 'HIGH',
    location: 'Shelter',
    status: 'OPEN',
    createdAt: NOW,
    organization: { latitude: 52.53, longitude: 13.41, verificationStatus: 'VERIFIED' },
    ...overrides,
  };
}

function makeClient(opts: {
  donations?: ReturnType<typeof donationRow>[];
  requirements?: ReturnType<typeof requirementRow>[];
  matches?: MatchRow[];
  allocations?: Array<{ donationId: string; requirementId?: string; committedQuantity: number }>;
  users?: Array<{ id: string; role: string; status: string; organizationId: string | null }>;
  volunteerWindows?: Array<{ availableFrom: Date; availableUntil: Date }>;
}) {
  const donations = opts.donations ?? [donationRow()];
  const requirements = opts.requirements ?? [requirementRow()];
  const matches: MatchRow[] = opts.matches ?? [];
  const allocations = (opts.allocations ?? []).map((a) => ({ requirementId: 'req-x', ...a }));
  const users = opts.users ?? [
    { id: 'prov-1', role: 'PROVIDER', status: 'ACTIVE', organizationId: 'org-p1' },
    { id: 'rec-1', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-r1' },
    { id: 'rec-2', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-r2' },
    { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: null },
    { id: 'vol-1', role: 'VOLUNTEER', status: 'ACTIVE', organizationId: null },
  ];
  const notifications: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;

  const summary = (m: MatchRow) => {
    const d = donations.find((x) => x.id === m.donationId)!;
    const r = requirements.find((x) => x.id === m.requirementId)!;
    return {
      ...m,
      createdAt: NOW,
      updatedAt: NOW,
      donation: { ...d },
      requirement: { ...r, organization: { id: r.organizationId, name: 'Shelter' } },
    };
  };

  const client = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) return null;
        return {
          ...u,
          organization: u.organizationId ? { id: u.organizationId, verificationStatus: 'VERIFIED' } : null,
        };
      }),
      findMany: vi.fn(async ({ where }: { where: { organizationId: { in: string[] } } }) =>
        users.filter((u) => u.role === 'RECIPIENT' && u.organizationId && where.organizationId.in.includes(u.organizationId))
      ),
    },
    donation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => donations.find((d) => d.id === where.id) ?? null),
      findMany: vi.fn(async () => donations),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: { in: string[] } }; data: { status: string } }) => {
        const d = donations.find((x) => x.id === where.id && where.status.in.includes(x.status as string));
        if (d) Object.assign(d, data);
        return { count: d ? 1 : 0 };
      }),
    },
    requirement: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => requirements.find((r) => r.id === where.id) ?? null),
      findMany: vi.fn(async () => requirements),
    },
    allocation: {
      groupBy: vi.fn(
        async ({ by, where }: { by: ['donationId' | 'requirementId']; where: Record<string, unknown> }) => {
          const key = by[0];
          const ids = (where[key] as { in: string[] }).in;
          const statuses = (where.donation as { status?: { in: string[] } } | undefined)?.status?.in;
          return ids.map((id) => ({
            [key]: id,
            _sum: {
              committedQuantity:
                allocations
                  .filter((a) => a[key] === id)
                  .filter((a) => !statuses || statuses.includes(donations.find((d) => d.id === a.donationId)?.status as string))
                  .reduce((sum, a) => sum + a.committedQuantity, 0) || null,
            },
          }));
        }
      ),
      aggregate: vi.fn(async ({ where }: { where: { donationId: string } }) => ({
        _sum: {
          committedQuantity:
            allocations.filter((a) => a.donationId === where.donationId).reduce((sum, a) => sum + a.committedQuantity, 0) || null,
        },
      })),
      create: vi.fn(async ({ data }: { data: { donationId: string; requirementId: string; committedQuantity: number } }) => {
        allocations.push(data);
        return { id: `alloc-${allocations.length}`, ...data, createdAt: NOW, updatedAt: NOW };
      }),
    },
    match: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where as { donationId?: string; requirementId?: string };
        if (w.donationId) return matches.filter((m) => m.donationId === w.donationId);
        if (w.requirementId) return matches.filter((m) => m.requirementId === w.requirementId);
        return matches.map(summary);
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; donationId_requirementId?: { donationId: string; requirementId: string } } }) => {
          const pair = where.donationId_requirementId;
          const m = pair
            ? matches.find((x) => x.donationId === pair.donationId && x.requirementId === pair.requirementId)
            : matches.find((x) => x.id === where.id);
          return m ? summary(m) : null;
        }
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MatchRow> }) => {
        const m = matches.find((x) => x.id === where.id)!;
        Object.assign(m, data);
        return m;
      }),
      count: vi.fn(async () => matches.length),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string | { in: string[] }; donationId?: string; status: string | { in: string[] } };
          data: Partial<MatchRow>;
        }) => {
        const ids = where.id === undefined ? null : typeof where.id === 'string' ? [where.id] : where.id.in;
        const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
        let count = 0;
        for (const m of matches) {
          if ((!ids || ids.includes(m.id)) && (!where.donationId || m.donationId === where.donationId) && statuses.includes(m.status)) {
            Object.assign(m, data);
            count += 1;
          }
        }
        return { count };
      }),
      createMany: vi.fn(async ({ data }: { data: Omit<MatchRow, 'id'>[] }) => {
        for (const row of data) matches.push({ id: `match-${++seq}`, ...row });
        return { count: data.length };
      }),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return { id: `n-${notifications.length}`, ...data };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `a-${audits.length}`, ...data };
      }),
    },
    // LOG-08 transport context: free volunteer windows (none unless provided).
    volunteerAvailability: {
      findMany: vi.fn(async () =>
        (opts.volunteerWindows ?? []).map((w, i) => ({
          id: `w-${i}`,
          ...w,
          volunteer: { id: `vol-w${i}`, name: 'V', phone: '0' },
        }))
      ),
    },
    delivery: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, donationId: string) =>
      donations.filter((d) => d.id === donationId).map((d) => ({ donation_id: d.id, quantity: d.quantity }))
    ),
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => Promise<unknown>)(client);
    }),
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { client, matches, notifications, audits, allocations, donations };
}

function token(id: string, role: string, organizationId: string | null = null) {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId } as never);
}

beforeEach(() => {
  vi.mocked(getPrisma).mockReset();
});

describe('MATCH-06 generation from a donation', () => {
  it('creates a RECOMMENDED match for a feasible pair and notifies both sides', async () => {
    const { matches, notifications } = makeClient({});
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result).toMatchObject({ scope: 'donation', id: 'don-1', recommended: 1, created: 1, refreshed: 0, expired: 0 });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ donationId: 'don-1', requirementId: 'req-1', status: 'RECOMMENDED' });
    expect(matches[0].matchingScore).toBeGreaterThan(0);
    expect(matches[0].matchingScore).toBeLessThanOrEqual(1);
    expect(matches[0].distance).toBeGreaterThan(0);
    expect(notifications.map((n) => n.userId).sort()).toEqual(['prov-1', 'rec-1']);
    expect(notifications.every((n) => n.type === 'DONATION_MATCHED')).toBe(true);
  });

  it('skips infeasible requirements (deadline passed, cancelled, out of range, unknown location)', async () => {
    const { matches } = makeClient({
      donations: [donationRow({ pickupLatitude: null, pickupLongitude: null })],
      requirements: [
        requirementRow({ id: 'req-past', requiredBy: new Date(NOW.getTime() - HOUR) }),
        requirementRow({ id: 'req-cancelled', status: 'CANCELLED' }),
        requirementRow({ id: 'req-far', organization: { latitude: 53.55, longitude: 9.99, verificationStatus: 'VERIFIED' } }),
        requirementRow({ id: 'req-ok' }),
      ],
    });
    // Donation coordinates fall back to the provider organization's (real) coordinates.
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result.recommended).toBe(1);
    expect(matches.map((m) => m.requirementId)).toEqual(['req-ok']);
  });

  it('excludes the pair when neither the donation nor its provider has coordinates (D-07)', async () => {
    const { matches } = makeClient({
      donations: [donationRow({ pickupLatitude: null, pickupLongitude: null, provider: { organization: null } })],
    });
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result.recommended).toBe(0);
    expect(matches).toHaveLength(0);
  });

  it('uses remaining (unallocated) quantity: a fully allocated donation recommends nothing', async () => {
    const { matches } = makeClient({ allocations: [{ donationId: 'don-1', committedQuantity: 100 }] });
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result.recommended).toBe(0);
    expect(matches).toHaveLength(0);
  });

  it('is idempotent: a re-run refreshes instead of duplicating, without re-notifying', async () => {
    const { matches, notifications } = makeClient({});
    await generateMatchesForDonation('don-1', NOW);
    const before = notifications.length;
    const second = await generateMatchesForDonation('don-1', NOW);
    expect(second).toMatchObject({ created: 0, refreshed: 1, expired: 0 });
    expect(matches).toHaveLength(1);
    expect(notifications).toHaveLength(before);
  });

  it('expires stale recommendations and never touches REJECTED/ACCEPTED rows', async () => {
    const { matches } = makeClient({
      donations: [donationRow({ status: 'CANCELLED' })],
      matches: [
        { id: 'm-rec', donationId: 'don-1', requirementId: 'req-1', matchingScore: 0.8, distance: 1, status: 'RECOMMENDED' },
        { id: 'm-rej', donationId: 'don-1', requirementId: 'req-2', matchingScore: 0.7, distance: 1, status: 'REJECTED' },
        { id: 'm-acc', donationId: 'don-1', requirementId: 'req-3', matchingScore: 0.6, distance: 1, status: 'ACCEPTED' },
      ],
    });
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result).toMatchObject({ recommended: 0, expired: 1 });
    expect(Object.fromEntries(matches.map((m) => [m.id, m.status]))).toEqual({
      'm-rec': 'EXPIRED',
      'm-rej': 'REJECTED',
      'm-acc': 'ACCEPTED',
    });
  });

  it('scores transport availability when a free volunteer covers the delivery window (LOG-08)', async () => {
    const without = makeClient({});
    await generateMatchesForDonation('don-1', NOW);
    const withVolunteer = makeClient({
      volunteerWindows: [{ availableFrom: NOW, availableUntil: new Date(NOW.getTime() + 3 * HOUR) }],
    });
    await generateMatchesForDonation('don-1', NOW);
    expect(withVolunteer.matches[0].matchingScore - without.matches[0].matchingScore).toBeCloseTo(0.1, 4);
  });

  it('does not resurrect a rejected pair', async () => {
    const { matches } = makeClient({
      matches: [{ id: 'm-rej', donationId: 'don-1', requirementId: 'req-1', matchingScore: 0.5, distance: 1, status: 'REJECTED' }],
    });
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result).toMatchObject({ recommended: 0, created: 0, refreshed: 0 });
    expect(matches[0].status).toBe('REJECTED');
  });

  it('never changes Donation.status (D-05) or writes allocations', async () => {
    const { client } = makeClient({});
    await generateMatchesForDonation('don-1', NOW);
    expect(client.donation.updateMany).not.toHaveBeenCalled();
    expect(client.allocation.create).not.toHaveBeenCalled();
  });

  it('404s for an unknown donation', async () => {
    makeClient({});
    await expect(generateMatchesForDonation('nope', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('MATCH-06 generation from a requirement', () => {
  it('ranks multiple donations for one requirement', async () => {
    const { matches } = makeClient({
      donations: [
        donationRow({ id: 'don-near' }),
        donationRow({ id: 'don-type', foodType: 'Vegan' }),
        donationRow({ id: 'don-expired', availableUntil: new Date(NOW.getTime() - HOUR) }),
      ],
    });
    const result = await generateMatchesForRequirement('req-1', NOW);
    expect(result).toMatchObject({ scope: 'requirement', recommended: 2, created: 2 });
    const byId = Object.fromEntries(matches.map((m) => [m.donationId, m.matchingScore]));
    expect(byId['don-near']).toBeGreaterThan(byId['don-type']);
    expect(byId['don-expired']).toBeUndefined();
  });

  it('does not match requirements of unverified organizations', async () => {
    const { matches } = makeClient({
      requirements: [requirementRow({ organization: { latitude: 52.53, longitude: 13.41, verificationStatus: 'PENDING' } })],
    });
    const result = await generateMatchesForRequirement('req-1', NOW);
    expect(result.recommended).toBe(0);
    expect(matches).toHaveLength(0);
  });
});

describe('MATCH-06 best-effort trigger', () => {
  it('swallows failures so the triggering write never fails', async () => {
    vi.mocked(getPrisma).mockReturnValue({} as unknown as PrismaClient);
    await expect(refreshMatchesSafely('donation', 'don-1')).resolves.toBeUndefined();
  });
});

describe('MATCH-07 listing scope', () => {
  async function whereFor(userId: string) {
    const { client } = makeClient({});
    await listMatches(userId, {}, NOW);
    return JSON.stringify(client.match.findMany.mock.calls[0][0].where);
  }

  it('scopes PROVIDER to own donations and RECIPIENT to own organization', async () => {
    expect(await whereFor('prov-1')).toContain('"providerId":"prov-1"');
    expect(await whereFor('rec-1')).toContain('"organizationId":"org-r1"');
    const admin = await whereFor('admin-1');
    expect(admin).not.toContain('providerId');
    expect(admin).not.toContain('"organizationId"');
  });

  it('only shows RECOMMENDED matches whose donation and requirement are still live', async () => {
    const where = await whereFor('rec-1');
    expect(where).toContain('"status":"RECOMMENDED"');
    expect(where).toContain('availableUntil');
    expect(where).toContain('requiredBy');
  });

  it('orders by score, then soonest-expiring donation', async () => {
    const { client } = makeClient({});
    await listMatches('admin-1', {}, NOW);
    expect(client.match.findMany.mock.calls[0][0].orderBy).toEqual([
      { matchingScore: 'desc' },
      { donation: { availableUntil: 'asc' } },
      { id: 'asc' },
    ]);
  });

  it('rejects volunteers and invalid filters', async () => {
    makeClient({});
    await expect(listMatches('vol-1', {}, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(listMatches('admin-1', { status: 'BOGUS' }, NOW)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('MATCH-09 rejection', () => {
  const seeded = (): MatchRow[] => [
    { id: 'm-1', donationId: 'don-1', requirementId: 'req-1', matchingScore: 0.9, distance: 1, status: 'RECOMMENDED' },
  ];

  it('lets the owning recipient reject a recommendation and audits it', async () => {
    const { matches, audits } = makeClient({ matches: seeded() });
    const { match } = await rejectMatch('m-1', 'rec-1');
    expect(match.status).toBe('REJECTED');
    expect(matches[0].status).toBe('REJECTED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'MATCH_REJECTED', entityType: 'Match', entityId: 'm-1' });
  });

  it("hides other organizations' matches (404) and refuses non-recommended ones (409)", async () => {
    makeClient({ matches: seeded() });
    await expect(rejectMatch('m-1', 'rec-2')).rejects.toMatchObject({ statusCode: 404 });
    await rejectMatch('m-1', 'rec-1');
    await expect(rejectMatch('m-1', 'rec-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('forbids providers', async () => {
    makeClient({ matches: seeded() });
    await expect(rejectMatch('m-1', 'prov-1')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('MATCH-07..10 HTTP surface', () => {
  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/matches');
    expect(res.status).toBe(401);
  });

  it('forbids volunteers at the route', async () => {
    makeClient({});
    const res = await request(createApp())
      .get('/api/matches')
      .set('Authorization', `Bearer ${token('vol-1', 'VOLUNTEER')}`);
    expect(res.status).toBe(403);
  });

  it('lists matches for a recipient with the pagination envelope', async () => {
    makeClient({
      matches: [{ id: 'm-1', donationId: 'don-1', requirementId: 'req-1', matchingScore: 0.9, distance: 1.2, status: 'RECOMMENDED' }],
    });
    const res = await request(createApp())
      .get('/api/matches?limit=5')
      .set('Authorization', `Bearer ${token('rec-1', 'RECIPIENT', 'org-r1')}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ total: 1, page: 1, limit: 5 });
    expect(res.body.data.items[0]).toMatchObject({ id: 'm-1', matchingScore: 0.9, status: 'RECOMMENDED' });
  });

  it('lets a provider refresh only their own donation', async () => {
    makeClient({ donations: [donationRow({ providerId: 'someone-else' })] });
    const res = await request(createApp())
      .post('/api/matches/donations/don-1/refresh')
      .set('Authorization', `Bearer ${token('prov-1', 'PROVIDER', 'org-p1')}`);
    expect(res.status).toBe(403);
  });

  it('lets a recipient refresh their own requirement', async () => {
    // The route uses the real clock, so the fixtures are relative to it.
    const now = Date.now();
    makeClient({
      donations: [
        donationRow({ availableFrom: new Date(now - HOUR), availableUntil: new Date(now + 6 * HOUR) }),
      ],
      requirements: [requirementRow({ requiredBy: new Date(now + 12 * HOUR) })],
    });
    const res = await request(createApp())
      .post('/api/matches/requirements/req-1/refresh')
      .set('Authorization', `Bearer ${token('rec-1', 'RECIPIENT', 'org-r1')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ scope: 'requirement', id: 'req-1', recommended: 1 });
  });

  it('rejects via POST /:id/reject and returns 404 for out-of-scope GET /:id', async () => {
    makeClient({
      matches: [{ id: 'm-1', donationId: 'don-1', requirementId: 'req-1', matchingScore: 0.9, distance: 1, status: 'RECOMMENDED' }],
    });
    const app = createApp();
    const other = await request(app)
      .get('/api/matches/m-1')
      .set('Authorization', `Bearer ${token('rec-2', 'RECIPIENT', 'org-r2')}`);
    expect(other.status).toBe(404);
    const res = await request(app)
      .post('/api/matches/m-1/reject')
      .set('Authorization', `Bearer ${token('rec-1', 'RECIPIENT', 'org-r1')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.match.status).toBe('REJECTED');
  });
});

describe('MATCH-06 in-flight demand', () => {
  it('subtracts quantity reserved by undelivered accepted donations from requirement demand', async () => {
    const { matches } = makeClient({
      donations: [donationRow(), donationRow({ id: 'don-taken', status: 'ACCEPTED' })],
      allocations: [{ donationId: 'don-taken', requirementId: 'req-1', committedQuantity: 80 }],
    });
    const result = await generateMatchesForDonation('don-1', NOW);
    expect(result.recommended).toBe(0);
    expect(matches).toHaveLength(0);
  });

  it('ignores reservations of cancelled donations', async () => {
    const { matches } = makeClient({
      donations: [donationRow(), donationRow({ id: 'don-gone', status: 'CANCELLED' })],
      allocations: [{ donationId: 'don-gone', requirementId: 'req-1', committedQuantity: 80 }],
    });
    await generateMatchesForDonation('don-1', NOW);
    expect(matches).toHaveLength(1);
  });
});

describe('ACCEPT-01 acceptance', () => {
  const seeded = (): MatchRow[] => [
    { id: 'm-1', donationId: 'don-1', requirementId: 'req-1', matchingScore: 0.9, distance: 1, status: 'RECOMMENDED' },
    { id: 'm-2', donationId: 'don-1', requirementId: 'req-2', matchingScore: 0.5, distance: 2, status: 'RECOMMENDED' },
  ];

  it('accepting a match allocates min(remaining), accepts the donation and expires sibling matches', async () => {
    const { matches, allocations, donations, audits, notifications } = makeClient({
      matches: seeded(),
      requirements: [requirementRow(), requirementRow({ id: 'req-2', organizationId: 'org-r2' })],
    });
    const result = await acceptMatch('m-1', 'rec-1', NOW);
    expect(result).toEqual({
      donation: { id: 'don-1', status: 'ACCEPTED' },
      allocation: { id: expect.any(String), requirementId: 'req-1', committedQuantity: 80 },
      match: { id: 'm-1', status: 'ACCEPTED' },
    });
    expect(allocations).toContainEqual({ donationId: 'don-1', requirementId: 'req-1', committedQuantity: 80 });
    expect(donations[0].status).toBe('ACCEPTED');
    expect(Object.fromEntries(matches.map((m) => [m.id, m.status]))).toEqual({ 'm-1': 'ACCEPTED', 'm-2': 'EXPIRED' });
    expect(audits).toContainEqual(expect.objectContaining({ action: 'DONATION_ACCEPTED', entityId: 'don-1' }));
    expect(notifications).toContainEqual(expect.objectContaining({ userId: 'prov-1', type: 'DONATION_ACCEPTED' }));
  });

  it('caps the allocation at the donation remainder', async () => {
    const { allocations } = makeClient({
      matches: seeded(),
      requirements: [requirementRow({ quantityRequired: 500 })],
      allocations: [{ donationId: 'don-1', requirementId: 'req-old', committedQuantity: 30 }],
    });
    const result = await acceptMatch('m-1', 'rec-1', NOW);
    expect(result.allocation.committedQuantity).toBe(70);
    expect(allocations.reduce((sum, a) => sum + a.committedQuantity, 0)).toBe(100);
  });

  it('refuses foreign matches (404), non-recommended matches and taken donations (409)', async () => {
    makeClient({ matches: seeded() });
    await expect(acceptMatch('m-1', 'rec-2', NOW)).rejects.toMatchObject({ statusCode: 404 });

    makeClient({ matches: [{ ...seeded()[0], status: 'REJECTED' }] });
    await expect(acceptMatch('m-1', 'rec-1', NOW)).rejects.toMatchObject({ statusCode: 409 });

    makeClient({ matches: seeded(), donations: [donationRow({ status: 'ACCEPTED' })] });
    await expect(acceptMatch('m-1', 'rec-1', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses when the requirement is already covered by in-flight reservations', async () => {
    const { allocations } = makeClient({
      matches: seeded(),
      donations: [donationRow(), donationRow({ id: 'don-taken', status: 'PICKED_UP' })],
      allocations: [{ donationId: 'don-taken', requirementId: 'req-1', committedQuantity: 80 }],
    });
    await expect(acceptMatch('m-1', 'rec-1', NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(allocations).toHaveLength(1);
  });

  it('requires an active recipient of a verified organization', async () => {
    makeClient({ matches: seeded() });
    await expect(acceptMatch('m-1', 'prov-1', NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('direct acceptance with a requirementId records the pair outcome when a match exists', async () => {
    const { matches, allocations } = makeClient({ matches: [seeded()[0]] });
    const result = await acceptDonationForRequirement('don-1', 'req-1', 'rec-1', NOW);
    expect(result.match).toEqual({ id: 'm-1', status: 'ACCEPTED' });
    expect(matches[0].status).toBe('ACCEPTED');
    expect(allocations).toHaveLength(1);
  });

  it('direct acceptance without a recommendation still allocates', async () => {
    const { allocations } = makeClient({});
    const result = await acceptDonationForRequirement('don-1', 'req-1', 'rec-1', NOW);
    expect(result.match).toBeNull();
    expect(allocations).toHaveLength(1);
  });

  it('is exposed at POST /api/matches/:id/accept for recipients only', async () => {
    const now = Date.now();
    makeClient({
      matches: seeded(),
      donations: [donationRow({ availableFrom: new Date(now - HOUR), availableUntil: new Date(now + 6 * HOUR) })],
      requirements: [requirementRow({ requiredBy: new Date(now + 12 * HOUR) })],
    });
    const app = createApp();
    const provider = await request(app)
      .post('/api/matches/m-1/accept')
      .set('Authorization', `Bearer ${token('prov-1', 'PROVIDER', 'org-p1')}`);
    expect(provider.status).toBe(403);
    const res = await request(app)
      .post('/api/matches/m-1/accept')
      .set('Authorization', `Bearer ${token('rec-1', 'RECIPIENT', 'org-r1')}`);
    expect(res.status).toBe(200);
    expect(res.body.data.match).toEqual({ id: 'm-1', status: 'ACCEPTED' });
  });

  it('POST /api/donations/:id/accept with requirementId uses the allocation flow', async () => {
    const now = Date.now();
    const { allocations } = makeClient({
      donations: [donationRow({ availableFrom: new Date(now - HOUR), availableUntil: new Date(now + 6 * HOUR) })],
      requirements: [requirementRow({ requiredBy: new Date(now + 12 * HOUR) })],
    });
    const res = await request(createApp())
      .post('/api/donations/don-1/accept')
      .set('Authorization', `Bearer ${token('rec-1', 'RECIPIENT', 'org-r1')}`)
      .send({ requirementId: 'req-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.allocation).toMatchObject({ requirementId: 'req-1', committedQuantity: 80 });
    expect(allocations).toHaveLength(1);
  });
});

describe('MATCH-11 scheduled refresh', () => {
  it('expires stale recommendations and re-scores live donations', async () => {
    const { client, matches } = makeClient({});
    const summary = await refreshAllActiveMatches(NOW);
    expect(client.match.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'RECOMMENDED' },
      data: { status: 'EXPIRED' },
    });
    expect(summary).toMatchObject({ donations: 1, failed: 0, created: 1 });
    expect(matches).toHaveLength(1);
  });

  it('job is disabled at 0 minutes and never overlaps runs', async () => {
    expect(startMatchingRefreshJob(0, vi.fn())).toBeNull();
    let release: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<{ donations: number; failed: number; expired: number; created: number }>((resolve) => {
          release = () => resolve({ donations: 0, failed: 0, expired: 0, created: 0 });
        })
    );
    const job = startMatchingRefreshJob(60, run)!;
    const first = job.runOnce();
    await job.runOnce(); // skipped while the first run is in progress
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    job.stop();
  });
});
