import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

// BE-04: API structure and route mounting. Structure only — placeholders must
// answer 501 (never fake business success). No live DB, SMTP, or network.

const PLACEHOLDER_PREFIXES = [
  '/api/matches',
  '/api/deliveries',
  '/api/analytics',
  '/api/notifications',
];

describe('BE-04 API structure', () => {
  it('initializes the application and keeps /api/health reachable', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('fwrp-backend');
  });

  it.each(PLACEHOLDER_PREFIXES)('mounts %s as an honest placeholder (501, no fake business data)', async (prefix) => {
    const app = createApp();
    const res = await request(app).get(prefix);
    expect(res.status).toBe(501);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.data).toBeUndefined();
  });

  it('placeholders answer 501 for any method and nested path without crashing', async () => {
    const app = createApp();
    const post = await request(app).post('/api/matches').send({ foodCategory: 'Vegetables' });
    expect(post.status).toBe(501);
    expect(post.body.error.code).toBe('NOT_IMPLEMENTED');
    const nested = await request(app).get('/api/notifications/unread-count');
    expect(nested.status).toBe(501);
    expect(nested.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('auth router serves real endpoints (placeholder retired by AUTH-01)', async () => {
    const app = createApp();
    // Only POST /register is mounted; bare prefix falls through to 404.
    const res = await request(app).get('/api/auth');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('admin router serves real endpoints (placeholder retired by AUTH-06)', async () => {
    const app = createApp();
    // Only PUT /users/:id/password is mounted; bare prefix falls through to 404.
    const res = await request(app).get('/api/admin');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('donations router serves the authenticated listing endpoint (placeholder retired by DON-06)', async () => {
    const app = createApp();
    // GET / (DON-06 listing) is live and requires authentication; an
    // unauthenticated request is rejected before any handler runs.
    const res = await request(app).get('/api/donations');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('requirements router serves the authenticated creation endpoint (placeholder retired by REQ-01)', async () => {
    const app = createApp();
    // POST / (REQ-01 creation) is live and requires authentication; an
    // unauthenticated request is rejected before any handler runs.
    const res = await request(app).post('/api/requirements').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('placeholders require no authentication (structure only, no auth rules yet)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/matches');
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('mounts the notifications router without touching a live database', async () => {
    const app = createApp();
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(501);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('preserves 404 handling and the error envelope for unknown routes', async () => {
    const app = createApp();
    const res = await request(app).get('/api/no-such-area');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('leaks no internals from placeholder errors', async () => {
    const app = createApp();
    const res = await request(app).get('/api/deliveries');
    const blob = JSON.stringify(res.body);
    expect(res.status).toBe(501);
    expect(blob).not.toMatch(/stack|at .*\(.*\)|prisma|postgres|secret|password|jwt/i);
    expect(res.body.error.stack).toBeUndefined();
  });
});
