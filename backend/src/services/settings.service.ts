import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { DEFAULT_MATCHING_WEIGHTS, getMatchingConfig, type MatchingConfig } from '../config/matching';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { logger } from '../utils/logger';
import { persistAuditEvent } from './audit.service';

// ---------------------------------------------------------------------------
// ADMIN-04: administrator-configurable system parameters (PRD §7.4 "Configure
// system parameters"). Every key has a schema and a default; the database only
// stores overrides. Reads are cached briefly; an update clears the cache, so
// the matching engine and alert job pick changes up on their next run.
//
// If settings cannot be read, defaults apply (logged): configuration must
// never take the matching or alert pipeline down.

const weightsSchema = z
  .object({
    distance: z.number().min(0).max(1),
    food: z.number().min(0).max(1),
    quantity: z.number().min(0).max(1),
    priority: z.number().min(0).max(1),
    urgency: z.number().min(0).max(1),
    transport: z.number().min(0).max(1),
  })
  .strict()
  .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) > 0, { message: 'At least one weight must be positive' });

export const SETTINGS = {
  'matching.maxDistanceKm': {
    description: 'Matching radius in km; farther pairs are never recommended.',
    schema: z.number().positive().max(20000),
    default: () => env.MATCHING_MAX_DISTANCE_KM,
  },
  'matching.weights': {
    description: 'Score weights (normalized by their sum).',
    schema: weightsSchema,
    default: () => ({ ...DEFAULT_MATCHING_WEIGHTS }),
  },
  'matching.urgencyHorizonHours': {
    description: 'Deadlines this far away or more score 0 urgency.',
    schema: z.number().positive().max(168),
    default: () => 24,
  },
  'alerts.leadMinutes': {
    description: 'Expiry warnings and pickup reminders are sent this long before the deadline.',
    schema: z.number().int().min(5).max(1440),
    default: () => 60,
  },
  'alerts.deliveryDelayMinutes': {
    description: 'A picked-up delivery not delivered after this long is flagged as delayed.',
    schema: z.number().int().min(15).max(2880),
    default: () => 120,
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValues = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]['schema']> };

const KEYS = Object.keys(SETTINGS) as SettingKey[];
const CACHE_MS = 30 * 1000;
let cache: { values: SettingValues; at: number } | null = null;

export function clearSettingsCache(): void {
  cache = null;
}

function defaults(): SettingValues {
  return Object.fromEntries(KEYS.map((k) => [k, SETTINGS[k].default()])) as SettingValues;
}

/** Current values (overrides on top of defaults). Invalid stored values fall back to the default. */
export async function getSettings(client?: PrismaClient, now: number = Date.now()): Promise<SettingValues> {
  if (cache && now - cache.at < CACHE_MS) return cache.values;
  const values = defaults();
  try {
    const rows = await (client ?? getPrisma()).systemSetting.findMany({ where: { key: { in: KEYS } } });
    for (const row of rows) {
      const key = row.key as SettingKey;
      const parsed = SETTINGS[key].schema.safeParse(row.value);
      if (parsed.success) (values as Record<string, unknown>)[key] = parsed.data;
      else logger.warn({ key }, 'Ignoring invalid stored setting; using default');
    }
    cache = { values, at: now };
  } catch {
    logger.warn('Settings unavailable; using defaults');
  }
  return values;
}

/** MATCH-06 configuration with administrator overrides applied. */
export async function loadMatchingConfig(): Promise<MatchingConfig> {
  const s = await getSettings();
  return {
    ...getMatchingConfig(),
    weights: { ...s['matching.weights'] },
    maxDistanceKm: s['matching.maxDistanceKm'],
    urgencyHorizonMs: s['matching.urgencyHorizonHours'] * 60 * 60 * 1000,
  };
}

export interface SettingView {
  key: SettingKey;
  value: unknown;
  default: unknown;
  description: string;
  overridden: boolean;
  updatedAt: Date | null;
  updatedBy: { id: string; name: string } | null;
}

async function requireAdmin(client: PrismaClient, userId: string) {
  const user = await client.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (user.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
  return user;
}

export async function listSettings(userId: string): Promise<{ settings: SettingView[] }> {
  const client = getPrisma();
  await requireAdmin(client, userId);
  const rows = await client.systemSetting.findMany({
    where: { key: { in: KEYS } },
    select: { key: true, value: true, updatedAt: true, updatedBy: { select: { id: true, name: true } } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  clearSettingsCache();
  const current = await getSettings(client);
  return {
    settings: KEYS.map((key) => {
      const row = byKey.get(key);
      return {
        key,
        value: current[key],
        default: SETTINGS[key].default(),
        description: SETTINGS[key].description,
        overridden: Boolean(row),
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    }),
  };
}

/** Body: `{ "<key>": value | null }`; null restores the default. Validated all-or-nothing. */
export const updateSettingsSchema = z
  .record(z.unknown())
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one setting is required' });

export async function updateSettings(userId: string, input: unknown): Promise<{ settings: SettingView[] }> {
  const parsed = updateSettingsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const details: Array<{ field: string; message: string }> = [];
  const changes: Array<{ key: SettingKey; value: unknown | null }> = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!(key in SETTINGS)) {
      details.push({ field: key, message: 'Unknown setting' });
      continue;
    }
    if (value === null) {
      changes.push({ key: key as SettingKey, value: null });
      continue;
    }
    const check = SETTINGS[key as SettingKey].schema.safeParse(value);
    if (!check.success) {
      for (const issue of formatZodError(check.error)) {
        details.push({ field: issue.field ? `${key}.${issue.field}` : key, message: issue.message });
      }
    } else {
      changes.push({ key: key as SettingKey, value: check.data });
    }
  }
  if (details.length > 0) throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', details);

  const client = getPrisma();
  const admin = await requireAdmin(client, userId);
  const before = await getSettings(client, 0);
  try {
    await client.$transaction(async (tx) => {
      for (const { key, value } of changes) {
        if (value === null) {
          await tx.systemSetting.deleteMany({ where: { key } });
        } else {
          const json = value as Prisma.InputJsonValue;
          await tx.systemSetting.upsert({
            where: { key },
            create: { key, value: json, updatedById: admin.id },
            update: { value: json, updatedById: admin.id },
          });
        }
        await persistAuditEvent(
          {
            actorId: admin.id,
            action: value === null ? 'SETTING_RESET' : 'SETTING_UPDATED',
            entityType: 'SystemSetting',
            entityId: key,
            oldValue: before[key],
            newValue: value === null ? SETTINGS[key].default() : value,
          },
          tx
        );
      }
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'SETTINGS_UPDATE_FAILED', 'Settings update failed');
  } finally {
    clearSettingsCache();
  }
  return listSettings(userId);
}
