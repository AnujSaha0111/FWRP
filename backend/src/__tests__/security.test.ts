import express from 'express';
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
import { errorMiddleware } from '../middleware/error';
import { ipAndEmailKey, rateLimit } from '../middleware/rateLimit';
import { createEmailService, MockEmailProvider } from '../services/email.service';
import {
  FORGOT_PASSWORD_RESPONSE,
  hashResetToken,
  requestPasswordReset,
  resetPassword,
} from '../services/passwordReset.service';

// SEC-01 rate limiting, SEC-02 password reset by email.

const NOW = new Date('2026-09-20T12:00:00.000Z');

beforeEach(() => {
  vi.mocked(getPrisma).mockReset();
});

// ---------------------------------------------------------------------------

describe('SEC-01 rate limiter', () => {
  function appWith(limiter: ReturnType<typeof rateLimit>) {
    const app = express();
    app.use(express.json());
    app.post('/x', limiter, (_req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);
    return app;
  }

  it('allows max requests per window, then answers 429 with Retry-After', async () => {
    let t = 0;
    const app = appWith(rateLimit({ name: 't', windowMs: 60_000, max: 3, enabled: true, now: () => t }));
    for (let i = 0; i < 3; i++) expect((await request(app).post('/x')).status).toBe(200);
    const blocked = await request(app).post('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBe('60');
    t = 60_000; // window over
    expect((await request(app).post('/x')).status).toBe(200);
  });

  it('keys per account when given an email key, so one account cannot lock out others', async () => {
    const app = appWith(rateLimit({ name: 'acct', windowMs: 60_000, max: 1, enabled: true, key: ipAndEmailKey }));
    expect((await request(app).post('/x').send({ email: 'A@x.com' })).status).toBe(200);
    expect((await request(app).post('/x').send({ email: 'a@x.com ' })).status).toBe(429);
    expect((await request(app).post('/x').send({ email: 'b@x.com' })).status).toBe(200);
    // No email → this limiter does not apply.
    expect((await request(app).post('/x').send({})).status).toBe(200);
  });

  it('is a no-op when disabled', async () => {
    const app = appWith(rateLimit({ name: 'off', windowMs: 60_000, max: 0, enabled: false }));
    expect((await request(app).post('/x')).status).toBe(200);
  });

  it('is wired onto the auth routes (disabled under NODE_ENV=test)', async () => {
    const fs = await import('node:fs');
    const routes = fs.readFileSync(new URL('../routes/auth.ts', import.meta.url), 'utf8');
    for (const limiter of ['limits.loginPerIp', 'limits.loginPerAccount', 'limits.register', 'limits.refresh', 'limits.forgotPerAccount', 'limits.resetPerIp']) {
      expect(routes).toContain(limiter);
    }
  });
});

// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

function resetStore(user: Row | null) {
  const tokens: Row[] = [];
  const audits: Row[] = [];
  const users = user ? [user] : [];
  const client = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) =>
        users.find((u) => u.email === where.email || u.id === where.id) ?? null
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id)!;
        u.passwordHash = data.passwordHash;
        u.tokenVersion = (u.tokenVersion as number) + 1;
        return u;
      }),
    },
    passwordResetToken: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `t${tokens.length + 1}`, usedAt: null, ...data };
        tokens.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const t = tokens.find((x) => x.tokenHash === where.tokenHash);
        return t ? { ...t, user: { status: users.find((u) => u.id === t.userId)?.status } } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = tokens.filter(
          (t) =>
            (!where.id || t.id === where.id) &&
            (!where.userId || t.userId === where.userId) &&
            t.usedAt === null &&
            (!where.expiresAt || (t.expiresAt as Date) > (where.expiresAt as { gt: Date }).gt)
        );
        hits.forEach((t) => Object.assign(t, data));
        return { count: hits.length };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: Row }) => (audits.push(data), data)) },
  } as Record<string, unknown>;
  client.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client));
  return { client: client as unknown as PrismaClient, tokens, audits, users };
}

function rawTokenFrom(provider: MockEmailProvider): string {
  const text = provider.getCaptured().at(-1)!.text as string;
  return new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
}

const ALICE: Row = {
  id: 'u1',
  name: 'Alice',
  email: 'alice@example.com',
  status: 'ACTIVE',
  passwordHash: 'old-hash',
  tokenVersion: 0,
};

describe('SEC-02 password reset', () => {
  it('forgot: same answer for known, unknown and suspended emails; only active accounts get mail', async () => {
    for (const user of [null, { ...ALICE, status: 'SUSPENDED' }]) {
      const { client, tokens } = resetStore(user);
      const provider = new MockEmailProvider();
      expect(await requestPasswordReset({ email: 'alice@example.com' }, NOW, createEmailService(provider), client)).toEqual(FORGOT_PASSWORD_RESPONSE);
      expect(provider.getCaptured()).toHaveLength(0);
      expect(tokens).toHaveLength(0);
    }
    const { client, tokens } = resetStore({ ...ALICE });
    const provider = new MockEmailProvider();
    expect(await requestPasswordReset({ email: ' Alice@Example.com ' }, NOW, createEmailService(provider), client)).toEqual(FORGOT_PASSWORD_RESPONSE);
    expect(provider.getCaptured()).toHaveLength(1);
    expect(provider.getCaptured()[0]).toMatchObject({ to: 'alice@example.com', type: 'PASSWORD_RESET' });
    // Only the hash is stored.
    const raw = rawTokenFrom(provider);
    expect(tokens[0].tokenHash).toBe(hashResetToken(raw));
    expect(JSON.stringify(tokens)).not.toContain(raw);
  });

  it('a new request invalidates the previous link', async () => {
    const { client, tokens } = resetStore({ ...ALICE });
    const provider = new MockEmailProvider();
    const email = createEmailService(provider);
    await requestPasswordReset({ email: 'alice@example.com' }, NOW, email, client);
    const first = rawTokenFrom(provider);
    await requestPasswordReset({ email: 'alice@example.com' }, NOW, email, client);
    expect(tokens[0].usedAt).toEqual(NOW);
    await expect(resetPassword({ token: first, newPassword: 'new-password-1' }, NOW, client)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  it('reset: changes the password, ends all sessions and cannot be reused', async () => {
    const { client, users, audits } = resetStore({ ...ALICE });
    const provider = new MockEmailProvider();
    await requestPasswordReset({ email: 'alice@example.com' }, NOW, createEmailService(provider), client);
    const raw = rawTokenFrom(provider);
    expect(await resetPassword({ token: raw, newPassword: 'new-password-1' }, NOW, client)).toEqual({ reset: true });
    expect(users[0].passwordHash).not.toBe('old-hash');
    expect(users[0].tokenVersion).toBe(1);
    expect(audits.map((a) => a.action)).toContain('PASSWORD_RESET_COMPLETED');
    await expect(resetPassword({ token: raw, newPassword: 'another-pass-2' }, NOW, client)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects expired links, unknown tokens and weak passwords', async () => {
    const { client } = resetStore({ ...ALICE });
    const provider = new MockEmailProvider();
    await requestPasswordReset({ email: 'alice@example.com' }, NOW, createEmailService(provider), client);
    const raw = rawTokenFrom(provider);
    const later = new Date(NOW.getTime() + 31 * 60 * 1000);
    await expect(resetPassword({ token: raw, newPassword: 'new-password-1' }, later, client)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    await expect(resetPassword({ token: 'x'.repeat(43), newPassword: 'new-password-1' }, NOW, client)).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    await expect(resetPassword({ token: raw, newPassword: 'short' }, NOW, client)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('routes: forgot answers 202 without auth; reset validates its body', async () => {
    const { client } = resetStore(null);
    vi.mocked(getPrisma).mockReturnValue(client);
    const app = createApp();
    const forgot = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(forgot.status).toBe(202);
    expect(forgot.body.data).toEqual(FORGOT_PASSWORD_RESPONSE);
    expect((await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password').send({ token: 'x' })).status).toBe(400);
  });
});
