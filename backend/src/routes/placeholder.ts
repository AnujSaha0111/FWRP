import { Router } from 'express';
import { AppError } from '../middleware/error';

// BE-04: structural placeholder for domain routers whose business endpoints
// belong to later phases. Any method/path under the mount prefix flows here
// and yields a 501 envelope via the central errorMiddleware — never a fake
// successful business response. No auth, no DB, no business logic.
export function createPlaceholderRouter(domain: string) {
  const router = Router();
  router.use((_req, _res, next) => {
    next(new AppError(501, 'NOT_IMPLEMENTED', `${domain} endpoints are not implemented yet`));
  });
  return router;
}
