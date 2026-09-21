-- Migration: 20260920000006_allocation
-- Description: REQ-08 introduces the authoritative Allocation representation for D-06 Model A (partial/multi-donation fulfillment).
-- Depends on: 20260831000001_init, 20260831000002_add_check_constraints, 20260920000004_requirement_history, 20260920000005_requirement_history_cancel
-- Generated via: prisma migrate diff --from-schema-datamodel <pre-REQ-08 schema> --to-schema-datamodel prisma/schema.prisma --script
-- NOTE: This migration has NOT been applied. No live database is configured.
--       The `committed_quantity > 0` positivity rule is enforced at the service layer
--       (DB-14 CHECK constraints remain deferred/unresolved and are not touched here).
--       The `SUM(committed_quantity) <= Donation.quantity` invariant is enforced
--       transactionally at the service layer under a donation row lock.

-- CreateTable
CREATE TABLE "allocations" (
    "allocation_id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "committed_quantity" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateIndex
CREATE INDEX "allocations_donation_id_idx" ON "allocations"("donation_id");

-- CreateIndex
CREATE INDEX "allocations_requirement_id_idx" ON "allocations"("requirement_id");

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donations"("donation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("requirement_id") ON DELETE CASCADE ON UPDATE CASCADE;
