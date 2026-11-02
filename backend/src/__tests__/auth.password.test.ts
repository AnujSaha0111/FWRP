import request from 'supertest';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Prisma is mocked — hashing, cost policy, and secrecy are exercised for real.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import {
  hashPassword,
  resolveBcryptCost,
  BCRYPT_COST,
  BCRYPT_MIN_PRODUCTION_COST,
} from '../services/auth.service';

// AUTH-04: password hashing — cost factor verified, hash never logged or
// returned, hash proven not to be plaintext. No AUTH-05+ features.

const PASSWORD = 'verify-this-password-9';
const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([k, v]) => k === key || containsKey(v, key));
  }
  return false;
}

let userRow: Record<string, unknown>;

beforeAll(async () => {
  userRow = {
    id: 'user-1',
    name: 'Alice Provider',
    email: 'alice@example.com',
    phone: '+1 555-123-4567',
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
});

function mockPrismaForRegister() {
  const orgCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'org-1',
    verificationStatus: 'PENDING',
    ...args.data,
  }));
  const userCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'user-1',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...args.data,
  }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  const mockTx = { organization: { create: orgCreate }, user: { create: userCreate }, auditLog: { create: auditCreate } };
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: vi.fn(async () => null) },
    organization: { create: vi.fn() },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  } as unknown as PrismaClient);
}

function mockPrismaForLogin() {
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: vi.fn(async () => userRow) },
  } as unknown as PrismaClient);
}

const registerBody = {
  name: 'Alice Provider',
  email: 'alice@example.com',
  phone: '+1 555-123-4567',
  password: PASSWORD,
  role: 'PROVIDER',
  orgName: 'Good Food Org',
  address: '12 Market Street',
  latitude: 12.97,
  longitude: 77.59,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-04 hashing cost factor', () => {
  it('enforces a production floor of 10 with a documented fast test cost', () => {
    expect(BCRYPT_MIN_PRODUCTION_COST).toBe(10);
    expect(resolveBcryptCost('production')).toBeGreaterThanOrEqual(BCRYPT_MIN_PRODUCTION_COST);
    expect(resolveBcryptCost('production')).toBe(10);
    expect(resolveBcryptCost('development')).toBe(10);
    expect(resolveBcryptCost('test')).toBe(4);
    expect(BCRYPT_COST).toBe(resolveBcryptCost());
  });

  it('hashes carry the configured cost factor', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
    expect(bcrypt.getRounds(hash)).toBeGreaterThanOrEqual(4);
  });
});

describe('AUTH-04 hash is not plaintext', () => {
  it('proves the stored value is a salted bcrypt hash, not the password', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).not.toBe(PASSWORD);
    expect(first).toMatch(/^\$2[aby]\$\d{2}\$.{53}$/);
    // Salted: same password yields distinct hashes, both verifiable.
    expect(second).not.toBe(first);
    expect(await bcrypt.compare(PASSWORD, first)).toBe(true);
    expect(await bcrypt.compare('wrong-password', first)).toBe(false);
  });
});

describe('AUTH-04 password_hash is never returned', () => {
  it('register and login responses contain no hash key and no plaintext password', async () => {
    mockPrismaForRegister();
    const app = createApp();
    const reg = await request(app).post('/api/auth/register').send(registerBody);
    expect(reg.status).toBe(201);
    expect(containsKey(reg.body, 'passwordHash')).toBe(false);
    expect(containsKey(reg.body, 'password')).toBe(false);
    expect(JSON.stringify(reg.body)).not.toContain(PASSWORD);

    mockPrismaForLogin();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(containsKey(login.body, 'passwordHash')).toBe(false);
    expect(containsKey(login.body, 'password')).toBe(false);
    expect(JSON.stringify(login.body)).not.toContain(PASSWORD);
  });

  it('error envelopes never carry hashes or passwords', async () => {
    mockPrismaForRegister();
    const app = createApp();
    const invalid = await request(app).post('/api/auth/register').send({ ...registerBody, email: 'bad' });
    expect(invalid.status).toBe(400);
    const blob = JSON.stringify(invalid.body);
    expect(containsKey(invalid.body, 'passwordHash')).toBe(false);
    expect(blob).not.toContain(PASSWORD);
  });
});

describe('AUTH-04 password_hash is never logged', () => {
  it('auth service and controller cannot log secrets (no logger dependency)', () => {
    for (const file of ['src/services/auth.service.ts', 'src/controllers/auth.controller.ts']) {
      const text = fs.readFileSync(path.join(backendDir, file), 'utf8');
      expect(text).not.toContain('utils/logger');
      expect(text).not.toContain('console.');
    }
  });
});
