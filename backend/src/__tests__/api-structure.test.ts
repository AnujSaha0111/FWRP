import request from 'supertest';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app';

// BE-04: API structure and route mounting. Every domain router is live now
// (the last BE-04 placeholders were retired by MATCH-07, LOG-03, NOTIF-01 and
// ANALYTICS-02), so each prefix is mounted and gated by authentication.
// No live DB, SMTP, or network.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');

// [prefix, an authenticated GET that exists under it]
const AUTHENTICATED_ROUTES: Array<[string, string]> = [
  ['/api/donations', '/api/donations'],
  ['/api/requirements', '/api/requirements'],
  ['/api/matches', '/api/matches'],
  ['/api/deliveries', '/api/deliveries'],
  ['/api/notifications', '/api/notifications'],
  ['/api/analytics', '/api/analytics/dashboard'],
  ['/api/volunteers', '/api/volunteers/me/availability'],
  ['/api/categories', '/api/categories'],
  ['/api/users', '/api/users/me'],
  ['/api/organizations', '/api/organizations/me'],
  ['/api/admin', '/api/admin/organizations'],
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

  it.each(AUTHENTICATED_ROUTES)('%s is mounted and requires authentication', async (_prefix, route) => {
    const res = await request(createApp()).get(route);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.data).toBeUndefined();
  });

  it('auth router serves real endpoints; its bare prefix falls through to 404', async () => {
    const res = await request(createApp()).get('/api/auth');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('no placeholder (501) router remains', async () => {
    expect(fs.existsSync(path.join(backendDir, 'src', 'routes', 'placeholder.ts'))).toBe(false);
    const app = createApp();
    for (const [, route] of AUTHENTICATED_ROUTES) {
      const res = await request(app).get(route);
      expect(res.status).not.toBe(501);
    }
  });

  it('preserves 404 handling and the error envelope for unknown routes', async () => {
    const res = await request(createApp()).get('/api/no-such-area');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('leaks no internals from error responses', async () => {
    const app = createApp();
    for (const route of ['/api/analytics/reports', '/api/no-such-area']) {
      const res = await request(app).get(route);
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/stack|at .*\(.*\)|prisma|postgres|secret|password|jwt/i);
      expect(res.body.error.stack).toBeUndefined();
    }
  });
});
