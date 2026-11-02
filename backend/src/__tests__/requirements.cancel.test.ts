import request from 'supertest';
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
import { createApp } from '../app';
import { cancelRequirement } from '../services/requirements.service';
import { signAccessToken } from '../utils/jwt';
import { canRequirementTransition } from '../utils/requirementState';

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
  email?: string;
  passwordHash?: string;
}

function requirementRow(overrides: Partial<ReqRow> = {}): ReqRow {
  return {
    id: 'req-1',
    organizationId: 'org-1',
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 100,
    quantityFulfilled: 0,
    requiredBy: new Date('2099-01-01T10:00:00.000Z'),
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    status: 'OPEN',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    email: 'recipient@example.com',
    passwordHash: 'bcrypt-hash-placeholder',
    ...overrides,
  };
}

function callerRow(
  opts: { id?: string; role?: string; status?: string; org?: { id: string } | null } = {}
) {
  return {
    id: opts.id ?? 'user-1',
    role: opts.role ?? 'RECIPIENT',
    status: opts.status ?? 'ACTIVE',
    organization: opts.org === undefined ? { id: 'org-1' } : opts.org,
  };
}

interface MockOptions {
  historyFailure?: boolean;
  statusChangedBeforeWrite?: string;
}

function mockBackend(
  caller: ReturnType<typeof callerRow> | null,
  seed: ReqRow[],
  opts: MockOptions = {}
) {
  const store = seed.map((r) => ({ ...r }));
  const history: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  const userFind = vi.fn(async () => caller);
  const requirementFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = store.find((r) => r.id === args.where.id);
    return row ? { ...row } : null;
  });
  const requirementUpdateMany = vi.fn(
    async (args: {
      where: { id: string; organizationId?: string; status?: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      if (opts.statusChangedBeforeWrite) {
        const r = store.find((x) => x.id === args.where.id);
        if (r) r.status = opts.statusChangedBeforeWrite;
      }
      let count = 0;
      for (const r of store) {
        if (r.id !== args.where.id) continue;
        if (args.where.organizationId !== undefined && r.organizationId !== args.where.organizationId) continue;
        if (args.where.status?.in && !args.where.status.in.includes(r.status)) continue;
        Object.assign(r, args.data, { updatedAt: new Date(Date.now() + 1000) });
        count += 1;
      }
      return { count };
    }
  );
  const historyCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.historyFailure) throw new Error('history insert failed postgresql://u:p@h/db');
    history.push(args.data);
    return { id: `rh-${history.length}`, ...args.data };
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    audit.push(args.data);
    return { id: `audit-${audit.length}`, ...args.data };
  });
  const tx = {
    requirement: { findUnique: requirementFindUnique, updateMany: requirementUpdateMany },
    requirementHistory: { create: historyCreate },
    auditLog: { create: auditCreate },
  };
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const reqSnap = store.map((r) => ({ ...r }));
    const histSnap = history.slice();
    const auditSnap = audit.slice();
    try {
      return await fn(tx);
    } catch (err) {
      store.splice(0, store.length, ...reqSnap);
      history.splice(0, history.length, ...histSnap);
      audit.splice(0, audit.length, ...auditSnap);
      throw err;
    }
  });
  const client = {
    user: { findUnique: userFind },
    requirement: {
      findUnique: requirementFindUnique,
      updateMany: requirementUpdateMany,
    },
    requirementHistory: { create: historyCreate },
    auditLog: { create: auditCreate },
    notification: { create: vi.fn() },
    $transaction,
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return {
    store,
    history,
    audit,
    userFind,
    requirementFindUnique,
    requirementUpdateMany,
    historyCreate,
    auditCreate,
    $transaction,
  };
}

function token(role = 'RECIPIENT', id = 'user-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function cancel(
  id = 'req-1',
  role = 'RECIPIENT',
  user = 'user-1',
  body: unknown = undefined
) {
  const app = createApp();
  const req = request(app)
    .post(`/api/requirements/${id}/cancel`)
    .set('Authorization', `Bearer ${token(role, user)}`);
  return body === undefined ? req : req.send(body as Record<string, unknown>);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  // Normalize CRLF so source assertions hold on Windows checkouts (core.autocrlf).
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-07 requirement cancellation', () => {
  describe('authentication / role', () => {
    it('rejects unauthenticated requests with 401 and zero mutation', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow(), [requirementRow()]);
      const app = createApp();
      const res = await request(app).post('/api/requirements/req-1/cancel');
      expect(res.status).toBe(401);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it.each(['PROVIDER', 'VOLUNTEER', 'ADMIN'] as const)(
      'rejects %s with 403 (route guard) and zero mutation',
      async (role) => {
        const { requirementUpdateMany, historyCreate } = mockBackend(callerRow({ role }), [
          requirementRow(),
        ]);
        const res = await cancel('req-1', role, 'x-1');
        expect(res.status).toBe(403);
        expect(requirementUpdateMany).not.toHaveBeenCalled();
        expect(historyCreate).not.toHaveBeenCalled();
      }
    );

    it('service-level defense-in-depth rejects non-recipient callers', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [requirementRow()]);
      await expect(cancelRequirement('req-1', 'admin-1')).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects an inactive/suspended caller with 401 and zero mutation', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow({ status: 'SUSPENDED' }), [
        requirementRow(),
      ]);
      const res = await cancel();
      expect(res.status).toBe(401);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown caller with zero mutation', async () => {
      const { requirementUpdateMany } = mockBackend(null, [requirementRow()]);
      const res = await cancel();
      expect(res.status).toBe(404);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects empty ids with 400', async () => {
      mockBackend(callerRow(), [requirementRow()]);
      await expect(cancelRequirement('', 'user-1')).rejects.toMatchObject({ statusCode: 400 });
      await expect(cancelRequirement('req-1', '')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('ownership', () => {
    it('lets the owning recipient organization cancel (OPEN → CANCELLED)', async () => {
      const { store, requirementUpdateMany } = mockBackend(callerRow(), [requirementRow()]);
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(res.body.data.requirement.status).toBe('CANCELLED');
      expect(store[0].status).toBe('CANCELLED');
      expect(requirementUpdateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', organizationId: 'org-1', status: { in: ['OPEN'] } },
        data: { status: 'CANCELLED' },
      });
    });

    it('rejects a different recipient organization with 403 and zero mutation', async () => {
      const { store, requirementUpdateMany, historyCreate } = mockBackend(
        callerRow({ org: { id: 'org-2' } }),
        [requirementRow({ organizationId: 'org-1' })]
      );
      const res = await cancel();
      expect(res.status).toBe(403);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
      expect(historyCreate).not.toHaveBeenCalled();
      expect(store[0].status).toBe('OPEN');
    });

    it('rejects a recipient with no organization with 403', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow({ org: null }), [requirementRow()]);
      const res = await cancel();
      expect(res.status).toBe(403);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('ignores body/query organization and status spoofing', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow(), [requirementRow()]);
      const res = await cancel('req-1', 'RECIPIENT', 'user-1', {
        organizationId: 'org-2',
        status: 'OPEN',
        actorId: 'other',
      });
      expect(res.status).toBe(200);
      // Session organization + fixed status; no quantity mutation.
      expect(requirementUpdateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', organizationId: 'org-1', status: { in: ['OPEN'] } },
        data: { status: 'CANCELLED' },
      });
      const call = requirementUpdateMany.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('quantityFulfilled');
    });

    it('a cross-organization recipient cannot cancel by spoofing the owner org', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow({ org: { id: 'org-2' } }), [
        requirementRow({ organizationId: 'org-1' }),
      ]);
      const res = await cancel('req-1', 'RECIPIENT', 'user-1', { organizationId: 'org-1' });
      expect(res.status).toBe(403);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('state machine (REQ-04 authoritative guard)', () => {
    it('cancels OPEN → CANCELLED', async () => {
      const { store } = mockBackend(callerRow(), [requirementRow({ status: 'OPEN' })]);
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(store[0].status).toBe('CANCELLED');
    });

    it.each(['PARTIALLY_FULFILLED', 'FULFILLED', 'EXPIRED', 'CANCELLED'] as const)(
      'rejects %s → CANCELLED with 409 and zero mutation/history',
      async (status) => {
        const { store, requirementUpdateMany, historyCreate } = mockBackend(callerRow(), [
          requirementRow({ status }),
        ]);
        const res = await cancel();
        expect(res.status).toBe(409);
        expect(requirementUpdateMany).not.toHaveBeenCalled();
        expect(historyCreate).not.toHaveBeenCalled();
        expect(store[0].status).toBe(status);
      }
    );

    it('does not alter the REQ-04 transition map', () => {
      expect(canRequirementTransition('OPEN', 'CANCELLED')).toBe(true);
      expect(canRequirementTransition('PARTIALLY_FULFILLED', 'CANCELLED')).toBe(false);
      expect(canRequirementTransition('FULFILLED', 'CANCELLED')).toBe(false);
      expect(canRequirementTransition('EXPIRED', 'CANCELLED')).toBe(false);
      expect(canRequirementTransition('CANCELLED', 'CANCELLED')).toBe(false);
    });
  });

  describe('concurrency', () => {
    it('returns 409 and writes no history when the conditional update affects zero rows', async () => {
      const { store, historyCreate, requirementUpdateMany } = mockBackend(
        callerRow(),
        [requirementRow({ status: 'OPEN' })],
        { statusChangedBeforeWrite: 'FULFILLED' }
      );
      const res = await cancel();
      expect(res.status).toBe(409);
      // The conditional where required the pre-cancellation status; a concurrent
      // change makes it affect zero rows, so the transaction rolls back.
      expect(requirementUpdateMany).toHaveBeenCalledTimes(1);
      expect(historyCreate).not.toHaveBeenCalled();
      expect(store[0].status).toBe('OPEN');
    });
  });

  describe('history + audit', () => {
    it('writes exactly one CANCEL history row with the post-cancellation snapshot', async () => {
      const { history, requirementUpdateMany } = mockBackend(callerRow(), [
        requirementRow({ status: 'OPEN', quantityRequired: 100, quantityFulfilled: 0 }),
      ]);
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        requirementId: 'req-1',
        organizationId: 'org-1',
        actorId: 'user-1',
        action: 'CANCEL',
        status: 'CANCELLED',
        quantityRequired: 100,
        quantityFulfilled: 0,
      });
      // Cancellation mutates status only — never quantity.
      expect(requirementUpdateMany.mock.calls[0][0].data).toEqual({ status: 'CANCELLED' });
    });

    it('does not invent a REQUIREMENT_CANCELLED AuditLog action', async () => {
      const { audit } = mockBackend(callerRow(), [requirementRow()]);
      const res = await cancel();
      expect(res.status).toBe(200);
      expect(audit).toHaveLength(0);
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      expect(svc).not.toContain('REQUIREMENT_CANCELLED');
    });

    it('rolls back the cancellation when history persistence fails (masked 500)', async () => {
      const { store, history } = mockBackend(callerRow(), [requirementRow({ status: 'OPEN' })], {
        historyFailure: true,
      });
      const res = await cancel();
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('REQUIREMENT_CANCEL_FAILED');
      expect(store[0].status).toBe('OPEN');
      expect(history).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toMatch(/postgres|password|dsn/i);
    });

    it('masks DB failures with no SQL/DSN leakage', async () => {
      const { userFind } = mockBackend(callerRow(), [requirementRow()]);
      userFind.mockImplementationOnce(async () => {
        throw new Error('postgresql://u:p@h/db SELECT failed');
      });
      const res = await cancel();
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('REQUIREMENT_CANCEL_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/postgres|password|dsn/i);
    });
  });

  describe('response safety + boundaries', () => {
    it('returns an explicit safe projection without sensitive fields', async () => {
      mockBackend(callerRow(), [requirementRow()]);
      const res = await cancel();
      const requirement = res.body.data.requirement;
      expect(Object.keys(requirement).sort()).toEqual(
        [
          'created_at',
          'food_category',
          'food_type',
          'id',
          'location',
          'organization_id',
          'priority',
          'quantity_fulfilled',
          'quantity_required',
          'required_by',
          'status',
          'updated_at',
        ].sort()
      );
      expect(JSON.stringify(res.body)).not.toMatch(/email|passwordHash|password|bcrypt/i);
    });

    it('preserves the existing create/edit/list/history routes', () => {
      const routes = readRepoFile('src', 'routes', 'requirements.ts');
      expect(routes).toContain("requirementRouter.post(\n  '/'");
      expect(routes).toContain("requirementRouter.put(\n  '/:id'");
      expect(routes).toContain("requirementRouter.get('/history'");
      expect(routes).toContain("requirementRouter.get('/',");
      expect(routes).toContain("'/:id/cancel'");
      expect(routes).not.toContain('.delete(');
    });

    it('has no competing allocation model and no quantity-remaining', () => {
      const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
      // REQ-08 / D-06 (Model A): Allocation is authoritative; no competing/remaining mechanics.
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
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      expect(svc).not.toMatch(/quantity_remaining|quantityRemaining/);
      expect(svc).toContain('canRequirementTransition');
      expect(canRequirementTransition('PARTIALLY_FULFILLED', 'CANCELLED')).toBe(false);
    });

    it('introduces no expiry automation (D-10)', () => {
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      expect(svc).not.toMatch(/cron|setInterval|setTimeout|schedule|worker|poll/i);
    });

    it('the CANCEL action enum value is present alongside CREATE/UPDATE', () => {
      const actionEnum = Prisma.dmmf.datamodel.enums.find(
        (e) => e.name === 'RequirementHistoryAction'
      );
      expect(actionEnum).toBeDefined();
      expect(actionEnum!.values.map((v) => v.name)).toEqual(['CREATE', 'UPDATE', 'CANCEL']);
    });
  });
});
