export interface CursorPaginationQuery {
  cursor?: string;
  limit?: string | number;
  page?: string | number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  totalPages: number;
  nextCursor: string | null;
}

export function parsePaginationParams(
  query: CursorPaginationQuery,
  defaultLimit = 20,
  maxLimit = 100,
) {
  const limitNum = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), maxLimit);
  const pageNum = Math.max(Number(query.page) || 1, 1);
  return {
    cursor: query.cursor ? String(query.cursor).trim() : undefined,
    limit: limitNum,
    page: pageNum,
  };
}

