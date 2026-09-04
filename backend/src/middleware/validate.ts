import type { Request, Response, NextFunction } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { AppError } from './error';

type ValidateTarget = 'body' | 'query' | 'params';

export function validate(target: ValidateTarget, schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const data = (req as unknown as Record<string, unknown>)[target];
    const result = schema.safeParse(data);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      }));
      return next(new AppError(400, 'VALIDATION_ERROR', 'Validation failed', details));
    }
    // replace with parsed/coerced data
    (req as unknown as Record<string, unknown>)[target] = result.data;
    next();
  };
}

// Convenience: validate body only
export function validateBody(schema: ZodSchema) {
  return validate('body', schema);
}

export function validateQuery(schema: ZodSchema) {
  return validate('query', schema);
}

export function validateParams(schema: ZodSchema) {
  return validate('params', schema);
}

// Helper to format ZodError outside middleware (e.g., service layer)
export function formatZodError(err: ZodError) {
  return err.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }));
}
