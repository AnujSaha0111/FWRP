import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeAll } from 'vitest';
import { authenticate } from '../middleware/auth';
import { errorMiddleware } from '../middleware/error';
import { env } from '../config/env';

function createAuthApp() {
  const app = express();
  app.use(express.json());
  // cookie parsing is done via header fallback in middleware, but also test with cookie-parser
  // we import cookie-parser for realism
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());
  app.get('/protected', authenticate, (req, res) => {
    res.json({ success: true, data: { user: req.user } });
  });
  app.use(errorMiddleware);
  return app;
}

const basePayload = {
  id: 'user-123',
  email: 'test@example.com',
  role: 'PROVIDER' as const,
  organizationId: 'org-123',
};

describe('BE-07 Authentication Middleware', () => {
  beforeAll(() => {
    // Ensure env secret is set for tests (uses dev default if not set)
    expect(env.JWT_ACCESS_SECRET).toBeDefined();
  });

  it('1. missing token → 401 UNAUTHORIZED', async () => {
    const app = createAuthApp();
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('2. malformed token (not 3 parts) → 401', async () => {
    const app = createAuthApp();
    const res = await request(app).get('/protected').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/Invalid token/i);
  });

  it('2b. malformed token via cookie → 401', async () => {
    const app = createAuthApp();
    const res = await request(app).get('/protected').set('Cookie', 'access_token=malformed.token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('3. invalid signature → 401', async () => {
    const app = createAuthApp();
    const badToken = jwt.sign(basePayload, 'wrong-secret', { expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${badToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/Invalid token/i);
  });

  it('4. expired token → 401 Token expired', async () => {
    const app = createAuthApp();
    const expiredToken = jwt.sign(basePayload, env.JWT_ACCESS_SECRET, { expiresIn: '0s' });
    // wait a tick to ensure expiry
    await new Promise((r) => setTimeout(r, 10));
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('5. valid token → req.user populated and proceeds (via Authorization header)', async () => {
    const app = createAuthApp();
    const token = jwt.sign(basePayload, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.id).toBe(basePayload.id);
  });

  it('5b. valid token via httpOnly cookie → req.user populated', async () => {
    const app = createAuthApp();
    const token = jwt.sign(basePayload, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Cookie', `access_token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(basePayload.id);
  });

  it('6. valid token preserves expected claims correctly', async () => {
    const app = createAuthApp();
    const token = jwt.sign(basePayload, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const user = res.body.data.user;
    expect(user.id).toBe(basePayload.id);
    expect(user.email).toBe(basePayload.email);
    expect(user.role).toBe(basePayload.role);
    expect(user.organizationId).toBe(basePayload.organizationId);
    expect(user.iat).toBeDefined();
    expect(user.exp).toBeDefined();
  });

  it('7. authentication errors use standardized envelope', async () => {
    const app = createAuthApp();
    const res = await request(app).get('/protected');
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    // ensure not 500
    expect(res.status).toBe(401);
  });

  it('8. secrets/tokens are not emitted in error responses', async () => {
    const app = createAuthApp();
    const token = jwt.sign(basePayload, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    // Use bad secret to trigger invalid signature, ensure error does not echo token or secret
    const badToken = jwt.sign(basePayload, 'wrong-secret', { expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${badToken}`);
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('wrong-secret');
    expect(bodyStr).not.toContain(env.JWT_ACCESS_SECRET);
    expect(bodyStr).not.toContain(badToken);
    expect(bodyStr).not.toContain(token);
  });

  it('rejects token with missing required claims → 401', async () => {
    const app = createAuthApp();
    const incomplete = jwt.sign({ id: 'only-id' }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${incomplete}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('does not log token (verify error path does not expose token)', async () => {
    const app = createAuthApp();
    const res = await request(app).get('/protected').set('Authorization', 'Bearer invalid.token.here');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('invalid.token.here');
  });
});
