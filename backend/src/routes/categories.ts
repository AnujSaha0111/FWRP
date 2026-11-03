import { Router } from 'express';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { authenticate } from '../middleware/auth';

// CAT-01: read-only list of active food categories (D-08 / ADR 007). Donation
// and requirement forms offer exactly these, because both are validated
// against active Category rows on write. Administration of categories is not
// exposed over HTTP.
export const categoriesRouter = Router();

categoriesRouter.get('/', authenticate, async (_req, res, next) => {
  try {
    const categories = await getPrisma().category.findMany({
      where: { isActive: true },
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
    res.status(200).json({ success: true, data: { categories } });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(500, 'CATEGORIES_FAILED', 'Could not load categories'));
  }
});
