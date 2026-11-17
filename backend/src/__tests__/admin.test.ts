import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { listUsers, searchAuditLogs, updateUserStatus } from '../services/admin.service';
import { adminUpdateIncident, createIncident, getIncident, INCIDENT_TRANSITIONS } from '../services/incidents.service';
import { clearSettingsCache, getSettings, loadMatchingConfig, updateSettings } from '../services/settings.service';
import { DEFAULT_MATCHING_WEIGHTS } from '../config/matching';
import { signAccessToken } from '../utils/jwt';

// ADMIN-01 users, ADMIN-03 incidents, ADMIN-04 settings, ADMIN-05 audit search.

type Row = Record<string, unknown> & { id: string };

function makeDb() {
  const users: Row[] = [
    { id: 'admin', name: 'Ada', email: 'ada@x.com', role: 'ADMIN', status: 'ACTIVE', organizationId: null, tokenVersion: 0 },
    { id: 'admin2', name: 'Bo', email: 'bo@x.com', role: 'ADMIN', status: 'ACTIVE', organizationId: null, tokenVersion: 0 },
    { id: 'prov', name: 'Pat', email: 'pat@x.com', role: 'PROVIDER', status: 'ACTIVE', organizationId: 'org-p', tokenVersion: 0 },
    { id: 'rec', name: 'Rae', email: 'rae@x.com', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-r', tokenVersion: 0 },
    { id: 'other', name: 'Oz', email: 'oz@x.com', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-o', tokenVersion: 0 },
    { id: 'vol', name: 'Val', email: 'val@x.com', role: 'VOLUNTEER', status: 'ACTIVE', organizationId: null, tokenVersion: 0 },
  ];
  const donations: Row[] = [
    {
      id: 'don',
      providerId: 'prov',
      allocations: [{ requirement: { organizationId: 'org-r' } }],
      deliveries: [{ id: 'del', volunteerId: 'vol' }],
    },
  ];
  const deliveries: Row[] = [];
  const incidents: Row[] = [];
  const settings: Row[] = [];
  const audits: Row[] = [];
  const notifications: Row[] = [];
  const pick = (u: Row | undefined) => (u ? { id: u.id, name: u.name, role: u.role, status: u.status } : null);
  const incidentView = (i: Row) => ({
    ...i,
    reporter: pick(users.find((u) => u.id === i.reporterId)),
    subjectUser: pick(users.find((u) => u.id === i.subjectUserId)),
    resolvedBy: pick(users.find((u) => u.id === i.resolvedById)),
  });
  const matchesWhere = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
      return row[k] === v;
    });

  const client: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null),
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => users.filter((u) => matchesWhere(u, args.where))),
      count: vi.fn(async () => users.length),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id)!;
        u.status = data.status;
        if (data.tokenVersion) u.tokenVersion = (u.tokenVersion as number) + 1;
        return u;
      }),
    },
    donation: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => donations.find((d) => d.id === where.id) ?? null) },
    delivery: { count: vi.fn(async ({ where }: { where: { volunteerId: string } }) => deliveries.filter((d) => d.volunteerId === where.volunteerId).length) },
    incident: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => incidents.filter((i) => matchesWhere(i, where)).map(incidentView)),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => incidents.filter((i) => matchesWhere(i, where)).length),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        incidents.find((i) => matchesWhere(i, where)) ?? null
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = incidents.find((x) => x.id === where.id);
        return i ? incidentView(i) : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `inc-${incidents.length + 1}`, status: 'OPEN', resolution: null, resolvedById: null, resolvedAt: null, ...data };
        incidents.push(row);
        return incidentView(row);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Row }) => {
        const i = incidents.find((x) => x.id === where.id && x.status === where.status);
        if (i) Object.assign(i, data);
        return { count: i ? 1 : 0 };
      }),
    },
    systemSetting: {
      findMany: vi.fn(async () => settings.map((s) => ({ ...s, updatedBy: null }))),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: Row; update: Row }) => {
        const existing = settings.find((s) => s.key === where.key);
        if (existing) Object.assign(existing, update);
        else settings.push({ ...create, id: where.key, updatedAt: new Date() });
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        const i = settings.findIndex((s) => s.key === where.key);
        if (i >= 0) settings.splice(i, 1);
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Row }) => (audits.push(data), data)),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    notification: { create: vi.fn(async ({ data }: { data: Row }) => (notifications.push(data), data)) },
  };
  client.$transaction = vi.fn(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client)
  );
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { client, users, deliveries, incidents, settings, audits, notifications };
}

function token(id: string, role: string) {
  return signAccessToken({ id, email: `${id}@x.com`, role, organizationId: null } as never);
}

beforeEach(() => {
  vi.mocked(getPrisma).mockReset();
  clearSettingsCache();
});

describe('ADMIN-01 user management', () => {
  it('suspends a user, revokes their sessions and audits the reason', async () => {
    const { users, audits } = makeDb();
    const { user } = await updateUserStatus('admin', 'prov', { status: 'SUSPENDED', reason: 'Repeated no-shows' });
    expect(user.status).toBe('SUSPENDED');
    expect(users.find((u) => u.id === 'prov')!.tokenVersion).toBe(1);
    expect(audits[0]).toMatchObject({ action: 'USER_STATUS_CHANGED', entityId: 'prov' });
    expect(audits[0].newValue).toContain('Repeated no-shows');
  });

  it('refuses self-changes, no-op changes and suspending a volunteer mid-delivery', async () => {
    const { deliveries } = makeDb();
    await expect(updateUserStatus('admin', 'admin', { status: 'SUSPENDED', reason: 'oops' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateUserStatus('admin', 'prov', { status: 'ACTIVE', reason: 'noop' })).rejects.toMatchObject({ statusCode: 409 });
    deliveries.push({ id: 'd', volunteerId: 'vol' });
    await expect(updateUserStatus('admin', 'vol', { status: 'SUSPENDED', reason: 'late' })).rejects.toMatchObject({ code: 'ACTIVE_DELIVERY' });
  });

  it('reactivation does not revoke sessions; only admins may manage users', async () => {
    const { users } = makeDb();
    users.find((u) => u.id === 'prov')!.status = 'SUSPENDED';
    await updateUserStatus('admin', 'prov', { status: 'ACTIVE', reason: 'Appeal accepted' });
    expect(users.find((u) => u.id === 'prov')!.tokenVersion).toBe(0);
    await expect(listUsers('prov', {})).rejects.toMatchObject({ statusCode: 403 });
  });

  it('search builds a case-insensitive name/email/organization filter', async () => {
    const { client } = makeDb();
    await listUsers('admin', { q: 'bistro', role: 'PROVIDER' });
    const where = (client.user as { findMany: { mock: { calls: Array<[{ where: unknown }]> } } }).findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"mode":"insensitive"');
    expect(where).toMatchObject({ role: 'PROVIDER' });
  });
});

describe('ADMIN-03 incidents', () => {
  it('files an account report and notifies every admin', async () => {
    const { notifications } = makeDb();
    const { incident } = await createIncident('rec', {
      type: 'ACCOUNT_REPORT',
      subjectUserId: 'prov',
      reason: 'Abusive messages',
      description: 'The provider was abusive on the phone twice.',
    });
    expect(incident).toMatchObject({ type: 'ACCOUNT_REPORT', status: 'OPEN', reporter: { id: 'rec' }, subjectUser: { id: 'prov' } });
    expect(notifications.map((n) => n.userId).sort()).toEqual(['admin', 'admin2']);
  });

  it('rejects self-reports, duplicates, and disputes from non-parties', async () => {
    makeDb();
    const base = { reason: 'Something', description: 'A long enough description.' };
    await expect(createIncident('rec', { type: 'ACCOUNT_REPORT', subjectUserId: 'rec', ...base })).rejects.toMatchObject({ statusCode: 409 });
    await createIncident('rec', { type: 'ACCOUNT_REPORT', subjectUserId: 'prov', ...base });
    await expect(createIncident('rec', { type: 'ACCOUNT_REPORT', subjectUserId: 'prov', ...base })).rejects.toMatchObject({ code: 'DUPLICATE_INCIDENT' });
    await expect(createIncident('other', { type: 'DISPUTE', donationId: 'don', ...base })).rejects.toMatchObject({ statusCode: 404 });
    await expect(createIncident('rec', { type: 'DISPUTE', donationId: 'don', deliveryId: 'nope', ...base })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createIncident('rec', { type: 'DISPUTE', ...base })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('every party to a donation may dispute it', async () => {
    makeDb();
    for (const userId of ['prov', 'rec', 'vol']) {
      const { incident } = await createIncident(userId, {
        type: 'DISPUTE',
        donationId: 'don',
        reason: 'Quantity mismatch',
        description: 'Fewer meals arrived than were listed.',
      });
      expect(incident.status).toBe('OPEN');
    }
  });

  it('admin workflow: review → resolve with suspension, reporter notified, terminal afterwards', async () => {
    const { users, notifications } = makeDb();
    const { incident } = await createIncident('rec', {
      type: 'ACCOUNT_REPORT',
      subjectUserId: 'prov',
      reason: 'Fraud',
      description: 'Listed food that never existed.',
    });
    await adminUpdateIncident('admin', incident.id, { status: 'UNDER_REVIEW' });
    await expect(adminUpdateIncident('admin', incident.id, { status: 'RESOLVED' })).rejects.toMatchObject({ statusCode: 400 });
    const { incident: done } = await adminUpdateIncident('admin', incident.id, {
      status: 'RESOLVED',
      resolution: 'Confirmed; account suspended.',
      suspendSubject: true,
    });
    expect(done).toMatchObject({ status: 'RESOLVED', resolution: 'Confirmed; account suspended.', resolvedBy: { id: 'admin' } });
    expect(users.find((u) => u.id === 'prov')).toMatchObject({ status: 'SUSPENDED', tokenVersion: 1 });
    expect(notifications.filter((n) => n.userId === 'rec').map((n) => n.title)).toEqual([
      'Your report is under review',
      'Your report was resolved',
    ]);
    await expect(adminUpdateIncident('admin', incident.id, { status: 'DISMISSED', resolution: 'x x x' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('only the reporter or an admin can read an incident', async () => {
    makeDb();
    const { incident } = await createIncident('rec', { type: 'ACCOUNT_REPORT', subjectUserId: 'prov', reason: 'Rude', description: 'Rude at pickup time.' });
    await expect(getIncident('rec', incident.id)).resolves.toBeDefined();
    await expect(getIncident('admin', incident.id)).resolves.toBeDefined();
    await expect(getIncident('prov', incident.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('transition table is closed after RESOLVED/DISMISSED', () => {
    expect(INCIDENT_TRANSITIONS.RESOLVED).toEqual([]);
    expect(INCIDENT_TRANSITIONS.DISMISSED).toEqual([]);
  });
});

describe('ADMIN-04 settings', () => {
  it('defaults apply until overridden; overrides feed the matching config', async () => {
    makeDb();
    expect((await getSettings())['matching.maxDistanceKm']).toBe(50);
    const result = await updateSettings('admin', {
      'matching.maxDistanceKm': 20,
      'matching.weights': { ...DEFAULT_MATCHING_WEIGHTS, transport: 0.3 },
    });
    expect(result.settings.find((s) => s.key === 'matching.maxDistanceKm')).toMatchObject({ value: 20, default: 50, overridden: true });
    const config = await loadMatchingConfig();
    expect(config.maxDistanceKm).toBe(20);
    expect(config.weights.transport).toBe(0.3);
  });

  it('validates all-or-nothing and supports reset to default with null', async () => {
    const { settings, audits } = makeDb();
    await expect(updateSettings('admin', { 'matching.maxDistanceKm': 20, 'alerts.leadMinutes': 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateSettings('admin', { 'no.such.key': 1 })).rejects.toMatchObject({ statusCode: 400 });
    expect(settings).toHaveLength(0);
    await updateSettings('admin', { 'alerts.leadMinutes': 30 });
    await updateSettings('admin', { 'alerts.leadMinutes': null });
    expect(settings).toHaveLength(0);
    expect(audits.map((a) => a.action)).toEqual(['SETTING_UPDATED', 'SETTING_RESET']);
  });

  it('falls back to defaults when settings cannot be read', async () => {
    vi.mocked(getPrisma).mockReturnValue({} as unknown as PrismaClient);
    expect((await loadMatchingConfig()).maxDistanceKm).toBe(50);
  });
});

describe('ADMIN-05 audit search', () => {
  it('maps filters onto the audit log query', async () => {
    const { client } = makeDb();
    await searchAuditLogs('admin', { entityType: 'Donation', actorId: 'prov', action: 'DONATION_CREATED', from: '2026-09-01', to: '2026-10-01' });
    const where = (client.auditLog as { findMany: { mock: { calls: Array<[{ where: unknown }]> } } }).findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      entityType: 'Donation',
      userId: 'prov',
      action: 'DONATION_CREATED',
      timestamp: { gte: new Date('2026-09-01'), lt: new Date('2026-10-01') },
    });
  });
});

describe('ADMIN HTTP surface', () => {
  it('admin routes are admin-only; incident filing is open to every signed-in user', async () => {
    makeDb();
    const app = createApp();
    for (const path of ['/api/admin/users', '/api/admin/monitoring', '/api/admin/audit-logs', '/api/admin/incidents', '/api/admin/settings']) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).set('Authorization', `Bearer ${token('prov', 'PROVIDER')}`)).status).toBe(403);
    }
    const filed = await request(app)
      .post('/api/incidents')
      .set('Authorization', `Bearer ${token('rec', 'RECIPIENT')}`)
      .send({ type: 'ACCOUNT_REPORT', subjectUserId: 'prov', reason: 'No-show', description: 'Did not show up for pickup.' });
    expect(filed.status).toBe(201);
    const mine = await request(app).get('/api/incidents').set('Authorization', `Bearer ${token('rec', 'RECIPIENT')}`);
    expect(mine.status).toBe(200);
  });

  it('validates admin bodies before the service', async () => {
    makeDb();
    const app = createApp();
    const res = await request(app)
      .put('/api/admin/users/prov/status')
      .set('Authorization', `Bearer ${token('admin', 'ADMIN')}`)
      .send({ status: 'BANNED' });
    expect(res.status).toBe(400);
  });
});
