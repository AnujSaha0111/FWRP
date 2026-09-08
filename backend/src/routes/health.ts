import { Router } from 'express';
import { healthCheckDb } from '../lib/prisma';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const db = await healthCheckDb();
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'fwrp-backend',
      version: '0.0.0-iteration0',
      db: db.ok ? `up${db.latencyMs !== undefined ? ` (${db.latencyMs}ms)` : ''}` : db.error ?? 'not-configured',
      timestamp: new Date().toISOString(),
    },
  });
});
