import request from 'supertest';
import express from 'express';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { errorMiddleware } from '../middleware/error';

describe('validate middleware — BE-05', () => {
  const schema = z.object({ name: z.string().min(1), email: z.string().email() });

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.post('/test', validateBody(schema), (req, res) => res.json({ success: true, data: req.body }));
    app.use(errorMiddleware);
    return app;
  }

  it('passes valid body', async () => {
    const app = makeApp();
    const res = await request(app).post('/test').send({ name: 'A', email: 'a@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 with VALIDATION_ERROR on invalid body', async () => {
    const app = makeApp();
    const res = await request(app).post('/test').send({ name: '', email: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('coerces and replaces body with parsed data', async () => {
    const numSchema = z.object({ count: z.coerce.number().int().min(1) });
    const app = express();
    app.use(express.json());
    app.post('/coerce', validateBody(numSchema), (req, res) => {
      expect(typeof req.body.count).toBe('number');
      res.json({ ok: true });
    });
    app.use(errorMiddleware);
    const res = await request(app).post('/coerce').send({ count: '5' });
    expect(res.status).toBe(200);
  });
});
