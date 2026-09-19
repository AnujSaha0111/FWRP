import type { NextFunction, Request, Response } from 'express';
import { createRequirement } from '../services/requirements.service';
import { AppError } from '../middleware/error';

export async function createRequirementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await createRequirement(userId, req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
