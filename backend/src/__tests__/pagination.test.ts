import { describe, it, expect } from 'vitest';
import { parsePagination, paginate } from '../utils/pagination';

describe('pagination utils — BE-09', () => {
  it('defaults to page 1 limit 20', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 20, offset: 0 });
  });
  it('parses string page/limit', () => {
    expect(parsePagination({ page: '2', limit: '10' })).toEqual({ page: 2, limit: 10, offset: 10 });
  });
  it('clamps invalid page/limit to defaults', () => {
    expect(parsePagination({ page: '0', limit: '-5' })).toEqual({ page: 1, limit: 20, offset: 0 });
  });
  it('caps limit at MAX 100', () => {
    expect(parsePagination({ limit: '500' }).limit).toBe(100);
  });
  it('floors float values', () => {
    expect(parsePagination({ page: '2.9', limit: '10.7' })).toEqual({ page: 2, limit: 10, offset: 10 });
  });
  it('paginate computes totalPages and next/prev', () => {
    const res = paginate([1, 2], 5, { page: 1, limit: 2, offset: 0 });
    expect(res.totalPages).toBe(3);
    expect(res.hasNext).toBe(true);
    expect(res.hasPrev).toBe(false);
    const res2 = paginate([5], 5, { page: 3, limit: 2, offset: 4 });
    expect(res2.hasNext).toBe(false);
    expect(res2.hasPrev).toBe(true);
  });
});
