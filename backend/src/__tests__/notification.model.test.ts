import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotificationType, Prisma } from '@prisma/client';

// BE-NOTIF-01: Notification model/schema wiring verification.
// DB-08 created the Notification model + 10 PRD §17 NotificationType values;
// ORG-03 added ORGANIZATION_VERIFIED + ORGANIZATION_REJECTED for owner
// notices on verification outcomes (own forward migration, no live DB).
// These tests verify the wiring using only the generated Prisma client DMMF
// and static files — no live database.

const EXPECTED_TYPES = [
  'DONATION_CREATED',
  'DONATION_MATCHED',
  'DONATION_ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKUP_REMINDER',
  'DELIVERY_DELAYED',
  'EXPIRY_WARNING',
  'DONATION_EXPIRED',
  'DELIVERY_COMPLETED',
  'CONFIRMATION_PENDING',
  'ORGANIZATION_VERIFIED',
  'ORGANIZATION_REJECTED',
] as const;

const EXPECTED_MODELS = [
  'User',
  'Organization',
  'Donation',
  'Requirement',
  'Category',
  'Match',
  'Delivery',
  'Notification',
  'AuditLog',
];

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

function notificationBlock(): string {
  const text = readRepoFile('prisma', 'schema.prisma');
  const start = text.indexOf('model Notification {');
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('BE-NOTIF-01 Notification model/schema wiring', () => {
  it('NotificationType covers all 10 PRD §17 events plus the 2 ORG-03 verification outcomes', () => {
    expect(Object.values(NotificationType)).toEqual([...EXPECTED_TYPES]);
  });

  it('Notification model has the DB-08/PRD §24.7 shape', () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Notification');
    expect(model).toBeDefined();
    expect(model!.dbName).toBe('notifications');
    const byName = new Map(model!.fields.map((f) => [f.name, f]));

    const id = byName.get('id')!;
    expect(id.type).toBe('String');
    expect(id.isRequired).toBe(true);
    expect(id.dbName).toBe('notification_id');

    const userId = byName.get('userId')!;
    expect(userId.type).toBe('String');
    expect(userId.kind).toBe('scalar');
    expect(userId.isRequired).toBe(true);
    expect(userId.dbName).toBe('user_id');

    const user = byName.get('user')!;
    expect(user.kind).toBe('object');
    expect(user.type).toBe('User');
    expect(user.isRequired).toBe(true);
    expect(user.isList).toBe(false);

    const type = byName.get('type')!;
    expect(type.kind).toBe('enum');
    expect(type.type).toBe('NotificationType');
    expect(type.isRequired).toBe(true);

    for (const name of ['title', 'message']) {
      const f = byName.get(name)!;
      expect(f.type).toBe('String');
      expect(f.kind).toBe('scalar');
      expect(f.isRequired).toBe(true);
    }

    const isRead = byName.get('isRead')!;
    expect(isRead.type).toBe('Boolean');
    expect(isRead.isRequired).toBe(true);
    expect(isRead.default).toBe(false);
    expect(isRead.dbName).toBe('is_read');

    const createdAt = byName.get('createdAt')!;
    expect(createdAt.type).toBe('DateTime');
    expect(createdAt.isRequired).toBe(true);
    expect(createdAt.dbName).toBe('created_at');
  });

  it('User has the notifications back-relation', () => {
    const user = Prisma.dmmf.datamodel.models.find((m) => m.name === 'User');
    expect(user).toBeDefined();
    const rel = user!.fields.find((f) => f.name === 'notifications');
    expect(rel).toBeDefined();
    expect(rel!.kind).toBe('object');
    expect(rel!.type).toBe('Notification');
    expect(rel!.isList).toBe(true);
  });

  it('schema declares the composite index, table map, and Cascade FK', () => {
    const block = notificationBlock();
    expect(block).toContain('@@index([userId, isRead, createdAt])');
    expect(block).toContain('@@map("notifications")');
    expect(block).toContain('isRead Boolean @default(false) @map("is_read")');
    expect(block).toContain('onDelete: Cascade');
    expect(block).toContain('user   User   @relation(fields: [userId], references: [id]');
  });

  it('introduces no speculative models; model/enum counts unchanged', () => {
    const models = Prisma.dmmf.datamodel.models.map((m) => m.name).sort();
    expect(models).toEqual([...EXPECTED_MODELS].sort());
    expect(Prisma.dmmf.datamodel.models).toHaveLength(9);
    expect(Prisma.dmmf.datamodel.enums).toHaveLength(10);
    for (const banned of ['Allocation', 'Outbox', 'Volunteer', 'EmailLog', 'NotificationPreference']) {
      expect(models).not.toContain(banned);
    }
  });

  it('prepared migration history already represents the Notification table', () => {
    const sql = readRepoFile('prisma', 'migrations', '20260831000001_init', 'migration.sql');
    expect(sql).toContain(
      'CREATE TYPE "NotificationType" AS ENUM (\'DONATION_CREATED\', \'DONATION_MATCHED\', \'DONATION_ACCEPTED\', \'PICKUP_ASSIGNED\', \'PICKUP_REMINDER\', \'DELIVERY_DELAYED\', \'EXPIRY_WARNING\', \'DONATION_EXPIRED\', \'DELIVERY_COMPLETED\', \'CONFIRMATION_PENDING\')',
    );
    expect(sql).toContain('CREATE TABLE "notifications"');
    expect(sql).toContain('"notification_id" TEXT NOT NULL');
    expect(sql).toContain('"user_id" TEXT NOT NULL');
    expect(sql).toContain('"type" "NotificationType" NOT NULL');
    expect(sql).toContain('"title" TEXT NOT NULL');
    expect(sql).toContain('"message" TEXT NOT NULL');
    expect(sql).toContain('"is_read" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain('notifications_user_id_is_read_created_at_idx');
    expect(sql).toContain('notifications_user_id_fkey');
  });

  it('ORG-03 forward migration appends exactly the 2 verification enum values', () => {
    const init = readRepoFile('prisma', 'migrations', '20260831000001_init', 'migration.sql');
    expect(init).not.toContain('ORGANIZATION_VERIFIED');
    expect(init).not.toContain('ORGANIZATION_REJECTED');
    const sql = readRepoFile('prisma', 'migrations', '20260903000003_org_notification_types', 'migration.sql');
    expect(sql).toContain(`ALTER TYPE "NotificationType" ADD VALUE 'ORGANIZATION_VERIFIED';`);
    expect(sql).toContain(`ALTER TYPE "NotificationType" ADD VALUE 'ORGANIZATION_REJECTED';`);
    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('down.sql');
  });

  it('adds no service, email, or instrumentation code (BE-NOTIF-02/03/04 out of scope)', () => {
    const services = fs.readdirSync(path.join(backendDir, 'src', 'services'));
    expect(services).toEqual(['audit.service.ts', 'auth.service.ts', 'donations.service.ts', 'email.service.ts', 'notification.service.ts', 'organizations.service.ts', 'requirements.service.ts', 'users.service.ts']);
    // BE-04 owns route structure: notifications.ts exists but must stay a
    // placeholder with no service calls or business wiring.
    const routes = fs.readdirSync(path.join(backendDir, 'src', 'routes'));
    expect(routes).toContain('notifications.ts');
    const notifRoutes = readRepoFile('src', 'routes', 'notifications.ts');
    expect(notifRoutes).not.toContain('../services');
    const srcText = readRepoFile('src', 'services', 'audit.service.ts');
    expect(srcText).not.toContain('Notification');
  });
});
