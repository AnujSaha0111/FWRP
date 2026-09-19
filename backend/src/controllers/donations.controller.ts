import type { NextFunction, Request, Response } from 'express';
import {
  acceptDonation,
  cancelDonation,
  createDonation,
  getDonation,
  getDonationHistory,
  listDonations,
  overrideDonation,
  updateDonation,
} from '../services/donations.service';
import { AppError } from '../middleware/error';

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

export async function createDonationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await createDonation(userId, req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateDonationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await updateDonation(id, userId, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function cancelDonationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await cancelDonation(id, userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getDonationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await getDonation(id, userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function listDonationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await listDonations(userId, req.query as Record<string, unknown>);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// DON-08: provider donation history. Provider identity comes from the session;
// `provider_id=me` is validated in the service (any other value → 400) and
// RECIPIENT/VOLUNTEER/ADMIN → 403. Historical (no current-availability filter).
export async function getDonationHistoryHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await getDonationHistory(userId, req.query as Record<string, unknown>);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function overrideDonationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await overrideDonation(id, userId, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
