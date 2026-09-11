import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, it, expect } from 'vitest';
import { authenticate } from '../middleware/auth';
import { errorMiddleware } from '../middleware/error';
import { env } from '../config/env';

function createAuthApp() {
  const app = express();
  app.use(express.json());
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());
  app.get('/protected', authenticate, (req, res) => {
    res.json({ success: true, data: { user: req.user } });
  });
  app.use(errorMiddleware);
  return app;
}

describe('BE-07 Hardening — claim validation + algorithm', () => {
  it('numeric id claim → 401 standardized', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 12345 as unknown as string, email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(res.body)).not.toContain('12345');
  });

  it('object email claim → 401', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-1', email: { x: 1 } as unknown as string, role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('invalid role → 401', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-1', email: 'a@test.com', role: 'SUPERADMIN' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('array organizationId → 401', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-1', email: 'a@test.com', role: 'PROVIDER', organizationId: ['org-1'] as unknown as string }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  function createManualToken(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = require('crypto').createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }

  it('invalid iat type (string) → 401', async () => {
    const app = createAuthApp();
    const token = createManualToken({ id: 'user-1', email: 'a@test.com', role: 'PROVIDER', iat: 'not-a-number', exp: Math.floor(Date.now() / 1000) + 900 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('invalid exp type (string) → 401', async () => {
    const app = createAuthApp();
    const token = createManualToken({ id: 'user-1', email: 'a@test.com', role: 'PROVIDER', iat: Math.floor(Date.now() / 1000), exp: 'not-number' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  const allowedRoles = ['PROVIDER', 'RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const;
  for (const role of allowedRoles) {
    it(`valid claims for role ${role} → success`, async () => {
      const app = createAuthApp();
      const token = jwt.sign({ id: 'user-1', email: 'a@test.com', role }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe(role);
    });
  }

  it('disallowed JWT algorithm (none) → 401', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-1', email: 'a@test.com', role: 'PROVIDER' }, '', { algorithm: 'none' } as any);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('disallowed algorithm HS384 → 401', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-1', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS384', expiresIn: '15m' } as any);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('existing valid cookie still passes (regression)', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-123', email: 'test@example.com', role: 'PROVIDER', organizationId: 'org-123' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Cookie', `access_token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe('user-123');
  });

  it('existing valid header still passes (regression)', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 'user-123', email: 'test@example.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('standardized error envelope still holds for hardened cases', async () => {
    const app = createAuthApp();
    const token = jwt.sign({ id: 999 as unknown as string, email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error).toHaveProperty('message');
  });

  it('no token/secret leakage on hardened rejection', async () => {
    const app = createAuthApp();
    const badPayload = { id: 123 as unknown as string, email: 'a@test.com', role: 'BADROLE' };
    const token = jwt.sign(badPayload as any, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(env.JWT_ACCESS_SECRET);
    expect(bodyStr).not.toContain(token);
    expect(bodyStr).not.toContain('BADROLE');
  });
});
