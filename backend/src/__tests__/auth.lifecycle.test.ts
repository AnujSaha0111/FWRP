import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stateful in-memory Prisma double — no live database. bcrypt/JWT stay REAL,
// and supertest's agent persists cookies, so the full browser-style lifecycle
// (register → login → cookie-authenticated profile → rotation → logout →
// lockout) is proven end to end with one consistent identity.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { env } from '../config/env';

// AUTH-11: authentication integration composition. Unit hash/compare,
// sign/verify, and per-endpoint integration already live in AUTH-01..05 +
// BE-07 suites; this file proves the pieces interoperate as one lifecycle.
// No AUTH-12+ scope, no notification wiring.

const EMAIL = 'lifecycle@example.com';
const PASSWORD = 'lifecycle-pass-1';

const usersByEmail = new Map<string, Record<string, unknown>>();
const usersById = new Map<string, Record<string, unknown>>();
let seq = 0;

function installStatefulPrisma() {
  usersByEmail.clear();
  usersById.clear();
  seq = 0;
  const findUnique = vi.fn(async (args: { where: Record<string, string>; include?: unknown }) => {
    const row =
      (args.where.email ? usersByEmail.get(args.where.email) : undefined) ??
      (args.where.id ? usersById.get(args.where.id) : undefined) ??
      null;
    if (!row) return null;
    return args.include ? { ...row, organization: null } : { ...row };
  });
  const tx = {
    organization: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: `org-${++seq}`, ...args.data })),
    },
    user: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `user-${++seq}`,
          status: 'ACTIVE',
          organizationId: null,
          tokenVersion: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.data,
        };
        usersByEmail.set(row.email as string, row);
        usersById.set(row.id as string, row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...(usersById.get(args.where.id) as Record<string, unknown>), ...args.data };
        usersByEmail.set(row.email as string, row);
        usersById.set(row.id as string, row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: `log-${++seq}`, ...args.data })),
    },
  };
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient);
}

beforeEach(() => {
  vi.clearAllMocks();
  installStatefulPrisma();
});

function cookieValue(res: request.Response, name: string): string | undefined {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const found = cookies?.find((c) => c.startsWith(`${name}=`));
  return found?.split(';')[0].slice(name.length + 1);
}

describe('AUTH-11 full auth lifecycle over one identity', () => {
  it('register → duplicate/weak rejections → login → cookie profile → rotation → logout → lockout', async () => {
    const app = createApp();
    const agent = request.agent(app);

    // 1. Register (hash/compare unit behavior engaged for real inside).
    const reg = await agent.post('/api/auth/register').send({
      name: 'Lifecycle User',
      email: EMAIL,
      phone: '+1 555-010-0000',
      password: PASSWORD,
      role: 'VOLUNTEER',
    });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.email).toBe(EMAIL);

    // 2. Duplicate email 409 + weak password 400 on the same identity.
    const dup = await agent.post('/api/auth/register').send({
      name: 'Clone',
      email: EMAIL,
      phone: '+1 555-010-0001',
      password: PASSWORD,
      role: 'VOLUNTEER',
    });
    expect(dup.status).toBe(409);
    const weak = await request(app).post('/api/auth/register').send({
      name: 'Weak',
      email: 'weak@example.com',
      phone: '+1 555-010-0002',
      password: 'short',
      role: 'VOLUNTEER',
    });
    expect(weak.status).toBe(400);

    // 3. Bad password 401, then login 200 with matching cookie + body tokens.
    const bad = await agent.post('/api/auth/login').send({ email: EMAIL, password: 'wrong-pass' });
    expect(bad.status).toBe(401);
    const login = await agent.post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(cookieValue(login, 'access_token')).toBe(login.body.data.accessToken);
    expect(cookieValue(login, 'refresh_token')).toBe(login.body.data.refreshToken);

    // 4. Cookie-authenticated profile read (no manual header).
    const me = await agent.get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(EMAIL);

    // 5. Rotation via persisted cookie jar; new pair verifies under BE-07 rules.
    const rotated = await agent.post('/api/auth/refresh');
    expect(rotated.status).toBe(200);
    const access = jwt.verify(rotated.body.data.accessToken, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
    }) as Record<string, unknown>;
    expect(access.email).toBe(EMAIL);
    expect(cookieValue(rotated, 'access_token')).toBe(rotated.body.data.accessToken);

    // 6. Logout clears the jar; the identity is locked out afterwards.
    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);
    const afterMe = await agent.get('/api/users/me');
    expect(afterMe.status).toBe(401);
    const afterRefresh = await agent.post('/api/auth/refresh');
    expect(afterRefresh.status).toBe(401);
  });

  it('no response in the lifecycle leaks hash, password, or secrets', async () => {
    const app = createApp();
    const agent = request.agent(app);
    const bodies: string[] = [];
    bodies.push(JSON.stringify((await agent.post('/api/auth/register').send({
      name: 'Clean User', email: 'clean@example.com', phone: '+1 555-010-0003', password: PASSWORD, role: 'VOLUNTEER',
    })).body));
    bodies.push(JSON.stringify((await agent.post('/api/auth/login').send({ email: 'clean@example.com', password: 'bad' })).body));
    bodies.push(JSON.stringify((await agent.post('/api/auth/login').send({ email: 'clean@example.com', password: PASSWORD })).body));
    bodies.push(JSON.stringify((await agent.get('/api/users/me')).body));
    bodies.push(JSON.stringify((await agent.post('/api/auth/refresh')).body));
    const blob = bodies.join('\n');
    expect(blob).not.toContain('passwordHash');
    expect(blob).not.toContain(PASSWORD);
    expect(blob).not.toContain('bad');
  });
});
