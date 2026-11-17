import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../createApp';

// Mock prisma healthCheckDb to control DB states without live DB
vi.mock('../lib/prisma', async () => {
  const actual = await vi.importActual<typeof import('../lib/prisma')>('../lib/prisma');
  return {
    ...actual,
    healthCheckDb: vi.fn(),
  };
});

import { healthCheckDb } from '../lib/prisma';

describe('BE-11 Health endpoint — focused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successful health response with expected envelope shape', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: true, latencyMs: 5 });
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('status', 'ok');
    expect(res.body.data).toHaveProperty('service', 'fwrp-backend');
    expect(res.body.data).toHaveProperty('version');
    expect(res.body.data).toHaveProperty('timestamp');
    expect(res.body.data).toHaveProperty('db');
    // timestamp should be ISO string
    expect(() => new Date(res.body.data.timestamp).toISOString()).not.toThrow();
  });

  it('database health when configured and up → db: up', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: true, latencyMs: 12 });
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.db).toMatch(/up/);
    expect(res.body.data.db).toMatch(/12ms/);
  });

  it('database-unconfigured → db: not-configured', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: false, error: 'not-configured' });
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.db).toBe('not-configured');
  });

  it('database error → db contains error but still 200 (health endpoint remains available)', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: false, error: 'connection refused' });
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.db).toBe('connection refused');
  });

  it('appropriate HTTP status: health always 200 even when DB down', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: false, error: 'not-configured' });
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('no sensitive configuration values are leaked in health response', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: true, latencyMs: 1 });
    const app = createApp();
    const res = await request(app).get('/api/health');
    const bodyStr = JSON.stringify(res.body);
    // Should not contain secrets
    expect(bodyStr).not.toContain('JWT_ACCESS_SECRET');
    expect(bodyStr).not.toContain('DATABASE_URL');
    expect(bodyStr).not.toContain('PASSWORD');
    expect(bodyStr).not.toContain('dev-access-secret');
  });

  it('health endpoint is independent from auth — no 401 required', async () => {
    vi.mocked(healthCheckDb).mockResolvedValue({ ok: false, error: 'not-configured' });
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
