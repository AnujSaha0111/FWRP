import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. The REAL default audit
// hook (persistAuditEvent) runs against staged doubles, adopting the ORG-03
// hook as the final ORG-06 contract: no second audit path is introduced.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient, VerificationStatus } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { reviewOrganization, verifyOrganization } from '../services/organizations.service';
import { signAccessToken } from '../utils/jwt';

// ORG-06: every verify/reject/review writes exactly one AuditLog with actor,
// entity, old/new value, timestamp — atomically with the status update.
// Notification behavior (ORG-03) is asserted jointly to prove it stays atomic
// alongside. No ORG-07 scope, no live DB.

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

function stagedBackend(status: VerificationStatus, members: string[] = ['u1'], failAudit = false) {
  const staged: Array<{ store: string; data: Record<string, unknown> }> = [];
  const committed: Array<{ store: string; data: Record<string, unknown> }> = [];
  let notifN = 0;
  const row = orgRow(status);
  const tx = {
    organization: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const updated = { ...row, ...args.data };
        staged.push({ store: 'organization', data: updated });
        return updated;
      }),
    },
    user: { findMany: vi.fn(async () => members.map((id) => ({ id }))) },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (failAudit) throw new Error('audit boom hunter2-secret');
        const created = { id: 'log-1', ...args.data };
        staged.push({ store: 'audit', data: created });
        return created;
      }),
    },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        notifN += 1;
        const created = { id: `notif-${notifN}`, ...args.data };
        staged.push({ store: 'notification', data: created });
        return created;
      }),
    },
  };
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
    organization: { findUnique: vi.fn(async () => ({ ...row })) },
    $transaction,
  } as unknown as PrismaClient);
  return { tx, $transaction, committed };
}

function auditOf(committed: Array<{ store: string; data: Record<string, unknown> }>) {
  const rows = committed.filter((w) => w.store === 'audit');
  expect(rows).toHaveLength(1);
  return rows[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ORG-06 one audit per transition with actor/entity/old/new/timestamp', () => {
  it('PENDING -> UNDER_REVIEW writes exactly one UNDER_REVIEW audit', async () => {
    const before = Date.now();
    const { committed } = stagedBackend('PENDING', []);
    const result = await reviewOrganization('org-1', ADMIN_ID);
    expect(result.verificationStatus).toBe('UNDER_REVIEW');

    const audit = auditOf(committed);
    expect(audit.userId).toBe(ADMIN_ID);
    expect(audit.action).toBe('ORGANIZATION_UNDER_REVIEW');
    expect(audit.entityType).toBe('Organization');
    expect(audit.entityId).toBe('org-1');
    expect(JSON.parse(audit.oldValue as string)).toEqual({ verificationStatus: 'PENDING' });
    expect(JSON.parse(audit.newValue as string)).toEqual({ verificationStatus: 'UNDER_REVIEW' });
    const ts = (audit.timestamp as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('UNDER_REVIEW -> VERIFIED writes exactly one VERIFIED audit', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', []);
    await verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' });
    const audit = auditOf(committed);
    expect(audit.userId).toBe(ADMIN_ID);
    expect(audit.action).toBe('ORGANIZATION_VERIFIED');
    expect(audit.entityType).toBe('Organization');
    expect(audit.entityId).toBe('org-1');
    expect(JSON.parse(audit.oldValue as string)).toEqual({ verificationStatus: 'UNDER_REVIEW' });
    expect(JSON.parse(audit.newValue as string)).toEqual({ verificationStatus: 'VERIFIED' });
  });

  it('UNDER_REVIEW -> REJECTED writes exactly one REJECTED audit carrying the reason', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', []);
    await verifyOrganization('org-1', ADMIN_ID, { action: 'REJECT', reason: 'Missing license' });
    const audit = auditOf(committed);
    expect(audit.action).toBe('ORGANIZATION_REJECTED');
    expect(JSON.parse(audit.newValue as string)).toEqual({ verificationStatus: 'REJECTED', reason: 'Missing license' });
    expect(JSON.stringify(audit)).not.toContain('password');
  });

  it('route-level audit actor is the authenticated admin from the session', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', []);
    const app = createApp();
    const token = signAccessToken({ id: ADMIN_ID, email: 'admin@example.com', role: 'ADMIN', organizationId: null });
    const res = await request(app)
      .put('/api/admin/organizations/org-1/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'VERIFY' });
    expect(res.status).toBe(200);
    expect(auditOf(committed).userId).toBe(ADMIN_ID);
  });
});

describe('ORG-06 no audit on failure, atomicity with status and notifications', () => {
  it('invalid transition, unknown org, and non-admin write zero audits', async () => {
    const { tx, $transaction } = stagedBackend('PENDING');
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' })).rejects.toMatchObject({ statusCode: 400 });
    expect($transaction).not.toHaveBeenCalled();

    vi.mocked(getPrisma).mockReturnValue({
      organization: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    await expect(reviewOrganization('ghost', ADMIN_ID)).rejects.toMatchObject({ statusCode: 404 });

    stagedBackend('PENDING');
    const app = createApp();
    const forbidden = await request(app)
      .put('/api/admin/organizations/org-1/review')
      .set('Authorization', `Bearer ${signAccessToken({ id: 'u9', email: 'u9@example.com', role: 'PROVIDER', organizationId: 'org-9' })}`);
    expect(forbidden.status).toBe(403);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('audit failure rolls the status update back (nothing committed)', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1'], true);
    await expect(verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' })).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUDIT_PERSIST_FAILED',
    });
    expect(committed).toEqual([]);
  });

  it('audit and notifications stay atomic with the status update', async () => {
    const { committed } = stagedBackend('UNDER_REVIEW', ['u1', 'u2']);
    await verifyOrganization('org-1', ADMIN_ID, { action: 'VERIFY' });
    expect(committed.map((w) => w.store)).toEqual(['organization', 'audit', 'notification', 'notification']);
  });
});
