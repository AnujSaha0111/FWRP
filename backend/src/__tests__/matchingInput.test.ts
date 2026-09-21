import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  MATCHING_DONATION_SELECT,
  MATCHING_REQUIREMENT_SELECT,
  loadMatchingDonationInput,
  loadMatchingRequirementInput,
  toMatchingDonationInput,
  toMatchingRequirementInput,
  type MatchingDonationRow,
  type MatchingRequirementRow,
} from '../utils/matchingInput';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

function donationRow(overrides: Partial<MatchingDonationRow> = {}): MatchingDonationRow {
  return {
    id: 'don-1',
    pickupLocation: '12 Main St, Springfield',
    pickupLatitude: 40.7128,
    pickupLongitude: -74.006,
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 120,
    availableFrom: new Date('2026-09-20T10:00:00.000Z'),
    availableUntil: new Date('2026-09-20T22:00:00.000Z'),
    status: 'AVAILABLE',
    createdAt: new Date('2026-09-20T09:00:00.000Z'),
    ...overrides,
  };
}

function requirementRow(overrides: Partial<MatchingRequirementRow> = {}): MatchingRequirementRow {
  return {
    id: 'req-1',
    organizationId: 'org-1',
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 100,
    quantityFulfilled: 20,
    requiredBy: new Date('2026-09-21T10:00:00.000Z'),
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    status: 'OPEN',
    createdAt: new Date('2026-09-19T09:00:00.000Z'),
    organization: { latitude: 40.73, longitude: -73.99 },
    ...overrides,
  };
}

describe('MATCH-01 donation input contract', () => {
  it('maps the actual Donation schema fields', () => {
    const row = donationRow();
    const input = toMatchingDonationInput(row, 100);
    expect(input).toMatchObject({
      id: 'don-1',
      pickupLocation: '12 Main St, Springfield',
      pickupLatitude: 40.7128,
      pickupLongitude: -74.006,
      category: 'Prepared meals',
      foodType: 'Vegetarian',
      quantity: 120,
      status: 'AVAILABLE',
    });
    expect(input.availableFrom).toEqual(row.availableFrom);
    expect(input.availableUntil).toEqual(row.availableUntil);
    expect(input.createdAt).toEqual(row.createdAt);
  });

  it('does not introduce Donation.priority (not in schema, not in the select)', () => {
    const input = toMatchingDonationInput(donationRow(), 0);
    expect('priority' in input).toBe(false);
    expect(Object.keys(MATCHING_DONATION_SELECT)).not.toContain('priority');
    // Authoritative schema: Donation has no priority field.
    const donation = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Donation')!;
    expect(donation.fields.map((f) => f.name)).not.toContain('priority');
  });

  it('keeps donation coordinates nullable', () => {
    const missing = toMatchingDonationInput(
      donationRow({ pickupLatitude: null, pickupLongitude: null }),
      0
    );
    expect(missing.pickupLatitude).toBeNull();
    expect(missing.pickupLongitude).toBeNull();
    const present = toMatchingDonationInput(donationRow(), 0);
    expect(present.pickupLatitude).toBe(40.7128);
    expect(present.pickupLongitude).toBe(-74.006);
  });

  it('derives committed/remaining quantity per REQ-08 (never persisted)', () => {
    const input = toMatchingDonationInput(donationRow({ quantity: 120 }), 100);
    expect(input.committedQuantity).toBe(100);
    expect(input.remainingQuantity).toBe(20);
    expect(toMatchingDonationInput(donationRow(), 0).remainingQuantity).toBe(120);
  });
});

describe('MATCH-01 requirement input contract', () => {
  it('maps the actual Requirement schema fields and preserves assigned priority', () => {
    const input = toMatchingRequirementInput(requirementRow({ priority: 'CRITICAL' }));
    expect(input).toMatchObject({
      id: 'req-1',
      organizationId: 'org-1',
      foodCategory: 'Prepared meals',
      foodType: 'Vegetarian',
      quantityRequired: 100,
      quantityFulfilled: 20,
      priority: 'CRITICAL',
      location: 'XYZ Shelter, Springfield',
      status: 'OPEN',
    });
    // Authoritative schema: Requirement HAS priority (MATCH-D05 source).
    const requirement = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Requirement')!;
    expect(requirement.fields.map((f) => f.name)).toContain('priority');
  });

  it('derives requirement remaining quantity per REQ-08', () => {
    expect(toMatchingRequirementInput(requirementRow()).remainingQuantity).toBe(80);
    expect(
      toMatchingRequirementInput(requirementRow({ quantityRequired: 50, quantityFulfilled: 50 }))
        .remainingQuantity
    ).toBe(0);
  });

  it('takes coordinates from the owning Organization (no Requirement coordinate fields)', () => {
    const input = toMatchingRequirementInput(
      requirementRow({ organization: { latitude: 40.73, longitude: -73.99 } })
    );
    expect(input.organizationLatitude).toBe(40.73);
    expect(input.organizationLongitude).toBe(-73.99);
    // No invented top-level coordinate fields on the requirement input.
    expect('latitude' in input).toBe(false);
    expect('longitude' in input).toBe(false);
    expect(Object.keys(MATCHING_REQUIREMENT_SELECT)).not.toContain('latitude');
    expect(Object.keys(MATCHING_REQUIREMENT_SELECT)).not.toContain('longitude');
    expect(
      (MATCHING_REQUIREMENT_SELECT as Record<string, unknown>).organization
    ).toBeTruthy();
    const requirement = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Requirement')!;
    expect(requirement.fields.map((f) => f.name)).not.toContain('latitude');
    expect(requirement.fields.map((f) => f.name)).not.toContain('longitude');
  });

  it('remains null-safe when organization coordinates are unavailable', () => {
    const input = toMatchingRequirementInput(requirementRow({ organization: null }));
    expect(input.organizationLatitude).toBeNull();
    expect(input.organizationLongitude).toBeNull();
  });
});

describe('MATCH-01 read-only loader adapter', () => {
  it('loads a donation input including derived committed/remaining quantity, or null', async () => {
    const found = donationRow();
    const client = {
      donation: { findUnique: vi.fn(async () => found) },
      allocation: {
        aggregate: vi.fn(async () => ({ _sum: { committedQuantity: 100 } })),
      },
    } as unknown as PrismaClient;
    const input = await loadMatchingDonationInput(client, 'don-1');
    expect(input).not.toBeNull();
    expect(input!.remainingQuantity).toBe(20);
    expect(input!.committedQuantity).toBe(100);

    const missing = {
      donation: { findUnique: vi.fn(async () => null) },
      allocation: { aggregate: vi.fn() },
    } as unknown as PrismaClient;
    expect(await loadMatchingDonationInput(missing, 'nope')).toBeNull();
  });

  it('loads a requirement input with organization coordinates, or null', async () => {
    const client = {
      requirement: { findUnique: vi.fn(async () => requirementRow()) },
    } as unknown as PrismaClient;
    const input = await loadMatchingRequirementInput(client, 'req-1');
    expect(input).not.toBeNull();
    expect(input!.organizationLatitude).toBe(40.73);
    expect(input!.priority).toBe('HIGH');

    const missing = {
      requirement: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    expect(await loadMatchingRequirementInput(missing, 'nope')).toBeNull();
  });
});

describe('MATCH-01 boundary guards (input contract only)', () => {
  const src = readRepoFile('src', 'utils', 'matchingInput.ts');
  // Assess executable code, not the explanatory doc comments.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('selects only real schema fields (no invented ones)', () => {
    expect(Object.keys(MATCHING_DONATION_SELECT).sort()).toEqual(
      [
        'availableFrom',
        'availableUntil',
        'category',
        'createdAt',
        'foodType',
        'id',
        'pickupLatitude',
        'pickupLocation',
        'pickupLongitude',
        'quantity',
        'status',
      ].sort()
    );
    expect(Object.keys(MATCHING_REQUIREMENT_SELECT).sort()).toEqual(
      [
        'createdAt',
        'foodCategory',
        'foodType',
        'id',
        'location',
        'organization',
        'organizationId',
        'priority',
        'quantityFulfilled',
        'quantityRequired',
        'requiredBy',
        'status',
      ].sort()
    );
  });

  it('does not persist or require a quantity_remaining field', () => {
    expect(code).not.toMatch(/quantity_remaining|quantityRemaining/);
    // remaining quantity is derived and clearly named.
    expect(src).toContain('remainingQuantity');
  });

  it('does not invent a transportation/volunteer field', () => {
    expect(code).not.toMatch(/transport|transportAvailability|volunteer/i);
    const input = toMatchingDonationInput(donationRow(), 0);
    expect(Object.keys(input)).not.toContain('transport');
    expect(Object.keys(input)).not.toContain('transportAvailability');
  });

  it('performs no filtering, distance, scoring, weighting, or priority derivation', () => {
    expect(code).not.toMatch(/haversine|distanceScore|quantityScore|foodScore|timeScore|priorityScore/i);
    expect(code).not.toMatch(/weightedSum|matchingScore|matching_config|score\s*\(/i);
    expect(code).not.toMatch(/canRequirementTransition|canTransition/);
    expect(code).not.toMatch(/deriveRequirementStatus/);
  });

  it('is read-only: no writes, transactions, or Match/Allocation mutation', () => {
    expect(code).not.toMatch(/\.create\(|\.update\(|\.updateMany\(|\.delete\(|\$transaction/);
    expect(code).not.toMatch(/Match\b/);
    // No Prisma write payloads are constructed anywhere in the module.
    expect(code).not.toMatch(/\bdata\s*:/);
  });
});
