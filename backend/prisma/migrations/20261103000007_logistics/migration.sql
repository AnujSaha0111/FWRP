    -- Migration: 20261103000007_logistics
    -- Description: LOG-01 volunteer availability windows; LOG-04 decline, DELCONF-01 handover and
    --              DELCONF-02 receipt-confirmation fields on deliveries. Additive only.
    -- Depends on: 20260920000006_allocation
    -- Generated via: prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --script

    -- AlterTable
    ALTER TABLE "deliveries" ADD COLUMN     "confirmed_at" TIMESTAMP(3),
    ADD COLUMN     "decline_reason" TEXT,
    ADD COLUMN     "declined_at" TIMESTAMP(3),
    ADD COLUMN     "handover_confirmed_at" TIMESTAMP(3),
    ADD COLUMN     "quantity_received" DOUBLE PRECISION,
    ADD COLUMN     "receiver_name" TEXT;

    -- CreateTable
    CREATE TABLE "volunteer_availability" (
        "availability_id" TEXT NOT NULL,
        "volunteer_id" TEXT NOT NULL,
        "available_from" TIMESTAMP(3) NOT NULL,
        "available_until" TIMESTAMP(3) NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "volunteer_availability_pkey" PRIMARY KEY ("availability_id")
    );

    -- CreateIndex
    CREATE INDEX "volunteer_availability_volunteer_id_idx" ON "volunteer_availability"("volunteer_id");

    -- CreateIndex
    CREATE INDEX "volunteer_availability_available_until_idx" ON "volunteer_availability"("available_until");

    -- AddForeignKey
    ALTER TABLE "volunteer_availability" ADD CONSTRAINT "volunteer_availability_volunteer_id_fkey" FOREIGN KEY ("volunteer_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;


    -- CHECK constraints (Prisma cannot express them; same convention as 20260831000002)
    ALTER TABLE "volunteer_availability" ADD CONSTRAINT "volunteer_availability_window_check" CHECK (available_until > available_from);
    ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_quantity_received_check" CHECK (quantity_received IS NULL OR quantity_received > 0);
