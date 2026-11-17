import { createApp } from './createApp';
import { env, isDatabaseConfigured } from './config/env';
import { startMatchingRefreshJob } from './jobs/matchingRefresh';
import { startExpiryJob } from './jobs/expiry';
import { startNotificationJob } from './jobs/notifications';
import { logger } from './utils/logger';

const app = createApp();

const port = env.PORT;

app.listen(port, () => {
  logger.info({ port, env: env.NODE_ENV }, `FWRP backend listening on port ${port}`);
  logger.info(`Health check: http://localhost:${port}/api/health`);
  // Background jobs need a database: EXP-01 expiry, MATCH-11 re-scoring,
  // NOTIF-04/06 alerts + email.
  if (isDatabaseConfigured()) {
    startExpiryJob();
    startMatchingRefreshJob();
    startNotificationJob();
  }
});
