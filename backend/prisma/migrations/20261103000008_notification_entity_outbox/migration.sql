-- Migration: 20261103000008_notification_entity_outbox
-- Description: NOTIF-05 persists the related entity (deep links, reminder de-duplication);
--              NOTIF-06 adds email outbox state. Additive only; existing rows keep NULL entity
--              and are never emailed (the dispatcher only scans recent rows).
-- Depends on: 20261103000007_logistics
-- Generated via: prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --script

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "email_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailed_at" TIMESTAMP(3),
ADD COLUMN     "entity_id" TEXT,
ADD COLUMN     "entity_type" TEXT;

-- CreateIndex
CREATE INDEX "notifications_entity_type_entity_id_idx" ON "notifications"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notifications_emailed_at_created_at_idx" ON "notifications"("emailed_at", "created_at");


-- CHECK constraint (Prisma cannot express it)
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_email_attempts_check" CHECK (email_attempts >= 0);
