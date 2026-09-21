import type { PrismaClient } from '@prisma/client';
import { AppError } from '../middleware/error';

export async function assertCategoryActive(
  client: Pick<PrismaClient, 'category'>,
  name: string,
  field = 'category'
): Promise<void> {
  const active = await client.category.findFirst({
    where: { name, isActive: true },
    select: { id: true },
  });
  if (!active) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field, message: `${field} must be one of the active categories` },
    ]);
  }
}
