import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. Tokens and middleware are
// REAL, so authentication ordering and authorization are genuinely exercised.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';
import { env } from '../config/env';

// AUTH-12: authorization/security tests — 401 vs 403 ordering, role
// violations, cross-organization isolation, and proof that rejected admin
// calls write nothing. Single-token 401/403 unit behavior already lives in
// BE-07/BE-08/AUTH-07; this suite covers multi-identity route-level security.
// No AUTH-13+ scope, no notification wiring.

const ORG_A = { id: 'org-a', name: 'Org A', type: 'NGO', address: '1 A Road', latitude: 1, longitude: 1, contactInformation: null, verificationStatus: 'VERIFIED' };
const ORG_B = { id: 'org-b', name: 'Org B', type: 'NGO', address: '2 B Road', latitude: 2, longitude: 2, contactInformation: null, verificationStatus: 'VERIFIED' };

function userRow(id: string, email: string, role: string, orgId: string | null, org: Record<string, unknown> | null) {
  return {
    id,
    name: `Name ${id}`,
    email,
    phone: '+1 555-000-0000',
    passwordHash: 'bcrypt-hash-placeholder',
    role,
    organizationId: orgId,
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    organization: org,
  };
}

const USERS: Record<string, Record<string, unknown>> = {
  'user-a': userRow('user-a', 'a@example.com', 'PROVIDER', 'org-a', ORG_A),
  'user-b': userRow('user-b', 'b@example.com', 'RECIPIENT', 'org-b', ORG_B),
  'admin-1': userRow('admin-1', 'admin@example.com', 'ADMIN', null, null),
};

function tokenFor(userId: string): string {
  const u = USERS[userId];
  return signAccessToken({
    id: u.id as string,
    email: u.email as string,
    role: u.role as 'PROVIDER' | 'RECIPIENT' | 'VOLUNTEER' | 'ADMIN',
    organizationId: (u.organizationId as string | null) ?? null,
  });
}

function expiredTokenFor(userId: string): string {
  const u = USERS[userId];
  return jwt.sign(
    { id: u.id, email: u.email, role: u.role, organizationId: u.organizationId ?? null, exp: Math.floor(Date.now() / 1000) - 60 },
    env.JWT_ACCESS_SECRET,
    { algorithm: 'HS256' },
  );
}

function installPrisma() {
  const findUnique = vi.fn(async (args: { where: { id: string } }) => USERS[args.where.id] ?? null);
  const userUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({ ...USERS[args.where.id], ...args.data }));
  const orgUpdate = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const org = args.where.id === 'org-a' ? ORG_A : ORG_B;
    return { ...org, ...args.data };
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ user: { update: userUpdate }, organization: { update: orgUpdate }, auditLog: { create: auditCreate } }),
  );
  vi.mocked(getPrisma).mockReturnValue({ user: { findUnique }, $transaction } as unknown as PrismaClient);
  return { findUnique, userUpdate, orgUpdate, auditCreate, $transaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  installPrisma();
});

describe('AUTH-12 401 before 403: authentication precedes authorization', () => {
  it('admin route yields 401 for missing/invalid/expired tokens and 403 only for valid non-admin tokens', async () => {
    const app = createApp();
    const anon = await request(app).put('/api/admin/users/user-b/password').send({ newPassword: 'brand-new-pass-2' });
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');

    const garbage = await request(app)
      .put('/api/admin/users/user-b/password')
      .set('Authorization', 'Bearer not-a-token')
      .send({ newPassword: 'brand-new-pass-2' });
    expect(garbage.status).toBe(401);

    const expired = await request(app)
      .put('/api/admin/users/user-b/password')
      .set('Authorization', `Bearer ${expiredTokenFor('user-a')}`)
      .send({ newPassword: 'brand-new-pass-2' });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('UNAUTHORIZED');

    const forbidden = await request(app)
      .put('/api/admin/users/user-b/password')
      .set('Authorization', `Bearer ${tokenFor('user-a')}`)
      .send({ newPassword: 'brand-new-pass-2' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });

  it('self routes yield 401 (never 403 or 404) for bad tokens', async () => {
    const app = createApp();
    for (const path of ['/api/users/me', '/api/organizations/me'] as const) {
      for (const header of [{}, { Authorization: 'Bearer garbage' }] as const) {
        const req = request(app).get(path);
        if ('Authorization' in header) req.set(header);
        const res = await req;
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    }
  });
});

describe('AUTH-12 cross-organization isolation at the routes', () => {
  it('each identity reads only its own profile and organization', async () => {
    const app = createApp();
    const meA = await request(app).get('/api/users/me').set('Authorization', `Bearer ${tokenFor('user-a')}`);
    expect(meA.status).toBe(200);
    expect(meA.body.data.user).toMatchObject({ id: 'user-a', email: 'a@example.com' });
    expect(JSON.stringify(meA.body)).not.toContain('user-b');
    expect(JSON.stringify(meA.body)).not.toContain('b@example.com');

    const meB = await request(app).get('/api/users/me').set('Authorization', `Bearer ${tokenFor('user-b')}`);
    expect(meB.status).toBe(200);
    expect(meB.body.data.user).toMatchObject({ id: 'user-b', email: 'b@example.com' });

    const orgA = await request(app).get('/api/organizations/me').set('Authorization', `Bearer ${tokenFor('user-a')}`);
    expect(orgA.status).toBe(200);
    expect(orgA.body.data.organization).toMatchObject({ id: 'org-a', name: 'Org A' });
    expect(JSON.stringify(orgA.body)).not.toContain('org-b');

    const orgB = await request(app).get('/api/organizations/me').set('Authorization', `Bearer ${tokenFor('user-b')}`);
    expect(orgB.status).toBe(200);
    expect(orgB.body.data.organization.id).toBe('org-b');
  });

  it('profile and org updates touch only the session organization', async () => {
    const { orgUpdate } = installPrisma();
    const app = createApp();
    const res = await request(app)
      .put('/api/organizations/me')
      .set('Authorization', `Bearer ${tokenFor('user-a')}`)
      .send({ name: 'Org A Renamed' });
    expect(res.status).toBe(200);
    expect(orgUpdate).toHaveBeenCalledTimes(1);
    expect(orgUpdate).toHaveBeenCalledWith({ where: { id: 'org-a' }, data: { name: 'Org A Renamed' } });
    expect(res.body.data.organization.id).toBe('org-a');
  });

  it('ADMIN is global: may reset a user of any organization; members may not touch each other', async () => {
    const { userUpdate, auditCreate } = installPrisma();
    const app = createApp();
    // Cross-org attempt by a non-admin member of another org -> 403, zero writes.
    const cross = await request(app)
      .put('/api/admin/users/user-b/password')
      .set('Authorization', `Bearer ${tokenFor('user-a')}`)
      .send({ newPassword: 'brand-new-pass-2' });
    expect(cross.status).toBe(403);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();

    // Global admin succeeds cross-org with admin-attributed audit.
    const admin = await request(app)
      .put('/api/admin/users/user-b/password')
      .set('Authorization', `Bearer ${tokenFor('admin-1')}`)
      .send({ newPassword: 'brand-new-pass-2' });
    expect(admin.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user-b' }, data: expect.objectContaining({}) });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'admin-1', action: 'PASSWORD_RESET', entityId: 'user-b' }),
    });
  });

  it('rejected admin calls write nothing (no user update, no audit row)', async () => {
    const { userUpdate, auditCreate } = installPrisma();
    const app = createApp();
    for (const token of [tokenFor('user-a'), tokenFor('user-b')]) {
      const res = await request(app)
        .put('/api/admin/users/user-a/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'brand-new-pass-2' });
      expect(res.status).toBe(403);
    }
    expect(userUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('AUTH-12 security envelopes carry no secrets', () => {
  it('401/403/404 bodies contain no tokens or hashes', async () => {
    const app = createApp();
    const bodies: string[] = [];
    const t = tokenFor('user-a');
    bodies.push(JSON.stringify((await request(app).get('/api/users/me')).body));
    bodies.push(JSON.stringify((await request(app).put('/api/admin/users/user-b/password').set('Authorization', `Bearer ${t}`).send({ newPassword: 'x'.repeat(20) })).body));
    bodies.push(JSON.stringify((await request(app).get('/api/organizations/me').set('Authorization', 'Bearer garbage')).body));
    const blob = bodies.join('\n');
    expect(blob).not.toContain(t);
    expect(blob).not.toContain('passwordHash');
    expect(blob).not.toContain(env.JWT_ACCESS_SECRET);
  });
});
