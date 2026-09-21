-- Migration: 20260920000004_requirement_history
-- Description: REQ-06 adds the authoritative immutable RequirementHistory domain-history table
-- Depends on: 20260831000001_init, 20260831000002_add_check_constraints
-- Generated via: prisma migrate diff --from-schema-datamodel <pre-REQ-06 schema> --to-schema-datamodel prisma/schema.prisma --script
-- NOTE: This migration has NOT been applied. No live database is configured.
--       Do NOT apply it until a real Supabase DATABASE_URL is available.

-- CreateEnum
CREATE TYPE "RequirementHistoryAction" AS ENUM ('CREATE', 'UPDATE');

-- CreateTable
CREATE TABLE "requirement_history" (
    "history_id" TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" "RequirementHistoryAction" NOT NULL,
    "food_category" TEXT NOT NULL,
    "food_type" TEXT NOT NULL,
    "quantity_required" DOUBLE PRECISION NOT NULL,
    "quantity_fulfilled" DOUBLE PRECISION NOT NULL,
    "required_by" TIMESTAMP(3) NOT NULL,
    "priority" "Priority" NOT NULL,
    "location" TEXT NOT NULL,
    "status" "RequirementStatus" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateIndex
CREATE INDEX "requirement_history_requirement_id_idx" ON "requirement_history"("requirement_id");

-- CreateIndex
CREATE INDEX "requirement_history_organization_id_timestamp_idx" ON "requirement_history"("organization_id", "timestamp");

-- CreateIndex
CREATE INDEX "requirement_history_timestamp_idx" ON "requirement_history"("timestamp");

-- AddForeignKey
ALTER TABLE "requirement_history" ADD CONSTRAINT "requirement_history_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("requirement_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_history" ADD CONSTRAINT "requirement_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
