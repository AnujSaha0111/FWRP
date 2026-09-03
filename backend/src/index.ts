import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

const app = createApp();

const port = env.PORT;

app.listen(port, () => {
  logger.info({ port, env: env.NODE_ENV }, `FWRP backend listening on port ${port}`);
  logger.info(`Health check: http://localhost:${port}/api/health`);
});
