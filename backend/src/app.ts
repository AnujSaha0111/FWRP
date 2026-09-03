import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { errorMiddleware } from './middleware/error';
import { notFound } from './middleware/notFound';
import { adminRouter } from './routes/admin';
import { analyticsRouter } from './routes/analytics';
import { authRouter } from './routes/auth';
import { deliveryRouter } from './routes/deliveries';
import { donationRouter } from './routes/donations';
import { healthRouter } from './routes/health';
import { matchRouter } from './routes/matches';
import { notificationRouter } from './routes/notifications';
import { requirementRouter } from './routes/requirements';
import { logger } from './utils/logger';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // API base path — convention: /api (unversioned; service version is
  // reported by GET /api/health). See docs/api.md "Versioning (BE-04)".
  app.use('/api/health', healthRouter);

  // BE-04 domain routers. Business endpoints arrive in later phases; until
  // then each router answers 501 NOT_IMPLEMENTED via errorMiddleware.
  app.use('/api/auth', authRouter);
  app.use('/api/donations', donationRouter);
  app.use('/api/requirements', requirementRouter);
  app.use('/api/matches', matchRouter);
  app.use('/api/deliveries', deliveryRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/notifications', notificationRouter);

  app.use(notFound);
  app.use(errorMiddleware);

  return app;
}
