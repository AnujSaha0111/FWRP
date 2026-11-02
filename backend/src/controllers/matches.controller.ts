import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../middleware/error';
import {
  acceptMatch,
  getMatch,
  listMatches,
  refreshDonationMatches,
  refreshRequirementMatches,
  rejectMatch,
} from '../services/matching.service';

// MATCH-07..MATCH-10: thin handlers. Identity always comes from the session;
// role scope and ownership are enforced in the matching service.

function sessionUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return userId;
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function listMatchesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await listMatches(sessionUserId(req), req.query);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getMatchHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await getMatch(param(req, 'id'), sessionUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function rejectMatchHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await rejectMatch(param(req, 'id'), sessionUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function acceptMatchHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await acceptMatch(param(req, 'id'), sessionUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function refreshDonationMatchesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await refreshDonationMatches(param(req, 'donationId'), sessionUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function refreshRequirementMatchesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await refreshRequirementMatches(param(req, 'requirementId'), sessionUserId(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
