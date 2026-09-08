import type { NextFunction, Request, Response } from 'express';
import { acceptDonation } from '../services/donations.service';
import { AppError } from '../middleware/error';

// ORG-05: minimal acceptance endpoint. Donation and user ids come from the
// path and the session respectively — never from the body — so callers
// cannot steer the verification gate. Full acceptance workflows (matching,
// allocation, audit, notifications, concurrency) belong to Phases 8/9.
export async function acceptDonationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await acceptDonation(id, userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
