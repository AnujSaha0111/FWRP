import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. Validation, hashing, and
// the ORM-boundary behavior below are exercised for real.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { registerSchema } from '../services/auth.service';
import { signAccessToken } from '../utils/jwt';

// AUTH-10: input validation & security matrix — uniqueness, strength, format,
// injection-as-data (XSS/SQL treated as inert bound values via the ORM), and
// no sensitive data in logs/errors. No AUTH-11+ features.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');

const PASSWORD = 'Strong-pass-1';
let storedHash: string;

beforeAll(async () => {
  storedHash = await bcrypt.hash(PASSWORD, 4);
});

function baseUserRow() {
  return {
    id: 'user-1',
    name: 'Alice',
    email: 'taken@example.com',
    phone: '+1 555-123-4567',
    passwordHash: storedHash,
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
}

function mockTx() {
  const userCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...baseUserRow(), ...args.data }));
  const userUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...baseUserRow(), ...args.data }));
  const orgCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'org-1', ...args.data }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  return {
    userCreate,
    userUpdate,
    tx: {
      user: { create: userCreate, update: userUpdate },
      organization: { create: orgCreate },
      auditLog: { create: auditCreate },
    },
  };
}

const volunteerBase = {
  name: 'Vic Volunteer',
  email: 'vic@example.com',
  phone: '+1 555-000-0000',
  password: PASSWORD,
  role: 'VOLUNTEER' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-10 email uniqueness matrix', () => {
  it('rejects exact and case-variant duplicates with 409 before any write', async () => {
    const { userCreate, tx } = mockTx();
    const findUnique = vi.fn(async (args: { where: { email: string } }) =>
      args.where.email === 'taken@example.com' ? baseUserRow() : null,
    );
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient);
    const app = createApp();
    for (const email of ['taken@example.com', 'TAKEN@Example.COM', '  Taken@Example.com  ']) {
      const res = await request(app).post('/api/auth/register').send({ ...volunteerBase, email });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    }
    expect(userCreate).not.toHaveBeenCalled();
  });

  it('maps the uniqueness race (P2002) to the same 409', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' });
      }),
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app).post('/api/auth/register').send(volunteerBase);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('AUTH-10 password strength matrix', () => {
  it('accepts only 8-128 char passwords at the schema boundary', () => {
    const good = { ...volunteerBase, password: '12345678' };
    expect(registerSchema.safeParse(good).success).toBe(true);
    expect(registerSchema.safeParse({ ...volunteerBase, password: 'x'.repeat(128) }).success).toBe(true);
    for (const password of ['', '1234567', 'x'.repeat(129), undefined, 12345]) {
      expect(registerSchema.safeParse({ ...volunteerBase, password } as never).success).toBe(false);
    }
  });

  it('rejects weak passwords at the route with 400 and no DB touch', async () => {
    const findUnique = vi.fn();
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    const app = createApp();
    for (const password of ['short', 'x'.repeat(129)]) {
      const res = await request(app).post('/api/auth/register').send({ ...volunteerBase, password });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('AUTH-10 phone format matrix', () => {
  it('accepts international, spaced, dashed, and parenthesized numbers', async () => {
    const { tx } = mockTx();
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient);
    const app = createApp();
    for (const phone of ['+1 555-123-4567', '5551234567', '(555) 123-4567', '+44 20 7946 0018']) {
      const res = await request(app).post('/api/auth/register').send({ ...volunteerBase, phone });
      expect(res.status).toBe(201);
    }
  });

  it('rejects letters, too-short, too-long, and empty phones', async () => {
    const findUnique = vi.fn();
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    const app = createApp();
    for (const phone of ['call-me-maybe', '12345', '1'.repeat(25), '', '+1 (555) ABC-DEF0']) {
      const res = await request(app).post('/api/auth/register').send({ ...volunteerBase, phone });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('AUTH-10 injection treated as inert data (ORM boundary)', () => {
  it('rejects SQL text as a login email before any lookup', async () => {
    const findUnique = vi.fn();
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique },
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: `' OR '1'='1`, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('compares SQL text as a password via bcrypt (deterministic 401, never executed)', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => baseUserRow()) },
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'taken@example.com', password: `' OR '1'='1'; DROP TABLE users;--` });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('stores XSS text verbatim as a bound value (never interpolated, never executed)', async () => {
    const { userCreate, tx } = mockTx();
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient);
    const app = createApp();
    const xss = `<script>alert('xss')</script>`;
    const res = await request(app).post('/api/auth/register').send({ ...volunteerBase, name: xss });
    expect(res.status).toBe(201);
    // The exact string reaches the ORM as data; nothing strips, runs, or echoes it elsewhere.
    expect(userCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ name: xss }) });
    expect(res.body.data.user.name).toBe(xss);
  });

  it('stores SQL text verbatim on profile update (parameterized, inert)', async () => {
    const userUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...baseUserRow(), ...args.data }));
    const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
    const tx = { user: { update: userUpdate }, auditLog: { create: auditCreate } };
    vi.mocked(getPrisma).mockReturnValue({
      user: {
        findUnique: vi.fn(async () => ({ ...baseUserRow(), organization: null })),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient);
    const app = createApp();
    const token = signAccessToken({ id: 'user-1', email: 'taken@example.com', role: 'VOLUNTEER', organizationId: null });
    const sql = `'; DROP TABLE users;--`;
    const res = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: sql });
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { name: sql } });
    expect(res.body.data.user.name).toBe(sql);
  });
});

describe('AUTH-10 no sensitive data in logs or error details', () => {
  it('auth/user/org/notification layers never import a logger or console', () => {
    for (const file of [
      'src/services/auth.service.ts',
      'src/services/users.service.ts',
      'src/services/organizations.service.ts',
      'src/services/notification.service.ts',
      'src/controllers/auth.controller.ts',
      'src/controllers/users.controller.ts',
      'src/controllers/organizations.controller.ts',
    ]) {
      const text = fs.readFileSync(path.join(backendDir, file), 'utf8');
      expect(text).not.toContain('utils/logger');
      expect(text).not.toContain('console.');
    }
  });

  it('validation details never echo the rejected secrets', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app).post('/api/auth/register').send({
      ...volunteerBase,
      email: 'not-an-email-marker-xyz',
      password: 'Zz9!Marker',
    });
    expect(res.status).toBe(400);
    const blob = JSON.stringify(res.body.error.details ?? res.body);
    expect(blob).not.toContain('not-an-email-marker-xyz');
    expect(blob).not.toContain('Zz9!Marker');
  });

  it('auth failure envelopes never carry attempted credentials', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'Attempted-Pass-9' });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('Attempted-Pass-9');
  });
});
