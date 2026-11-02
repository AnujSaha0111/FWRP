import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import {
  createRequirement,
  updateRequirement,
  cancelRequirement,
} from '../services/requirements.service';
import { REQUIREMENT_TRANSITIONS } from '../utils/requirementState';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');

function readRepoFile(...parts: string[]): string {
  // Normalize CRLF so source assertions hold on Windows checkouts (core.autocrlf).
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function productionTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(path.join(backendDir, 'src'));
  return out;
}

// Strip comments so boundary scans assess executable code, not prose.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function filesMatching(re: RegExp): string[] {
  return productionTsFiles()
    .filter((f) => re.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(backendDir, f).replace(/\\/g, '/'));
}

// Any `quantityFulfilled:` assignment whose value is NOT a property read
// (`x.quantityFulfilled`), a `select` marker (`true`), or a type (`number`)
// would be a fulfillment mutation — which must not exist before Phase 11.
function quantityFulfilledWriteOffenders(): string[] {
  const offenders: string[] = [];
  for (const f of productionTsFiles()) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /quantityFulfilled:\s*([^,\n};]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const value = m[1].trim();
      const isRead = /(?:^|\.)quantityFulfilled$/.test(value) || value === 'true' || value === 'number';
      if (!isRead) offenders.push(`${path.relative(backendDir, f).replace(/\\/g, '/')} => ${value}`);
    }
  }
  return offenders;
}

interface ReqRow {
  id: string;
  organizationId: string;
  foodCategory: string;
  foodType: string;
  quantityRequired: number;
  quantityFulfilled: number;
  requiredBy: Date;
  priority: string;
  location: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

// Stateful in-memory backend double spanning create + edit + cancel.
function mockLifecycleBackend() {
  const store: ReqRow[] = [];
  const history: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  let seq = 0;

  const userFind = vi.fn(async () => ({
    id: 'user-1',
    role: 'RECIPIENT',
    status: 'ACTIVE',
    organization: { id: 'org-1', verificationStatus: 'VERIFIED' },
  }));
  const categoryFindFirst = vi.fn(async () => ({ id: 'cat-1' }));
  const requirementCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    seq += 1;
    const row = {
      id: `req-${seq}`,
      quantityFulfilled: 0,
      status: 'OPEN',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.data,
    } as ReqRow;
    store.push(row);
    return row;
  });
  const requirementFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = store.find((r) => r.id === args.where.id);
    return row ? { ...row } : null;
  });
  const requirementUpdateMany = vi.fn(
    async (args: {
      where: { id: string; organizationId?: string; status?: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const r of store) {
        if (r.id !== args.where.id) continue;
        if (args.where.organizationId !== undefined && r.organizationId !== args.where.organizationId) continue;
        if (args.where.status?.in && !args.where.status.in.includes(r.status)) continue;
        Object.assign(r, args.data, { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    }
  );
  const historyCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `rh-${history.length + 1}`, ...args.data };
    history.push(row);
    return row;
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `audit-${audit.length + 1}`, ...args.data };
    audit.push(row);
    return row;
  });

  const tx = {
    requirement: {
      create: requirementCreate,
      findUnique: requirementFindUnique,
      updateMany: requirementUpdateMany,
    },
    requirementHistory: { create: historyCreate },
    auditLog: { create: auditCreate },
  };
  const $transaction = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    const snapshot = {
      s: store.map((r) => ({ ...r })),
      h: history.slice(),
      a: audit.slice(),
    };
    try {
      return await (arg as (c: unknown) => Promise<unknown>)(tx);
    } catch (err) {
      store.splice(0, store.length, ...snapshot.s);
      history.splice(0, history.length, ...snapshot.h);
      audit.splice(0, audit.length, ...snapshot.a);
      throw err;
    }
  });

  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    category: { findFirst: categoryFindFirst },
    requirement: {
      create: requirementCreate,
      findUnique: requirementFindUnique,
      updateMany: requirementUpdateMany,
    },
    requirementHistory: { create: historyCreate },
    auditLog: { create: auditCreate },
    $transaction,
  } as unknown as PrismaClient);

  return { store, history, audit, requirementUpdateMany, historyCreate };
}

const createBody = {
  food_category: 'Prepared meals',
  food_type: 'Vegetarian',
  quantity_required: 100,
  required_by: '2099-01-01T10:00:00.000Z',
  priority: 'HIGH',
  location: 'XYZ Shelter, Springfield',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-09 cross-feature requirement lifecycle regression', () => {
  it('create → edit → cancel preserves history ordering and never mutates quantityFulfilled', async () => {
    const m = mockLifecycleBackend();

    const created = await createRequirement('user-1', createBody);
    expect(created.requirement.status).toBe('OPEN');
    expect(created.requirement.quantity_fulfilled).toBe(0);

    const edited = await updateRequirement('req-1', 'user-1', { location: 'New Shelter Address' });
    expect(edited.requirement.status).toBe('OPEN');
    expect(edited.requirement.quantity_fulfilled).toBe(0);
    expect(edited.requirement.location).toBe('New Shelter Address');

    const cancelled = await cancelRequirement('req-1', 'user-1');
    expect(cancelled.requirement.status).toBe('CANCELLED');
    expect(cancelled.requirement.quantity_fulfilled).toBe(0);

    // RequirementHistory is the authoritative source: CREATE → UPDATE → CANCEL.
    expect(m.history.map((h) => h.action)).toEqual(['CREATE', 'UPDATE', 'CANCEL']);
    expect(m.history[2]).toMatchObject({
      requirementId: 'req-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      status: 'CANCELLED',
    });

    // Existing audit behavior: exactly one REQUIREMENT_UPDATED from the edit;
    // cancellation writes no AuditLog (no authoritative action exists).
    expect(m.audit.map((a) => a.action)).toEqual(['REQUIREMENT_UPDATED']);

    // quantityFulfilled is never a field of any requirement mutation data.
    for (const call of m.requirementUpdateMany.mock.calls) {
      expect(call[0].data).not.toHaveProperty('quantityFulfilled');
      expect(call[0].data).not.toHaveProperty('quantity_fulfilled');
    }
    expect(m.store[0].quantityFulfilled).toBe(0);
  });

  it('rejects a second cancellation after CANCELLED (REQ-04 terminal) with 409 and zero writes', async () => {
    const m = mockLifecycleBackend();
    await createRequirement('user-1', createBody);
    await cancelRequirement('req-1', 'user-1');
    const historyBefore = m.history.length;
    await expect(cancelRequirement('req-1', 'user-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(m.history).toHaveLength(historyBefore);
    expect(m.store[0].status).toBe('CANCELLED');
    expect(m.store[0].quantityFulfilled).toBe(0);
  });
});

describe('REQ-09 delivery/fulfillment boundary (owned by DELCONF, Phase 11)', () => {
  it('delivery confirmation lives only in the delivery service and route', () => {
    expect(fs.existsSync(path.join(backendDir, 'src', 'services', 'delivery.service.ts'))).toBe(true);
    expect(filesMatching(/confirmReceipt/)).toEqual([
      'src/controllers/deliveries.controller.ts',
      'src/routes/deliveries.ts',
      'src/services/delivery.service.ts',
    ]);
    expect(readRepoFile('src', 'routes', 'deliveries.ts')).toContain("'/:id/confirm'");
  });

  it('only delivery confirmation completes donations or mutates quantityFulfilled', () => {
    // No persisted remaining-quantity concept anywhere in production
    // (`quantity_fulfilled` is a legitimate public API projection field name).
    expect(filesMatching(/quantity_remaining|quantityRemaining/)).toEqual([]);
    // COMPLETED appears only in delivery confirmation (guarded write + its audit payload).
    expect(filesMatching(/status:\s*'COMPLETED'/)).toEqual(['src/services/delivery.service.ts']);
    // Fulfilment writes exist only in delivery confirmation (DELCONF-03).
    const writers = new Set(quantityFulfilledWriteOffenders().map((o) => o.split(' => ')[0]));
    expect([...writers]).toEqual(['src/services/delivery.service.ts']);
    // Allocation never writes a requirement status/quantity.
    const alloc = readRepoFile('src', 'services', 'allocations.service.ts');
    expect(alloc).not.toContain('quantityFulfilled:');
    expect(alloc).not.toMatch(/status\s*:\s*['"]/);
  });

  it('keeps the allocation representation authoritative with no competing/remaining mechanics', () => {
    const schema = readRepoFile('prisma', 'schema.prisma');
    expect(schema).toMatch(/model\s+Allocation/);
    expect(schema).not.toMatch(/model\s+DonationAllocation/);
    expect(schema).not.toMatch(/model\s+Fulfillment/);
    expect(schema).not.toMatch(/quantity_remaining|quantityRemaining/);
  });
});

describe('REQ-09 route/state/D-07/D-10 preservation', () => {
  it('exposes exactly the requirement-management routes and no allocation/status/delivery route', () => {
    const routes = readRepoFile('src', 'routes', 'requirements.ts');
    expect(routes).toContain("requirementRouter.post(\n  '/'");
    expect(routes).toContain("requirementRouter.get('/history'");
    expect(routes).toContain("requirementRouter.get('/',");
    expect(routes).toContain("requirementRouter.put(\n  '/:id'");
    expect(routes).toContain("'/:id/cancel'");
    for (const forbidden of ["'/status'", "'/expire'", "'/override'", "'/allocat", "'/fulfil"]) {
      expect(routes).not.toContain(forbidden);
    }
    expect(readRepoFile('src', 'app.ts')).not.toContain('/api/allocations');
  });

  it('keeps the REQ-04 transition map authoritative and unchanged', () => {
    expect(REQUIREMENT_TRANSITIONS).toEqual({
      OPEN: ['PARTIALLY_FULFILLED', 'EXPIRED', 'CANCELLED'],
      PARTIALLY_FULFILLED: ['FULFILLED'],
      FULFILLED: [],
      EXPIRED: [],
      CANCELLED: [],
    });
  });

  it('preserves the D-07 radius deferral and D-10 no-expiry-automation boundary', () => {
    const svc = readRepoFile('src', 'services', 'requirements.service.ts');
    expect(svc).toContain('radiusKm is not supported');
    expect(svc).not.toMatch(/cron|setInterval|setTimeout|schedule|worker|poll/i);
  });
});
