import type { AuditLog, PrismaClient } from '@prisma/client';
import { AppError } from '../middleware/error';
import { getPrisma } from '../lib/prisma';

export interface AuditLogInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface AuditEvent {
  actor: string | null;
  entity: { type: string; id: string };
  action: string;
  timestamp: string; // ISO UTC
  oldValue: string | null;
  newValue: string | null;
}

// Lightweight redaction — never store passwords/hashes/tokens
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'jwt',
  'authorization',
  'cookie',
  'hash',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitize(v);
      }
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  // Deterministic: sort keys recursively via sanitized value
  const sanitized = sanitize(value);
  return JSON.stringify(sanitized, (key, val) => {
    if (isPlainObject(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

export function serializeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    // If string looks like JSON, try to sanitize deterministically
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return stableStringify(parsed);
      } catch {
        // Not valid JSON, return as-is (but ensure no secret leakage by not storing raw token-like strings?)
        // We keep string as-is but redact if key-like? For string we cannot know key, so return as-is
        return value;
      }
    }
    return value;
  }
  // For objects/arrays/numbers/booleans, stringify deterministically with redaction
  try {
    return stableStringify(value);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit value is not serializable');
  }
}

function validateInput(input: AuditLogInput): void {
  if (!input || typeof input !== 'object') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit input is required');
  }
  if (typeof input.action !== 'string' || input.action.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit action is required');
  }
  if (typeof input.entityType !== 'string' || input.entityType.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit entityType is required');
  }
  if (typeof input.entityId !== 'string' || input.entityId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit entityId is required');
  }
  if (input.actorId !== undefined && input.actorId !== null && typeof input.actorId !== 'string') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit actorId must be string or null');
  }
  if (input.actorId !== null && input.actorId !== undefined && (input.actorId as string).trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit actorId must be non-empty string or null');
  }
  // oldValue/newValue serializability checked in serializeValue
  if (input.oldValue !== undefined && typeof input.oldValue === 'function') {
    throw new AppError(400, 'VALIDATION_ERROR', 'oldValue is not serializable');
  }
  if (input.newValue !== undefined && typeof input.newValue === 'function') {
    throw new AppError(400, 'VALIDATION_ERROR', 'newValue is not serializable');
  }
  if (typeof input.oldValue === 'symbol' || typeof input.newValue === 'symbol') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Audit value is not serializable');
  }
}

function sanitizeString(v: unknown): unknown {
  if (typeof v === 'string') return v.trim();
  return v;
}

export function createAuditEvent(input: AuditLogInput): AuditEvent {
  validateInput(input);
  const timestamp = new Date().toISOString();
  // Validate timestamp is valid ISO
  if (isNaN(Date.parse(timestamp))) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Failed to generate timestamp');
  }
  return {
    actor: input.actorId ? input.actorId.trim() : null,
    entity: { type: input.entityType.trim(), id: input.entityId.trim() },
    action: input.action.trim(),
    timestamp,
    oldValue: serializeValue(input.oldValue ?? null),
    newValue: serializeValue(input.newValue ?? null),
  };
}

// Foundation service — creation/logging only, append-only intent.
// BE-AUDIT-02: transactional persistence via persist() below. The caller
// supplies its Prisma transaction handle so the AuditLog insert participates
// in the SAME transaction as the business state change. When a handle is
// supplied it is used directly — no separate transaction is created.
export type AuditPersistenceClient = Pick<PrismaClient, 'auditLog'>;

export interface AuditPersistOptions {
  tx?: AuditPersistenceClient;
  transaction?: AuditPersistenceClient;
}

export type AuditPersistTx = AuditPersistenceClient | AuditPersistOptions | null | undefined;

function resolvePersistenceClient(txOrOptions: AuditPersistTx): AuditPersistenceClient | null {
  if (!txOrOptions) return null;
  if (typeof (txOrOptions as AuditPersistenceClient).auditLog !== 'undefined') {
    return txOrOptions as AuditPersistenceClient;
  }
  const opts = txOrOptions as AuditPersistOptions;
  return opts.tx ?? opts.transaction ?? null;
}

export async function persistAuditEvent(
  input: AuditLogInput,
  txOrOptions?: AuditPersistTx,
): Promise<AuditLog> {
  // Validate + build deterministic/redacted values first (400 on bad input).
  const event = createAuditEvent(input);
  // Use the caller's transaction handle when supplied; otherwise fall back
  // to the global Prisma singleton. Never open a separate transaction here.
  const client: AuditPersistenceClient = resolvePersistenceClient(txOrOptions) ?? getPrisma();
  const data = {
    userId: event.actor,
    action: event.action,
    entityType: event.entity.type,
    entityId: event.entity.id,
    oldValue: event.oldValue,
    newValue: event.newValue,
    timestamp: new Date(event.timestamp),
  };
  try {
    return await client.auditLog.create({ data });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Never leak SQL, connection strings, credentials, or payload values.
    throw new AppError(500, 'AUDIT_PERSIST_FAILED', 'Failed to persist audit event');
  }
}

export interface AuditService {
  log(input: AuditLogInput): AuditEvent;
  createEvent(input: AuditLogInput): AuditEvent;
  serializeValue(value: unknown): string | null;
  persist(input: AuditLogInput, txOrOptions?: AuditPersistTx): Promise<AuditLog>;
}

export const auditService: AuditService = {
  log(input: AuditLogInput): AuditEvent {
    return createAuditEvent(input);
  },
  createEvent(input: AuditLogInput): AuditEvent {
    return createAuditEvent(input);
  },
  serializeValue,
  persist(input: AuditLogInput, txOrOptions?: AuditPersistTx): Promise<AuditLog> {
    return persistAuditEvent(input, txOrOptions);
  },
};

// Note: No update/delete methods — append-only by design. Phase 16 will enforce DB-level immutability.
