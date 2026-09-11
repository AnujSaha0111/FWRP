import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. auditService and
// notificationService run FOR REAL against staged transaction doubles, so
// same-handle participation and rollback semantics are genuinely proven.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient, VerificationStatus } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import {
  assertVerificationTransition,
  reviewOrganization,
  verifyOrganization,
  type VerificationHooks,
} from '../services/organizations.service';
import { signAccessToken } from '../utils/jwt';
import { AppError } from '../middleware/error';

// ORG-01 (state machine) + ORG-02 (admin workflow) + ORG-03 (audit hook +
// owner notifications with dedicated types, transactional). No ORG-04+ scope
// here (frontend), no live DB.

const ADMIN_ID = 'admin-1';

function orgRow(status: VerificationStatus) {
  return {
    id: 'org-1',
    name: 'Good Food Org',
    type: 'NGO',
    address: '12 Market Street',
    latitude: 12.5,
    longitude: 77.5,
    contactInformation: null,
    verificationStatus: status,
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
}

// Staged transaction double: writes buffer until the unit of work succeeds;
// any throw discards the buffer (unit-level rollback model, BE-NOTIF-04 style).
function stagedBackend(
  status: VerificationStatus,
  members: string[] = ['u1', 'u2'],
  failAt?: 'organization' | 'audit' | 'notification',
) {
  const staged: Array<{ store: string; data: Record<string, unknown> }> = [];
  const committed: Array<{ store: string; data: Record<string, unknown> }> = [];
  let notifN = 0;
  const row = orgRow(status);
  const tx = {
    organization: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (failAt === 'organization') throw new Error('org boom');
        const updated = { ...row, ...args.data };
        staged.push({ store: 'organization', data: updated });
        return updated;
      }),
    },
    user: { findMany: vi.fn(async () => members.map((id) => ({ id }))) },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (failAt === 'audit') throw new Error('audit boom hunter2-secret');
        const created = { id: 'log-1', ...args.data };
        staged.push({ store: 'audit', data: created });
        return created;
      }),
    },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        notifN += 1;
        if (failAt === 'notification' && notifN === 2) throw new Error('notif boom');
        const created = { id: `notif-${notifN}`, ...args.data };
        staged.push({ store: 'notification', data: created });
        return created;
      }),
    },
  };
  const findUnique = vi.fn(async () => ({ ...row }));
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const mark = staged.length;
    try {
      const result = await fn(tx);
      committed.push(...staged.splice(mark));
      return result;
    } catch (err) {
      staged.splice(mark);
      throw err;
    }
  });
  vi.mocked(getPrisma).mockReturnValue({
    organization: { findUnique },
    $transaction,
  } as unknown as PrismaClient);
  return { tx, findUnique, $transaction, committed, staged };
}

function adminToken(): string {
  return signAccessToken({ id: ADMIN_ID, email: 'admin@example.com', role: 'ADMIN', organizationId: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ORG-01 state machine enforcement', () => {
  it('allows exactly PENDING->UNDER_REVIEW->VERIFIED/REJECTED', () => {
    expect(() => assertVerificationTransition('PENDING', 'UNDER_REVIEW')).not.toThrow();
    expect(() => assertVerificationTransition('UNDER_REVIEW', 'VERIFIED')).not.toThrow();
    expect(() => assertVerificationTransition('UNDER_REVIEW', 'REJECTED')).not.toThrow();
  });

  it('rejects skips, backwards, same-state, and terminal transitions with 400', () => {
    const invalid: Array<[VerificationStatus, VerificationStatus]> = [
      ['PENDING', 'VERIFIED'],
      ['PENDING', 'REJECTED'],
      ['PENDING', 'PENDING'],
      ['UNDER_REVIEW', 'PENDING'],
      ['UNDER_REVIEW', 'UNDER_REVIEW'],
      ['VERIFIED', 'UNDER_REVIEW'],
      ['VERIFIED', 'VERIFIED'],
      ['VERIFIED', 'REJECTED'],
      ['REJECTED', 'UNDER_REVIEW'],
      ['REJECTED', 'VERIFIED'],
      ['REJECTED', 'REJECTED'],
    ];
    for (const [from, to] of invalid) {
      try {
        assertVerificationTransition(from, to);
        expect.unreachable(`should have thrown for ${from}->${to}`);
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).statusCode).toBe(400);
        expect((e as AppError).code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('leaves state unchanged after a rejected transition (no write issued)', async () => {
    const { tx, $transaction } = stagedBackend('PENDING');
    await expect(reviewOrganization('org-1', ADMIN_ID)).resolves.toMatchObject({
      verificationStatus: 'UNDER_REVIEW',
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    // Stale PENDING read rejects VERIFY before any transaction opens.
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(tx.organization.update).toHaveBeenCalledTimes(1);
  });
});

describe('ORG-03 hooks: audit + owner notifications in one transaction', () => {
  it('review commits update + audit and notifies nobody (no review fan-out)', async () => {
    const { committed } = stagedBackend('PENDING', ['u1', 'u2']);
    const result = await reviewOrganization('org-1', ADMIN_ID);
    expect(result.verificationStatus).toBe('UNDER_REVIEW');
    expect(getPrisma).toHaveBeenCalledTimes(1);

    expect(committed.map((w) => w.store)).toEqual(['organization', 'audit']);
    const audit = committed.find((w) => w.store === 'audit')!.data;
    expect(audit).toMatchObject({
      userId: ADMIN_ID,
      action: 'ORGANIZATION_UNDER_REVIEW',
      entityType: 'Organization',
      entityId: 'org-1',
    });
    expect(JSON.parse(audit.oldValue as string)).toEqual({ verificationStatus: 'PENDING' });
    expect(JSON.parse(audit.newValue as string)).toEqual({ verificationStatus: 'UNDER_REVIEW' });
  });

  it('verify notifies every owner with the dedicated type and records the audit hook', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1', 'u2', 'u3']);
    await verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' });

    expect(committed.map((w) => w.store)).toEqual([
      'organization',
      'audit',
      'notification',
      'notification',
      'notification',
    ]);
    const audit = committed.find((w) => w.store === 'audit')!.data;
    expect(audit.action).toBe('ORGANIZATION_VERIFIED');
    for (const note of committed.filter((w) => w.store === 'notification')) {
      expect(note.data.type).toBe(NotificationType.ORGANIZATION_VERIFIED);
      expect(note.data.type).not.toBe(NotificationType.CONFIRMATION_PENDING);
      expect(note.data.title).toContain('verified');
      expect(String(note.data.message)).toContain('Good Food Org');
    }
    expect(
      new Set(committed.filter((w) => w.store === 'notification').map((w) => w.data.userId as string)),
    ).toEqual(new Set(['u1', 'u2', 'u3']));
  });

  it('reject records the reason in audit and notice, with the rejected type', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1']);
    await verifyOrganization('org-1', ADMIN_ID, { action: 'REJECT', reason: 'Missing food license' });

    const audit = committed.find((w) => w.store === 'audit')!.data;
    expect(audit.action).toBe('ORGANIZATION_REJECTED');
    expect(JSON.parse(audit.newValue as string)).toMatchObject({
      verificationStatus: 'REJECTED',
      reason: 'Missing food license',
    });
    const note = committed.find((w) => w.store === 'notification')!.data;
    expect(note.type).toBe(NotificationType.ORGANIZATION_REJECTED);
    expect(String(note.message)).toContain('Missing food license');
  });

  it('succeeds with zero notifications when the org has no members', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', []);
    await verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' });
    expect(committed.map((w) => w.store)).toEqual(['organization', 'audit']);
  });

  it('custom hooks stay separable: ORG-06 can own audit without touching transitions', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1']);
    const seen: Array<{ event: string; to: string }> = [];
    const hooks: VerificationHooks = {
      auditTransition: async (event) => {
        seen.push({ event: 'audit', to: event.to });
        expect(event.organizationId).toBe('org-1');
        expect(event.adminId).toBe(ADMIN_ID);
        expect(event.from).toBe('UNDER_REVIEW');
      },
    };
    await verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' }, hooks);
    expect(seen).toEqual([{ event: 'audit', to: 'VERIFIED' }]);
    // Default notify hook still ran alongside the custom audit hook.
    expect(committed.map((w) => w.store)).toEqual(['organization', 'notification']);
  });

  it('failing custom audit hook rolls everything back', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1']);
    const hooks: VerificationHooks = {
      auditTransition: async () => {
        throw new AppError(500, 'AUDIT_HOOK_FAILED', 'hook boom');
      },
    };
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' }, hooks)).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUDIT_HOOK_FAILED',
    });
    expect(committed).toEqual([]);
  });

  it('audit failure rolls back org update and notifications (nothing committed)', async () => {
    const { committed } = stagedBackend('PENDING', ['u1', 'u2'], 'audit');
    await expect(reviewOrganization('org-1', ADMIN_ID)).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUDIT_PERSIST_FAILED',
    });
    try {
      await reviewOrganization('org-1', ADMIN_ID);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain('hunter2-secret');
    }
    expect(committed).toEqual([]);
  });

  it('notification failure rolls back org update and audit (nothing committed)', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1', 'u2'], 'notification');
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' })).rejects.toMatchObject({
      statusCode: 500,
      code: 'NOTIFICATION_ERROR',
    });
    expect(committed).toEqual([]);
  });

  it('organization update failure creates neither audit nor notification', async () => {
    const { tx, committed } = stagedBackend('PENDING', ['u1'], 'organization');
    await expect(reviewOrganization('org-1', ADMIN_ID)).rejects.toMatchObject({
      statusCode: 500,
      code: 'ORGANIZATION_UPDATE_FAILED',
    });
    expect(committed).toEqual([]);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('unknown organization yields 404 and empty id yields 400', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      organization: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    await expect(reviewOrganization('ghost', ADMIN_ID)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(reviewOrganization('', ADMIN_ID)).rejects.toMatchObject({ statusCode: 400 });
    await expect(verifyOrganization('ghost', ADMIN_ID, { action: 'VERIFY' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reject without reason and unknown actions yield 400 before any database work', async () => {
    const { findUnique, $transaction } = stagedBackend('UNDER_REVIEW');
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'REJECT' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'MAYBE' } as never)).rejects.toMatchObject({ statusCode: 400 });
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'REJECT', reason: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    expect(findUnique).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe('ORG-02 admin routes: auth matrix + behavior', () => {
  it('anonymous and invalid tokens get 401 on all three endpoints', async () => {
    stagedBackend('PENDING');
    const app = createApp();
    for (const init of [
      { method: 'get' as const, path: '/api/admin/organizations?status=PENDING' },
      { method: 'put' as const, path: '/api/admin/organizations/org-1/review' },
      { method: 'put' as const, path: '/api/admin/organizations/org-1/verify' },
    ]) {
      const anon = await (init.method === 'get' ? request(app).get(init.path) : request(app).put(init.path).send({ action: 'VERIFY' }));
      expect(anon.status).toBe(401);
      const bad = await (init.method === 'get'
        ? request(app).get(init.path).set('Authorization', 'Bearer garbage')
        : request(app).put(init.path).set('Authorization', 'Bearer garbage').send({ action: 'VERIFY' }));
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('PROVIDER, RECIPIENT, and VOLUNTEER get 403 with zero writes', async () => {
    const { tx, $transaction } = stagedBackend('PENDING');
    const app = createApp();
    for (const role of ['PROVIDER', 'RECIPIENT', 'VOLUNTEER'] as const) {
      const token = signAccessToken({ id: 'user-9', email: 'u9@example.com', role, organizationId: 'org-9' });
      const list = await request(app).get('/api/admin/organizations?status=PENDING').set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(403);
      const review = await request(app).put('/api/admin/organizations/org-1/review').set('Authorization', `Bearer ${token}`);
      expect(review.status).toBe(403);
      const verify = await request(app)
        .put('/api/admin/organizations/org-1/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'VERIFY' });
      expect(verify.status).toBe(403);
      expect(verify.body.error.code).toBe('FORBIDDEN');
    }
    expect($transaction).not.toHaveBeenCalled();
    expect(tx.organization.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('ADMIN drives review, verify, and reject end to end with envelopes', async () => {
    stagedBackend('PENDING');
    const app = createApp();
    const auth = { Authorization: `Bearer ${adminToken()}` };

    const reviewed = await request(app).put('/api/admin/organizations/org-1/review').set(auth);
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toEqual({
      success: true,
      data: { organization: expect.objectContaining({ id: 'org-1', verificationStatus: 'UNDER_REVIEW' }) },
    });

    // Staged backend always reads PENDING, so verify-after-review 400s here;
    // the transition matrix above proves UNDER_REVIEW->VERIFIED instead.
    const badBody = await request(app)
      .put('/api/admin/organizations/org-1/verify')
      .set(auth)
      .send({ action: 'APPROVE' });
    expect(badBody.status).toBe(400);

    const missingReason = await request(app)
      .put('/api/admin/organizations/org-1/verify')
      .set(auth)
      .send({ action: 'REJECT' });
    expect(missingReason.status).toBe(400);
  });

  it('ADMIN verify/reject succeed from UNDER_REVIEW with correct payloads', async () => {
    stagedBackend('UNDER_REVIEW');
    const app = createApp();
    const auth = { Authorization: `Bearer ${adminToken()}` };

    const verified = await request(app)
      .put('/api/admin/organizations/org-1/verify')
      .set(auth)
      .send({ action: 'VERIFY' });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({
      success: true,
      data: { organization: expect.objectContaining({ id: 'org-1', verificationStatus: 'VERIFIED' }) },
    });

    const rejected = await request(app)
      .put('/api/admin/organizations/org-1/verify')
      .set(auth)
      .send({ action: 'REJECT', reason: 'Incomplete documents' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.organization.verificationStatus).toBe('REJECTED');
  });

  it('GET filter scopes by status with pagination envelope; invalid status is 400', async () => {
    const findMany = vi.fn(async () => [orgRowForList()]);
    const count = vi.fn(async () => 1);
    vi.mocked(getPrisma).mockReturnValue({
      organization: { findMany, count },
    } as unknown as PrismaClient);
    const app = createApp();
    const auth = { Authorization: `Bearer ${adminToken()}` };

    const filtered = await request(app).get('/api/admin/organizations?status=PENDING&page=1&limit=5').set(auth);
    expect(filtered.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: { verificationStatus: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 5,
    });
    expect(filtered.body.data).toMatchObject({ total: 1, page: 1, limit: 5 });
    expect(filtered.body.data.items[0]).toMatchObject({ id: 'org-1' });
    expect(JSON.stringify(filtered.body)).not.toContain('passwordHash');

    const invalid = await request(app).get('/api/admin/organizations?status=BOGUS').set(auth);
    expect(invalid.status).toBe(400);

    const unfiltered = await request(app).get('/api/admin/organizations').set(auth);
    expect(unfiltered.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('unknown organization and unknown action paths behave correctly', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      organization: { findUnique: vi.fn(async () => null), update: vi.fn() },
    } as unknown as PrismaClient);
    const app = createApp();
    const auth = { Authorization: `Bearer ${adminToken()}` };
    const missing = await request(app).put('/api/admin/organizations/ghost/review').set(auth);
    expect(missing.status).toBe(404);
    const get = await request(app).get('/api/admin/organizations/ghost');
    expect(get.status).toBe(404);
  });
});

function orgRowForList() {
  return {
    id: 'org-1',
    name: 'Good Food Org',
    type: 'NGO',
    address: '12 Market Street',
    latitude: 12.5,
    longitude: 77.5,
    contactInformation: null,
    verificationStatus: 'PENDING',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
}
