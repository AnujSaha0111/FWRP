import type { NextFunction, Request, Response } from 'express';
import { getProfile, updateProfile } from '../services/users.service';
import { AppError } from '../middleware/error';

// AUTH-08: self profile. Owner always comes from the session; no user id is
// accepted from input, so callers cannot read or mutate other users.
export async function getMeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await getProfile(userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateMeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await updateProfile(userId, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
