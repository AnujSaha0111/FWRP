import { z } from 'zod';

export function strictDateField(field: string) {
  return z
    .union([z.date(), z.string().trim().min(1), z.number().finite()], {
      errorMap: () => ({ message: `${field} must be a valid date` }),
    })
    .transform((value, ctx) => {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a valid date` });
        return z.NEVER;
      }
      return date;
    });
}
