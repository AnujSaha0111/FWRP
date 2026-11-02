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
import {
  csvCell,
  getDashboard,
  getImpact,
  getReport,
  MAX_ANALYTICS_ROWS,
  toReportCsv,
} from '../services/analytics.service';
import { signAccessToken } from '../utils/jwt';

// ANALYTICS-02..05: dashboards, impact and reports.

const T0 = new Date('2026-09-01T10:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60000);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'don-1',
    providerId: 'prov',
    foodName: 'Curry',
    category: 'Prepared meals',
    status: 'COMPLETED',
    quantity: 60,
    unit: 'meals',
    pickupLocation: 'Main St, Berlin',
    createdAt: T0,
    provider: { name: 'Pat', organization: { id: 'org-p', name: 'Bistro' } },
    allocations: [
      { createdAt: min(30), committedQuantity: 60, requirement: { organization: { id: 'org-r', name: 'Shelter' } } },
    ],
    deliveries: [{ status: 'CONFIRMED', assignedAt: min(40), pickupTime: min(60), confirmedAt: min(120), quantityReceived: 55 }],
    ...overrides,
  };
}

const USERS: Record<string, { id: string; role: string; status: string; organizationId: string | null }> = {
  admin: { id: 'admin', role: 'ADMIN', status: 'ACTIVE', organizationId: null },
  prov: { id: 'prov', role: 'PROVIDER', status: 'ACTIVE', organizationId: 'org-p' },
  rec: { id: 'rec', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-r' },
  vol: { id: 'vol', role: 'VOLUNTEER', status: 'ACTIVE', organizationId: null },
};

function mockDb(rows: unknown[] = [row()]) {
  const client = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => USERS[where.id] ?? null),
      count: vi.fn(async () => 3),
    },
    donation: {
      findMany: vi.fn(async (args: { select: Record<string, unknown>; take: number }) =>
        'allocations' in args.select ? rows : [{ id: 'don-1', foodName: 'Curry', status: 'COMPLETED', updatedAt: T0 }]
      ),
      count: vi.fn(async () => 4),
      groupBy: vi.fn(async () => [
        { status: 'AVAILABLE', _count: { _all: 2 } },
        { status: 'ACCEPTED', _count: { _all: 1 } },
        { status: 'COMPLETED', _count: { _all: 5 } },
        { status: 'EXPIRED', _count: { _all: 1 } },
      ]),
    },
    requirement: {
      groupBy: vi.fn(async () => [
        { status: 'OPEN', _count: { _all: 2 } },
        { status: 'PARTIALLY_FULFILLED', _count: { _all: 1 } },
        { status: 'FULFILLED', _count: { _all: 4 } },
      ]),
    },
    match: { count: vi.fn(async () => 6) },
    delivery: {
      count: vi.fn(async () => 2),
      findMany: vi.fn(async () => [{ assignedAt: min(0), pickupTime: min(30) }]),
    },
    organization: { count: vi.fn(async () => 9) },
    volunteerAvailability: { count: vi.fn(async () => 3) },
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return client;
}

function token(id: string) {
  const u = USERS[id];
  return signAccessToken({ id, email: `${id}@example.com`, role: u.role, organizationId: u.organizationId } as never);
}

beforeEach(() => {
  vi.mocked(getPrisma).mockReset();
});

describe('ANALYTICS-02 dashboards', () => {
  it('provider: own donations only, with listed vs redistributed quantity and recent activity', async () => {
    const db = mockDb();
    const d = await getDashboard('prov', {});
    expect(d).toMatchObject({
      role: 'PROVIDER',
      completedDonations: 1,
      successfulRedistributions: 1,
      quantityDonated: [{ unit: 'meals', quantity: 60 }],
      quantityRedistributed: [{ unit: 'meals', quantity: 55 }],
      fulfillmentRate: 100,
    });
    expect(d.role === 'PROVIDER' && d.recentActivity).toHaveLength(1);
    expect(db.donation.findMany.mock.calls[0][0].where).toMatchObject({ providerId: 'prov' });
  });

  it('recipient: requirement counts, matches, deliveries and received history for the organization', async () => {
    mockDb();
    const d = await getDashboard('rec', {});
    expect(d).toMatchObject({
      role: 'RECIPIENT',
      openRequirements: 3,
      fulfilledRequirements: 4,
      recommendedMatches: 6,
      history: { completedDeliveries: 1, quantityReceived: [{ unit: 'meals', quantity: 55 }], totalRequirements: 7 },
    });
  });

  it('volunteer: own delivery counts and average pickup time', async () => {
    mockDb();
    expect(await getDashboard('vol', {})).toEqual({
      role: 'VOLUNTEER',
      activeDeliveries: 2,
      completedDeliveries: 2,
      upcomingAvailabilityWindows: 3,
      averagePickupMinutes: 30,
    });
  });

  it('admin: PRD §9.3 tiles plus KPIs', async () => {
    mockDb();
    const d = await getDashboard('admin', {});
    expect(d).toMatchObject({
      role: 'ADMIN',
      activeDonations: 3,
      completedDonations: 5,
      expiredDonations: 1,
      pendingPickups: 1,
      activeDeliveries: 2,
      verifiedOrganizations: 9,
      activeVolunteers: 3,
      kpis: { mealsRedistributed: 55, averageMatchingMinutes: 30, averagePickupMinutes: 20, averageDeliveryMinutes: 60 },
    });
  });

  it('rejects an inverted date range', async () => {
    mockDb();
    await expect(getDashboard('admin', { from: '2026-09-02', to: '2026-09-01' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('ANALYTICS-03 impact', () => {
  it('is admin-only and applies the creation-date range [from, to)', async () => {
    const db = mockDb();
    await expect(getImpact('prov', {})).rejects.toMatchObject({ statusCode: 403 });
    const kpis = await getImpact('admin', { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' });
    expect(kpis.fulfillmentRate).toBe(100);
    expect(db.donation.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { gte: new Date('2026-09-01T00:00:00Z'), lt: new Date('2026-10-01T00:00:00Z') },
    });
  });

  it('refuses unbounded scans beyond the row cap', async () => {
    mockDb(new Array(MAX_ANALYTICS_ROWS + 1).fill(row()));
    await expect(getImpact('admin', {})).rejects.toMatchObject({ statusCode: 413, code: 'REPORT_TOO_LARGE' });
  });
});

describe('ANALYTICS-04 reports', () => {
  it('translates every PRD §11 filter into the donation query', async () => {
    const db = mockDb();
    await getReport('admin', {
      providerId: 'prov',
      recipientOrganizationId: 'org-r',
      category: 'prepared meals',
      location: 'berlin',
      status: 'COMPLETED',
    });
    expect(db.donation.findMany.mock.calls[0][0].where).toEqual({
      providerId: 'prov',
      status: 'COMPLETED',
      category: { equals: 'prepared meals', mode: 'insensitive' },
      pickupLocation: { contains: 'berlin', mode: 'insensitive' },
      allocations: { some: { requirement: { organizationId: 'org-r' } } },
    });
  });

  it('summarizes totals, top donors/recipients, response time and failed donations', async () => {
    mockDb([
      row(),
      row({ id: 'don-2', providerId: 'prov2', provider: { name: 'Sam', organization: { id: 'org-s', name: 'Cafe' } }, status: 'CANCELLED', allocations: [], deliveries: [] }),
      row({ id: 'don-3', status: 'EXPIRED', allocations: [], deliveries: [] }),
    ]);
    const result = await getReport('admin', {});
    expect(result.format).toBe('json');
    if (result.format !== 'json') return;
    const r = result.report;
    expect(r.summary).toMatchObject({ totalDonations: 3, completedDonations: 1, expiredDonations: 1, cancelledDonations: 1 });
    expect(r.averageResponseMinutes).toBe(30);
    expect(r.mostActiveDonors[0]).toMatchObject({ id: 'prov', name: 'Bistro', donations: 2, completed: 1 });
    expect(r.mostActiveRecipients).toEqual([
      { id: 'org-r', name: 'Shelter', donations: 1, completed: 1, redistributed: [{ unit: 'meals', quantity: 55 }] },
    ]);
    expect(r.failedDonations.map((f) => f.status).sort()).toEqual(['CANCELLED', 'EXPIRED']);
  });

  it('exports CSV with one row per donation', () => {
    const csv = toReportCsv([row()] as never);
    const [header, line] = csv.trim().split('\r\n');
    expect(header.split(',')).toContain('quantityReceived');
    expect(line).toContain('Bistro');
    expect(line).toContain('Shelter');
    expect(line.endsWith(',55')).toBe(true);
  });

  it('quotes CSV cells and neutralizes spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});

describe('ANALYTICS HTTP surface', () => {
  it('dashboard is available to every role; impact and reports are admin-only', async () => {
    mockDb();
    const app = createApp();
    expect((await request(app).get('/api/analytics/dashboard')).status).toBe(401);
    for (const id of ['prov', 'rec', 'vol', 'admin']) {
      const res = await request(app).get('/api/analytics/dashboard').set('Authorization', `Bearer ${token(id)}`);
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(USERS[id].role);
    }
    for (const path of ['/api/analytics/impact', '/api/analytics/reports']) {
      expect((await request(app).get(path).set('Authorization', `Bearer ${token('prov')}`)).status).toBe(403);
    }
  });

  it('serves the CSV report as a download', async () => {
    mockDb();
    const res = await request(createApp())
      .get('/api/analytics/reports?format=csv')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="fwrp-report-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.text.split('\r\n')[0]).toContain('donationId');
  });

  it('rejects unknown report filters', async () => {
    mockDb();
    const res = await request(createApp())
      .get('/api/analytics/reports?status=BOGUS')
      .set('Authorization', `Bearer ${token('admin')}`);
    expect(res.status).toBe(400);
  });
});
