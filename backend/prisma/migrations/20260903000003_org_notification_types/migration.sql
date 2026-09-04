-- Migration: 20260903000003_org_notification_types
-- Description: ORG-03 adds ORGANIZATION_VERIFIED + ORGANIZATION_REJECTED to NotificationType for owner notices on verification outcomes (no existing PRD §17 value fits; placeholders forbidden).
-- Generated via: prisma migrate diff --from-schema-datamodel (schema without the 2 values) --to-schema-datamodel prisma/schema.prisma --script
-- Depends on: 20260831000002_add_check_constraints
-- NOTE: This migration has NOT been applied to any database. DB-14 live verification remains PENDING until Supabase DATABASE_URL is configured.
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ORGANIZATION_VERIFIED';
ALTER TYPE "NotificationType" ADD VALUE 'ORGANIZATION_REJECTED';
