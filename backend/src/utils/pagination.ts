export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginationResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const rawPage = query.page as string | number | undefined;
  const rawLimit = query.limit as string | number | undefined;

  let page = rawPage !== undefined ? Number(rawPage) : DEFAULT_PAGE;
  let limit = rawLimit !== undefined ? Number(rawLimit) : DEFAULT_LIMIT;

  if (!Number.isFinite(page) || page < 1) page = DEFAULT_PAGE;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  page = Math.floor(page);
  limit = Math.floor(limit);

  return { page, limit, offset: (page - 1) * limit };
}

export function paginate<T>(items: T[], total: number, params: PaginationParams): PaginationResult<T> {
  const totalPages = Math.ceil(total / params.limit) || 1;
  return {
    items,
    total,
    page: params.page,
    limit: params.limit,
    totalPages,
    hasNext: params.page < totalPages,
    hasPrev: params.page > 1,
  };
}

export const paginationQuerySchema = {
  page: DEFAULT_PAGE,
  limit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
} as const;
