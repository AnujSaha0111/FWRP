import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError, errorMessage } from './api';

/**
 * Puts backend validation errors (400 details) under the matching form fields.
 * Returns a message for errors that belong to no field (shown above the form).
 */
export function applyServerErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  fields: readonly Path<T>[]
): string | null {
  if (err instanceof ApiError && err.details.length > 0) {
    let unmatched: string | null = null;
    for (const detail of err.details) {
      const field = detail.field as Path<T>;
      if (fields.includes(field)) setError(field, { type: 'server', message: detail.message });
      else unmatched ??= detail.message;
    }
    return unmatched;
  }
  return errorMessage(err);
}
