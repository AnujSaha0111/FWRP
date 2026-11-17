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
import { categoriesRouter } from './routes/categories';
import { deliveryRouter } from './routes/deliveries';
import { donationRouter } from './routes/donations';
import { healthRouter } from './routes/health';
import { incidentsRouter } from './routes/incidents';
import { matchRouter } from './routes/matches';
import { notificationRouter } from './routes/notifications';
import { organizationsRouter } from './routes/organizations';
import { requirementRouter } from './routes/requirements';
import { usersRouter } from './routes/users';
import { volunteersRouter } from './routes/volunteers';
import { logger } from './utils/logger';

export function createApp() {
  const app = express();
  // SEC-01: rate limits key on req.ip; behind a proxy it must be the client address.
  if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);

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
  // AUTH-08 self profile (live). Remaining domain routers stay structural.
  app.use('/api/users', usersRouter);
  // AUTH-09 self organization (live).
  app.use('/api/organizations', organizationsRouter);
  // LOG-01 volunteer availability (live).
  app.use('/api/volunteers', volunteersRouter);
  // ADMIN-03 incident filing (reported accounts + disputes).
  app.use('/api/incidents', incidentsRouter);
  // CAT-01 active categories for donation/requirement forms.
  app.use('/api/categories', categoriesRouter);

  app.use(notFound);
  app.use(errorMiddleware);

  return app;
}
