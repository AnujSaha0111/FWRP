import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, it, expect } from 'vitest';
import { authenticate } from '../middleware/auth';
import { requireRole, requireVerifiedOrg, requireOwnership } from '../middleware/rbac';
import { errorMiddleware } from '../middleware/error';
import { env } from '../config/env';
import type { Role } from '@prisma/client';

function createAppWithRole(allowedRoles: Role[], user: any) {
  const app = express();
  app.use(express.json());
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());
  // Inject user directly without JWT verification to prove requireRole doesn't verify
  app.use((req, _res, next) => {
    if (user) (req as any).user = user;
    next();
  });
  app.get('/protected', requireRole(...allowedRoles), (req, res) => {
    res.json({ success: true, data: { user: req.user } });
  });
  app.use(errorMiddleware);
  return app;
}

function createAuthRoleApp(allowedRoles: Role[]) {
  const app = express();
  app.use(express.json());
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());
  app.get('/protected', authenticate, requireRole(...allowedRoles), (req, res) => {
    res.json({ success: true, data: { user: req.user } });
  });
  app.use(errorMiddleware);
  return app;
}

describe('BE-08 requireRole', () => {
  it('authenticated user with allowed role → success', async () => {
    const app = createAuthRoleApp(['ADMIN' as Role]);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'ADMIN' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('authenticated user with disallowed role → 403 FORBIDDEN', async () => {
    const app = createAuthRoleApp(['ADMIN' as Role]);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('multiple allowed roles → each permitted role succeeds', async () => {
    for (const role of ['ADMIN', 'VOLUNTEER'] as Role[]) {
      const app = createAuthRoleApp(['ADMIN' as Role, 'VOLUNTEER' as Role]);
      const token = jwt.sign({ id: 'u1', email: 'a@test.com', role }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
      const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    }
  });

  it('missing req.user → 401 UNAUTHORIZED', async () => {
    const app = createAppWithRole(['ADMIN' as Role], null);
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('requireRole does not perform JWT verification itself', async () => {
    // No JWT at all, but manually injected user should still pass requireRole
    const app = createAppWithRole(['ADMIN' as Role], { id: 'u1', email: 'a@test.com', role: 'ADMIN' });
    const res = await request(app).get('/protected');
    expect(res.status).toBe(200);
    // Also ensure that an invalid JWT does not affect requireRole when user is injected
    const app2 = createAppWithRole(['ADMIN' as Role], { id: 'u1', email: 'a@test.com', role: 'ADMIN' });
    const res2 = await request(app2).get('/protected').set('Authorization', 'Bearer invalid.token.here');
    expect(res2.status).toBe(200);
  });

  it('standardized 403 envelope', async () => {
    const app = createAuthRoleApp(['ADMIN' as Role]);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toHaveProperty('code', 'FORBIDDEN');
    expect(res.body.error).toHaveProperty('message');
    expect(res.status).toBe(403);
  });

  it('no token/secret leakage on 403', async () => {
    const app = createAuthRoleApp(['ADMIN' as Role]);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(env.JWT_ACCESS_SECRET);
    expect(body).not.toContain(token);
  });
});

describe('BE-08 requireVerifiedOrg', () => {
  it('verified organization → success', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    const mockGetOrg = async () => ({ verificationStatus: 'VERIFIED' });
    app.get('/protected', authenticate, requireVerifiedOrg(mockGetOrg), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER', organizationId: 'org-1' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('unverified organization → 403', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    const mockGetOrg = async () => ({ verificationStatus: 'PENDING' });
    app.get('/protected', authenticate, requireVerifiedOrg(mockGetOrg), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER', organizationId: 'org-1' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('missing organizationId → 403', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    const mockGetOrg = async () => ({ verificationStatus: 'VERIFIED' });
    app.get('/protected', authenticate, requireVerifiedOrg(mockGetOrg), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('organization not found → 403', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    const mockGetOrg = async () => null;
    app.get('/protected', authenticate, requireVerifiedOrg(mockGetOrg), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER', organizationId: 'org-1' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('missing req.user → 401', async () => {
    const app = express();
    app.use(express.json());
    app.get('/protected', requireVerifiedOrg(async () => ({ verificationStatus: 'VERIFIED' })), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('standardized envelope and no leakage', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    const mockGetOrg = async () => ({ verificationStatus: 'PENDING' });
    app.get('/protected', authenticate, requireVerifiedOrg(mockGetOrg), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'u1', email: 'a@test.com', role: 'PROVIDER', organizationId: 'org-1' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(env.JWT_ACCESS_SECRET);
    expect(body).not.toContain(token);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('BE-08 requireOwnership', () => {
  it('owner → success', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    app.get('/resource/:id', authenticate, requireOwnership((req) => req.params.id), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'owner-123', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/resource/owner-123').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('non-owner → 403', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    app.get('/resource/:id', authenticate, requireOwnership((req) => req.params.id), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'owner-123', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/resource/other-id').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('missing ownership context → 400 VALIDATION_ERROR', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    app.get('/resource', authenticate, requireOwnership(() => null), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'owner-123', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/resource').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('missing req.user → 401', async () => {
    const app = express();
    app.use(express.json());
    app.get('/resource', requireOwnership(() => 'some-id'), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const res = await request(app).get('/resource');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('no sensitive resource information leaked', async () => {
    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    app.get('/resource/:id', authenticate, requireOwnership((req) => req.params.id), (req, res) => res.json({ success: true }));
    app.use(errorMiddleware);
    const token = jwt.sign({ id: 'owner-123', email: 'a@test.com', role: 'PROVIDER' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
    const res = await request(app).get('/resource/other-id').set('Authorization', `Bearer ${token}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('owner-123');
    expect(body).not.toContain(token);
    expect(body).not.toContain(env.JWT_ACCESS_SECRET);
  });
});
