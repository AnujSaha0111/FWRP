import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma singleton so tests prove the supplied tx handle is
// used instead of the global client — no live DB required.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import { getPrisma } from '../lib/prisma';
import {
  auditService,
  persistAuditEvent,
  type AuditPersistenceClient,
} from '../services/audit.service';
import { AppError } from '../middleware/error';

function createMockTx() {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'log-1',
    ...args.data,
  }));
  const tx = { auditLog: { create } } as unknown as AuditPersistenceClient;
  return { tx, create };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BE-AUDIT-02 Audit Persistence Wiring', () => {
  it('creates an AuditLog row using the supplied transaction handle', async () => {
    const { tx, create } = createMockTx();
    const row = await auditService.persist(
      {
        actorId: 'user-123',
        action: 'VERIFY',
        entityType: 'Organization',
        entityId: 'org-123',
        oldValue: { status: 'PENDING' },
        newValue: { status: 'VERIFIED' },
      },
      tx,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(row.id).toBe('log-1');
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.userId).toBe('user-123');
    expect(data.action).toBe('VERIFY');
    expect(data.entityType).toBe('Organization');
    expect(data.entityId).toBe('org-123');
    expect(JSON.parse(data.oldValue as string)).toEqual({ status: 'PENDING' });
    expect(JSON.parse(data.newValue as string)).toEqual({ status: 'VERIFIED' });
  });

  it('accepts { tx } options bag', async () => {
    const { tx, create } = createMockTx();
    await persistAuditEvent(
      { actorId: 'u1', action: 'CREATE', entityType: 'User', entityId: 'u1' },
      { tx },
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('accepts { transaction } alias', async () => {
    const { tx, create } = createMockTx();
    await auditService.persist(
      { actorId: 'u1', action: 'CREATE', entityType: 'User', entityId: 'u1' },
      { transaction: tx },
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('trims actor/action/entity fields when mapping', async () => {
    const { tx, create } = createMockTx();
    await auditService.persist(
      {
        actorId: '  user-1  ',
        action: '  UPDATE  ',
        entityType: '  Donation  ',
        entityId: '  donation-1  ',
      },
      tx,
    );
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.userId).toBe('user-1');
    expect(data.action).toBe('UPDATE');
    expect(data.entityType).toBe('Donation');
    expect(data.entityId).toBe('donation-1');
  });

  it('actorId null/undefined maps to userId null', async () => {
    const { tx, create } = createMockTx();
    await auditService.persist(
      { actorId: null, action: 'SYSTEM_EXPIRE', entityType: 'Donation', entityId: 'd1' },
      tx,
    );
    expect((create.mock.calls[0][0].data as Record<string, unknown>).userId).toBeNull();

    const mock2 = createMockTx();
    await auditService.persist(
      { action: 'CREATE', entityType: 'User', entityId: 'u1' },
      mock2.tx,
    );
    expect((mock2.create.mock.calls[0][0].data as Record<string, unknown>).userId).toBeNull();
  });

  it('oldValue/newValue use deterministic redacted serialization', async () => {
    const { tx, create } = createMockTx();
    await auditService.persist(
      {
        actorId: 'u1',
        action: 'UPDATE',
        entityType: 'User',
        entityId: 'u1',
        oldValue: { b: 2, a: 1, password: 'secret123', token: 'jwt-token' },
        newValue: { z: 3, m: 4, secret: 'shh' },
      },
      tx,
    );
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    // Deterministic: keys sorted
    expect(data.oldValue as string).toBe(
      JSON.stringify({ a: 1, b: 2, password: '[REDACTED]', token: '[REDACTED]' }),
    );
    expect(data.newValue as string).toBe(
      JSON.stringify({ m: 4, secret: '[REDACTED]', z: 3 }),
    );
    // Same logical payload in different key order → identical stored value
    const mock2 = createMockTx();
    await auditService.persist(
      {
        actorId: 'u1',
        action: 'UPDATE',
        entityType: 'User',
        entityId: 'u1',
        oldValue: { a: 1, b: 2, token: 'jwt-token', password: 'secret123' },
        newValue: { m: 4, z: 3, secret: 'shh' },
      },
      mock2.tx,
    );
    expect((mock2.create.mock.calls[0][0].data as Record<string, unknown>).oldValue).toBe(
      data.oldValue,
    );
    expect(JSON.stringify(data)).not.toContain('secret123');
    expect(JSON.stringify(data)).not.toContain('jwt-token');
  });

  it('null oldValue/newValue map to null', async () => {
    const { tx, create } = createMockTx();
    await auditService.persist(
      {
        actorId: 'u1',
        action: 'CREATE',
        entityType: 'User',
        entityId: 'u1',
        oldValue: null,
        newValue: null,
      },
      tx,
    );
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.oldValue).toBeNull();
    expect(data.newValue).toBeNull();
  });

  it('timestamp is populated as a recent Date', async () => {
    const { tx, create } = createMockTx();
    const before = Date.now();
    await auditService.persist(
      { actorId: 'u1', action: 'TEST', entityType: 'User', entityId: 'u1' },
      tx,
    );
    const after = Date.now();
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.timestamp).toBeInstanceOf(Date);
    const ts = (data.timestamp as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('uses the supplied tx handle and NOT the global Prisma client', async () => {
    const { tx, create } = createMockTx();
    await auditService.persist(
      { actorId: 'u1', action: 'TEST', entityType: 'User', entityId: 'u1' },
      tx,
    );
    expect(create).toHaveBeenCalledTimes(1);
    // Global singleton must never be touched when a handle is supplied —
    // this also proves no separate transaction is opened around the insert.
    expect(getPrisma).not.toHaveBeenCalled();
  });

  it('falls back to the global client when no handle is supplied', async () => {
    const globalCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'log-global',
      ...args.data,
    }));
    vi.mocked(getPrisma).mockReturnValue({
      auditLog: { create: globalCreate },
    } as unknown as ReturnType<typeof getPrisma>);
    const row = await auditService.persist({
      actorId: 'u1',
      action: 'TEST',
      entityType: 'User',
      entityId: 'u1',
    });
    expect(getPrisma).toHaveBeenCalledTimes(1);
    expect(globalCreate).toHaveBeenCalledTimes(1);
    expect(row.id).toBe('log-global');
  });

  it('persistence errors do not leak sensitive/database internals', async () => {
    const create = vi.fn(async () => {
      throw new Error(
        'insert into audit_logs failed: password=mySecretPw token=myJwtToken DATABASE_URL=postgres://user:pass@host/db',
      );
    });
    const tx = { auditLog: { create } } as unknown as AuditPersistenceClient;
    try {
      await auditService.persist(
        { actorId: 'u1', action: 'TEST', entityType: 'User', entityId: 'u1' },
        tx,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe('AUDIT_PERSIST_FAILED');
      const blob = err.message + JSON.stringify(err.details ?? '');
      expect(blob).not.toContain('mySecretPw');
      expect(blob).not.toContain('myJwtToken');
      expect(blob).not.toContain('postgres://');
      expect(blob).not.toContain('insert into');
    }
  });

  it('invalid input is rejected before touching the database', async () => {
    const { tx, create } = createMockTx();
    try {
      await auditService.persist(
        { actorId: 'u1', action: '', entityType: 'User', entityId: 'u1' } as never,
        tx,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(400);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('exposes no UPDATE/DELETE capability (append-only intent preserved)', () => {
    expect((auditService as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((auditService as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((auditService as unknown as Record<string, unknown>).updateAudit).toBeUndefined();
    expect((auditService as unknown as Record<string, unknown>).remove).toBeUndefined();
    expect(typeof auditService.persist).toBe('function');
  });

  it('BE-AUDIT-01 behavior remains intact alongside persistence', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'VERIFY',
      entityType: 'Organization',
      entityId: 'org-1',
      oldValue: { password: 'pw', keep: 'v' },
    });
    expect(event.actor).toBe('user-1');
    expect(event.action).toBe('VERIFY');
    expect(JSON.parse(event.oldValue as string)).toEqual({ keep: 'v', password: '[REDACTED]' });
    expect(auditService.serializeValue(null)).toBeNull();
  });
});
