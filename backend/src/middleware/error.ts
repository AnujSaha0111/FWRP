import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function errorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Zod validation errors not wrapped in AppError (defensive)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zodErr = err as any;
  if (zodErr?.name === 'ZodError' && Array.isArray(zodErr.issues)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: zodErr.issues.map((i: { path: (string | number)[]; message: string }) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      },
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'Internal server error' : err.message,
    },
  });
}
