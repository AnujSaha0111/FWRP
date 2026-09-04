-- Migration: 20260831000002_add_check_constraints
-- Description: Adds 8 DB-12 CHECK constraints that Prisma 5.22 cannot express natively (see docs/database.md §12.2)
-- Depends on: 20260831000001_init
-- NOTE: This migration has NOT been applied. It adds the 8 CHECKs prepared for Supabase. DB-14 verification remains PENDING.
-- DB-12: 8 logical CHECK constraints (7 fields) — Prisma 5.22 cannot express CHECK natively, added as raw SQL for DB-14 Supabase verification
-- 1. donations.available_until > donations.available_from
ALTER TABLE "donations" ADD CONSTRAINT "donations_available_until_check" CHECK (available_until > available_from);
-- 2. donations.quantity > 0
ALTER TABLE "donations" ADD CONSTRAINT "donations_quantity_check" CHECK (quantity > 0);
-- 3. requirements.quantity_required > 0
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_quantity_required_check" CHECK (quantity_required > 0);
-- 4. requirements.quantity_fulfilled >= 0
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_quantity_fulfilled_check" CHECK (quantity_fulfilled >= 0);
-- 5. organizations.latitude BETWEEN -90 AND 90
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_latitude_check" CHECK (latitude BETWEEN -90 AND 90);
-- 6. organizations.longitude BETWEEN -180 AND 180
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_longitude_check" CHECK (longitude BETWEEN -180 AND 180);
-- 7. donations.pickup_latitude IS NULL OR BETWEEN -90 AND 90
ALTER TABLE "donations" ADD CONSTRAINT "donations_pickup_latitude_check" CHECK (pickup_latitude IS NULL OR pickup_latitude BETWEEN -90 AND 90);
-- 8. donations.pickup_longitude IS NULL OR BETWEEN -180 AND 180
ALTER TABLE "donations" ADD CONSTRAINT "donations_pickup_longitude_check" CHECK (pickup_longitude IS NULL OR pickup_longitude BETWEEN -180 AND 180);

-- NOTE: This migration was prepared via 'prisma migrate diff --from-empty' on 2026-08-31 without a live database.
-- It has NOT been applied to any database. DB-14 live verification (psql \d, CHECK violation tests, FK behavior) remains PENDING until Supabase DATABASE_URL is configured.
-- Do NOT mark DB-14 complete until 'npx prisma migrate deploy' succeeds against Supabase and psql verification passes.
