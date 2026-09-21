-- Migration: 20260920000005_requirement_history_cancel
-- Description: REQ-07 adds the CANCEL value to RequirementHistoryAction so requirement cancellation is recorded in the authoritative RequirementHistory domain source.
-- Depends on: 20260920000004_requirement_history
-- Generated via: prisma migrate diff --from-schema-datamodel <pre-REQ-07 schema> --to-schema-datamodel prisma/schema.prisma --script
-- NOTE: This migration has NOT been applied. No live database is configured.
--       Do NOT apply it until a real Supabase DATABASE_URL is available.

-- AlterEnum
ALTER TYPE "RequirementHistoryAction" ADD VALUE 'CANCEL';
