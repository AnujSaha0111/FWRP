import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import {
  allocateRequirement,
  listAllocationsForDonation,
  listAllocationsForRequirement,
} from '../services/allocations.service';
import {
  deriveDonationRemaining,
  deriveRequirementRemaining,
  deriveRequirementStatus,
} from '../utils/fulfillment';

interface AllocationRow {
  id: string;
  donationId: string;
  requirementId: string;
  committedQuantity: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MockOptions {
  donations?: Record<string, number>;
  requirements?: string[];
  seedAllocations?: Array<{ donationId: string; requirementId: string; committedQuantity: number }>;
  createFailure?: boolean;
  dbError?: boolean;
}

function mockBackend(opts: MockOptions = {}) {
  const donations = new Map(Object.entries(opts.donations ?? {}));
  const requirements = new Set(opts.requirements ?? []);
  const allocations: AllocationRow[] = (opts.seedAllocations ?? []).map((a, i) => ({
    id: `alloc-${i + 1}`,
    donationId: a.donationId,
    requirementId: a.requirementId,
    committedQuantity: a.committedQuantity,
    createdAt: new Date(2026, 0, 1, 0, 0, i),
    updatedAt: new Date(2026, 0, 1, 0, 0, i),
  }));
  let seq = allocations.length;

  const $queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    if (opts.dbError) throw new Error('postgresql://u:p@h/db SELECT failed');
    const id = values[0] as string;
    if (!donations.has(id)) return [];
    return [{ donation_id: id, quantity: donations.get(id)! }];
  });
  const requirementFindUnique = vi.fn(async (args: { where: { id: string } }) =>
    requirements.has(args.where.id) ? { id: args.where.id } : null
  );
  const allocationAggregate = vi.fn(async (args: { where: { donationId: string } }) => {
    if (opts.dbError) throw new Error('postgresql://u:p@h/db AGGREGATE failed');
    const sum = allocations
      .filter((a) => a.donationId === args.where.donationId)
      .reduce((s, a) => s + a.committedQuantity, 0);
    return { _sum: { committedQuantity: sum } };
  });
  const allocationCreate = vi.fn(
    async (args: { data: { donationId: string; requirementId: string; committedQuantity: number } }) => {
      seq += 1;
      const row: AllocationRow = {
        id: `alloc-${seq}`,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      allocations.push(row);
      if (opts.createFailure) throw new Error('INSERT failed postgresql://u:p@h/db');
      return row;
    }
  );
  const allocationFindMany = vi.fn(
    async (args: { where: { donationId?: string; requirementId?: string } }) =>
      allocations.filter(
        (a) =>
          (args.where.donationId === undefined || a.donationId === args.where.donationId) &&
          (args.where.requirementId === undefined || a.requirementId === args.where.requirementId)
      )
  );

  const tx = {
    $queryRaw,
    requirement: { findUnique: requirementFindUnique },
    allocation: { aggregate: allocationAggregate, create: allocationCreate },
  };
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const snapshot = allocations.map((a) => ({ ...a }));
    try {
      return await fn(tx);
    } catch (err) {
      allocations.splice(0, allocations.length, ...snapshot);
      throw err;
    }
  });
  const client = { allocation: { findMany: allocationFindMany }, $transaction };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return {
    allocations,
    donations,
    requirements,
    $queryRaw,
    requirementFindUnique,
    allocationAggregate,
    allocationCreate,
    allocationFindMany,
    $transaction,
  };
}

function alloc(donation_id: unknown, requirement_id: unknown, quantity: unknown) {
  return allocateRequirement({ donation_id, requirement_id, quantity });
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-08 allocation representation', () => {
  it('represents a Donation → Requirement relationship with a committed quantity', async () => {
    mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1'] });
    const result = await alloc('don-1', 'req-1', 100);
    expect(result.allocation).toMatchObject({
      donation_id: 'don-1',
      requirement_id: 'req-1',
      committed_quantity: 100,
    });
    expect(typeof result.allocation.id).toBe('string');
  });

  it('supports multiple allocations against one donation (up to its quantity)', async () => {
    const m = mockBackend({
      donations: { 'don-1': 120 },
      requirements: ['req-1', 'req-2'],
    });
    await alloc('don-1', 'req-1', 100);
    await alloc('don-1', 'req-2', 20);
    expect(m.allocations).toHaveLength(2);
    expect(m.allocations.reduce((s, a) => s + a.committedQuantity, 0)).toBe(120);
  });

  it('supports multiple donations against one requirement', async () => {
    const m = mockBackend({
      donations: { 'don-1': 60, 'don-2': 80 },
      requirements: ['req-1'],
    });
    await alloc('don-1', 'req-1', 50);
    await alloc('don-2', 'req-1', 70);
    const forReq = await listAllocationsForRequirement('req-1');
    expect(forReq.map((a) => a.donation_id).sort()).toEqual(['don-1', 'don-2']);
    expect(m.allocations).toHaveLength(2);
  });

  it('lists allocations per donation and per requirement', async () => {
    mockBackend({
      donations: { 'don-1': 120, 'don-2': 120 },
      requirements: ['req-1', 'req-2'],
      seedAllocations: [
        { donationId: 'don-1', requirementId: 'req-1', committedQuantity: 10 },
        { donationId: 'don-1', requirementId: 'req-2', committedQuantity: 20 },
        { donationId: 'don-2', requirementId: 'req-1', committedQuantity: 30 },
      ],
    });
    expect((await listAllocationsForDonation('don-1')).map((a) => a.requirement_id).sort()).toEqual([
      'req-1',
      'req-2',
    ]);
    expect((await listAllocationsForRequirement('req-1')).map((a) => a.donation_id).sort()).toEqual([
      'don-1',
      'don-2',
    ]);
  });

  it('requires a positive finite allocation quantity', async () => {
    const m = mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1'] });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', undefined, null]) {
      await expect(alloc('don-1', 'req-1', bad)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(m.allocations).toHaveLength(0);
  });

  it('requires non-empty donation and requirement ids', async () => {
    mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1'] });
    await expect(alloc('', 'req-1', 10)).rejects.toMatchObject({ statusCode: 400 });
    await expect(alloc('don-1', '  ', 10)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 404 for an unknown donation and an unknown requirement', async () => {
    const m = mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1'] });
    await expect(alloc('don-x', 'req-1', 10)).rejects.toMatchObject({ statusCode: 404 });
    await expect(alloc('don-1', 'req-x', 10)).rejects.toMatchObject({ statusCode: 404 });
    expect(m.allocations).toHaveLength(0);
  });
});

describe('REQ-08 allocation invariants', () => {
  it('rejects over-allocation with 409 and leaves no partial allocation', async () => {
    const m = mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1', 'req-2'] });
    await alloc('don-1', 'req-1', 100);
    await expect(alloc('don-1', 'req-2', 30)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.allocations).toHaveLength(1);
    expect(m.allocations[0].committedQuantity).toBe(100);
  });

  it('rejects an allocation when a seeded committed total already exhausts the donation', async () => {
    const m = mockBackend({
      donations: { 'don-1': 120 },
      requirements: ['req-1', 'req-2'],
      seedAllocations: [{ donationId: 'don-1', requirementId: 'req-1', committedQuantity: 120 }],
    });
    await expect(alloc('don-1', 'req-2', 1)).rejects.toMatchObject({ statusCode: 409 });
    expect(m.allocations).toHaveLength(1);
  });

  it('locks the donation row with SELECT ... FOR UPDATE for concurrent safety', async () => {
    const m = mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1'] });
    await alloc('don-1', 'req-1', 10);
    expect(m.$queryRaw).toHaveBeenCalledTimes(1);
    const joined = String(m.$queryRaw.mock.calls[0][0]);
    expect(joined).toMatch(/FOR UPDATE/);
    expect(joined).toMatch(/donations/);
  });

  it('rolls the allocation transaction back when persistence fails', async () => {
    const m = mockBackend({
      donations: { 'don-1': 120 },
      requirements: ['req-1'],
      createFailure: true,
    });
    await expect(alloc('don-1', 'req-1', 10)).rejects.toMatchObject({
      statusCode: 500,
      code: 'ALLOCATION_FAILED',
    });
    expect(m.allocations).toHaveLength(0);
  });

  it('masks DB failures with 500 and no SQL/DSN leakage', async () => {
    mockBackend({ donations: { 'don-1': 120 }, requirements: ['req-1'], dbError: true });
    try {
      await alloc('don-1', 'req-1', 10);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 500, code: 'ALLOCATION_FAILED' });
      expect(JSON.stringify(err)).not.toMatch(/postgres|password|dsn/i);
    }
  });
});

describe('REQ-08 derived remaining quantities + fulfillment semantics', () => {
  it('derives requirement remaining', () => {
    expect(deriveRequirementRemaining(120, 0)).toBe(120);
    expect(deriveRequirementRemaining(120, 100)).toBe(20);
    expect(deriveRequirementRemaining(120, 120)).toBe(0);
  });

  it('derives donation remaining from committed allocations', () => {
    expect(deriveDonationRemaining(120, 0)).toBe(120);
    expect(deriveDonationRemaining(120, 100)).toBe(20);
    expect(deriveDonationRemaining(120, 120)).toBe(0);
  });

  it('derives requirement status from confirmed quantity only (delivery semantics)', () => {
    expect(deriveRequirementStatus(120, 0)).toBe('OPEN');
    expect(deriveRequirementStatus(120, 100)).toBe('PARTIALLY_FULFILLED');
    expect(deriveRequirementStatus(120, 120)).toBe('FULFILLED');
  });
});

describe('REQ-08 boundaries (allocation ≠ fulfillment, no endpoints, no schema extras)', () => {
  it('allocation never mutates requirement quantity/status or writes history/audit', () => {
    const svc = readRepoFile('src', 'services', 'allocations.service.ts');
    // No requirement fulfillment mutation and no history/audit side effects.
    expect(svc).not.toMatch(/quantityFulfilled\s*[:=]/);
    expect(svc).not.toMatch(/status\s*:\s*['"](OPEN|PARTIALLY_FULFILLED|FULFILLED|EXPIRED|CANCELLED)['"]/);
    expect(svc).not.toContain('requirementHistory');
    expect(svc).not.toContain('auditLog');
    expect(svc).not.toMatch(/tx\.match|client\.match|tx\.delivery|client\.delivery/);
    // Uses the DB-13 row-lock concurrency pattern.
    expect(svc).toContain('FOR UPDATE');
  });

  it('does not expose allocation HTTP endpoints', () => {
    const req = readRepoFile('src', 'routes', 'requirements.ts');
    const don = readRepoFile('src', 'routes', 'donations.ts');
    for (const routes of [req, don]) {
      expect(routes).not.toMatch(/allocat/i);
    }
    expect(fs.existsSync(path.join(backendDir, 'src', 'routes', 'allocations.ts'))).toBe(false);
  });

  it('adds the authoritative Allocation model with no competing representations or quantity_remaining', () => {
    const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
    expect(models).toContain('Allocation');
    expect(models).not.toContain('DonationAllocation');
    expect(models).not.toContain('Fulfillment');
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        expect(field.name, `${model.name}.${field.name}`).not.toMatch(
          /quantityRemaining|quantity_remaining/
        );
      }
    }
    const schema = readRepoFile('prisma', 'schema.prisma');
    expect(schema).toMatch(/model\s+Allocation/);
    expect(schema).not.toMatch(/quantity_remaining|quantityRemaining/);
    const allocation = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Allocation')!;
    const byName = new Map(allocation.fields.map((f) => [f.name, f]));
    expect(byName.get('committedQuantity')!.type).toBe('Float');
    expect(byName.get('donationId')!.kind).toBe('scalar');
    expect(byName.get('requirementId')!.kind).toBe('scalar');
  });

  it('adds no premature RequirementHistory or AuditLog actions (fulfillment actions deferred)', () => {
    const actionEnum = Prisma.dmmf.datamodel.enums.find(
      (e) => e.name === 'RequirementHistoryAction'
    );
    expect(actionEnum).toBeDefined();
    expect(actionEnum!.values.map((v) => v.name)).toEqual(['CREATE', 'UPDATE', 'CANCEL']);
  });

  it('preserves REQ-04/REQ-07 by not touching their modules', () => {
    const state = readRepoFile('src', 'utils', 'requirementState.ts');
    expect(state).toContain("OPEN: ['PARTIALLY_FULFILLED', 'EXPIRED', 'CANCELLED']");
    expect(state).toContain("PARTIALLY_FULFILLED: ['FULFILLED']");
    const reqSvc = readRepoFile('src', 'services', 'requirements.service.ts');
    expect(reqSvc).toContain('cancelRequirement');
  });
});
