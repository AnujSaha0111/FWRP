import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('fwrp-backend');
  });

  it('returns 404 for unknown route', async () => {
    const app = createApp();
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
