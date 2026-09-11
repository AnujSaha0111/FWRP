import { describe, it, expect } from 'vitest';
import { auditService, createAuditEvent, serializeValue } from '../services/audit.service';
import { AppError } from '../middleware/error';

describe('BE-AUDIT-01 Audit Service Foundation', () => {
  it('valid audit event input → creates event', () => {
    const event = auditService.log({
      actorId: 'user-123',
      action: 'VERIFY',
      entityType: 'Organization',
      entityId: 'org-123',
      oldValue: { status: 'PENDING' },
      newValue: { status: 'VERIFIED' },
    });
    expect(event.actor).toBe('user-123');
    expect(event.action).toBe('VERIFY');
    expect(event.entity.type).toBe('Organization');
    expect(event.entity.id).toBe('org-123');
  });

  it('actor/entity/action fields preserved correctly (trimmed)', () => {
    const event = createAuditEvent({
      actorId: '  user-1  ',
      action: '  UPDATE  ',
      entityType: '  Donation  ',
      entityId: '  donation-1  ',
    });
    expect(event.actor).toBe('user-1');
    expect(event.action).toBe('UPDATE');
    expect(event.entity.type).toBe('Donation');
    expect(event.entity.id).toBe('donation-1');
  });

  it('actorId null allowed for system actions', () => {
    const event = auditService.log({
      actorId: null,
      action: 'SYSTEM_EXPIRE',
      entityType: 'Donation',
      entityId: 'donation-1',
    });
    expect(event.actor).toBeNull();
  });

  it('actorId undefined treated as null', () => {
    const event = createAuditEvent({
      action: 'CREATE',
      entityType: 'User',
      entityId: 'user-1',
    });
    expect(event.actor).toBeNull();
  });

  it('oldValue/newValue handling — object → JSON string', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'UPDATE',
      entityType: 'Donation',
      entityId: 'd1',
      oldValue: { quantity: 10, status: 'AVAILABLE' },
      newValue: { quantity: 10, status: 'ACCEPTED' },
    });
    expect(typeof event.oldValue).toBe('string');
    expect(JSON.parse(event.oldValue!)).toEqual({ quantity: 10, status: 'AVAILABLE' });
    expect(JSON.parse(event.newValue!)).toEqual({ quantity: 10, status: 'ACCEPTED' });
  });

  it('oldValue/newValue null → null', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'CREATE',
      entityType: 'User',
      entityId: 'user-1',
      oldValue: null,
      newValue: null,
    });
    expect(event.oldValue).toBeNull();
    expect(event.newValue).toBeNull();
  });

  it('timestamp is generated and is valid UTC ISO', () => {
    const before = Date.now();
    const event = auditService.log({
      actorId: 'user-1',
      action: 'TEST',
      entityType: 'User',
      entityId: 'user-1',
    });
    const after = Date.now();
    const ts = Date.parse(event.timestamp);
    expect(isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(event.timestamp).toBe(new Date(event.timestamp).toISOString());
    expect(event.timestamp.endsWith('Z')).toBe(true);
  });

  it('structured oldValue/newValue handled deterministically (sorted keys)', () => {
    const event1 = auditService.log({
      actorId: 'user-1',
      action: 'UPDATE',
      entityType: 'Donation',
      entityId: 'd1',
      oldValue: { b: 2, a: 1 },
      newValue: { z: 3, m: 4 },
    });
    const event2 = auditService.log({
      actorId: 'user-1',
      action: 'UPDATE',
      entityType: 'Donation',
      entityId: 'd1',
      oldValue: { a: 1, b: 2 },
      newValue: { m: 4, z: 3 },
    });
    expect(event1.oldValue).toBe(event2.oldValue);
    expect(event1.newValue).toBe(event2.newValue);
  });

  it('sensitive values are redacted', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'UPDATE',
      entityType: 'User',
      entityId: 'user-1',
      oldValue: { name: 'Alice', password: 'secret123', passwordHash: 'hash123', token: 'jwt-token' },
      newValue: { name: 'Alice', secret: 'shh', accessToken: 'abc' },
    });
    const oldParsed = JSON.parse(event.oldValue!);
    const newParsed = JSON.parse(event.newValue!);
    expect(oldParsed.password).toBe('[REDACTED]');
    expect(oldParsed.passwordHash).toBe('[REDACTED]');
    expect(oldParsed.token).toBe('[REDACTED]');
    expect(newParsed.secret).toBe('[REDACTED]');
    expect(newParsed.accessToken).toBe('[REDACTED]');
    expect(JSON.stringify(event)).not.toContain('secret123');
    expect(JSON.stringify(event)).not.toContain('hash123');
    expect(JSON.stringify(event)).not.toContain('jwt-token');
  });

  it('nested sensitive values are redacted', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'UPDATE',
      entityType: 'User',
      entityId: 'user-1',
      oldValue: { nested: { password: 'pw', inner: { token: 't' } }, keep: 'value' },
    });
    const parsed = JSON.parse(event.oldValue!);
    expect(parsed.nested.password).toBe('[REDACTED]');
    expect(parsed.nested.inner.token).toBe('[REDACTED]');
    expect(parsed.keep).toBe('value');
  });

  it('string JSON oldValue is sanitized deterministically', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'UPDATE',
      entityType: 'User',
      entityId: 'user-1',
      oldValue: JSON.stringify({ b: 2, a: 1, password: 'secret' }),
    });
    const parsed = JSON.parse(event.oldValue!);
    expect(parsed.a).toBe(1);
    expect(parsed.password).toBe('[REDACTED]');
  });

  it('invalid required input is rejected (AppError 400)', () => {
    expect(() => auditService.log({ actorId: 'user-1', action: '', entityType: 'User', entityId: 'user-1' } as any)).toThrow(AppError);
    try {
      auditService.log({ actorId: 'user-1', action: '', entityType: 'User', entityId: 'user-1' } as any);
    } catch (e) {
      expect((e as AppError).statusCode).toBe(400);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
    }
    expect(() => auditService.log({ actorId: 'user-1', action: 'TEST', entityType: '', entityId: 'user-1' } as any)).toThrow(AppError);
    expect(() => auditService.log({ actorId: 'user-1', action: 'TEST', entityType: 'User', entityId: '' } as any)).toThrow(AppError);
    expect(() => auditService.log({ actorId: 'user-1', action: 'TEST', entityType: 'User', entityId: 'user-1', oldValue: () => {} } as any)).toThrow(AppError);
    expect(() => auditService.log({ actorId: 123 as any, action: 'TEST', entityType: 'User', entityId: 'user-1' })).toThrow(AppError);
  });

  it('service does not expose UPDATE/DELETE functionality', () => {
    expect((auditService as any).update).toBeUndefined();
    expect((auditService as any).delete).toBeUndefined();
    expect((auditService as any).updateAudit).toBeUndefined();
    expect((auditService as any).remove).toBeUndefined();
    // Only expected methods (BE-AUDIT-02 adds persist; still no UPDATE/DELETE)
    expect(typeof auditService.log).toBe('function');
    expect(typeof auditService.createEvent).toBe('function');
    expect(typeof auditService.serializeValue).toBe('function');
    expect(typeof auditService.persist).toBe('function');
    expect(Object.keys(auditService).sort()).toEqual(['createEvent', 'log', 'persist', 'serializeValue'].sort());
  });

  it('no JWT/password/token leakage in errors', () => {
    const secretPayload = { password: 'mySecretPw', token: 'myJwtToken', secret: 'shh' };
    try {
      auditService.log({ actorId: 'user-1', action: '', entityType: 'User', entityId: 'user-1', oldValue: secretPayload } as any);
    } catch (e) {
      const msg = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(msg).not.toContain('mySecretPw');
      expect(msg).not.toContain('myJwtToken');
      expect(msg).not.toContain('shh');
    }
    // Valid log should also not leak when serializing
    const event = auditService.log({
      actorId: 'user-1',
      action: 'TEST',
      entityType: 'User',
      entityId: 'user-1',
      oldValue: { password: 'mySecretPw' },
    });
    expect(event.oldValue).not.toContain('mySecretPw');
    expect(event.oldValue).toContain('[REDACTED]');
  });

  it('serializeValue handles primitives deterministically', () => {
    expect(serializeValue(null)).toBeNull();
    expect(serializeValue(undefined)).toBeNull();
    expect(serializeValue('plain string')).toBe('plain string');
    expect(serializeValue(123 as any)).toBe('123');
  });

  it('createEvent and log produce same structure', () => {
    const input = { actorId: 'user-1', action: 'TEST', entityType: 'User', entityId: 'user-1', oldValue: { a: 1 } };
    const e1 = auditService.log(input);
    const e2 = auditService.createEvent(input);
    expect(e1.action).toBe(e2.action);
    expect(e1.entity).toEqual(e2.entity);
    expect(e1.actor).toBe(e2.actor);
    // timestamps will differ slightly but both valid
    expect(Date.parse(e1.timestamp)).not.toBeNaN();
    expect(Date.parse(e2.timestamp)).not.toBeNaN();
  });
});
