import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import { DonationStatus } from '@prisma/client';
import type { PrismaClient, VerificationStatus } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';
import {
  DONATION_TRANSITIONS,
  canTransition,
  donationStatusesLeadingTo,
} from '../utils/donationState';

// DON-09: central Donation status transition guard + integration into the
// existing accept path. MATCHED is informational per resolved D-05, so
// AVAILABLE → ACCEPTED and MATCHED → ACCEPTED are both valid and MATCHED is
// never a prerequisite for acceptance.

const ALL_STATUSES = Object.values(DonationStatus) as DonationStatus[];

// Authoritative valid transitions (PRD §33, docs/database.md §11.2, ADR-005).
const VALID_PAIRS: Array<[DonationStatus, DonationStatus]> = [
  ['DRAFT', 'AVAILABLE'],
  ['AVAILABLE', 'MATCHED'],
  ['AVAILABLE', 'ACCEPTED'],
  ['AVAILABLE', 'EXPIRED'],
  ['AVAILABLE', 'CANCELLED'],
  ['MATCHED', 'ACCEPTED'],
  ['MATCHED', 'EXPIRED'],
  ['MATCHED', 'CANCELLED'],
  ['ACCEPTED', 'PICKUP_ASSIGNED'],
  ['PICKUP_ASSIGNED', 'PICKED_UP'],
  ['PICKED_UP', 'IN_TRANSIT'],
  ['IN_TRANSIT', 'DELIVERED'],
  ['DELIVERED', 'COMPLETED'],
];

const VALID_SET = new Set(VALID_PAIRS.map(([f, t]) => `${f}->${t}`));

describe('DON-09 donation state machine guard', () => {
  it('exposes exactly the authoritative transition map (terminals have no outgoing)', () => {
    expect(DONATION_TRANSITIONS.COMPLETED).toEqual([]);
    expect(DONATION_TRANSITIONS.EXPIRED).toEqual([]);
    expect(DONATION_TRANSITIONS.CANCELLED).toEqual([]);
    expect(DONATION_TRANSITIONS.DELIVERED).toEqual(['COMPLETED']);
  });

  it.each(VALID_PAIRS)('canTransition(%s, %s) === true', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('returns false for every pair not in the authoritative map (exhaustive)', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = VALID_SET.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from}->${to}`).toBe(expected);
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const s of ALL_STATUSES) {
      expect(canTransition(s, s), `${s}->${s}`).toBe(false);
    }
  });

  describe('D-05 MATCHED semantics', () => {
    it('keeps AVAILABLE directly acceptable without a MATCHED prerequisite', () => {
      expect(canTransition('AVAILABLE', 'ACCEPTED')).toBe(true);
    });

    it('allows accepting a persisted MATCHED donation', () => {
      expect(canTransition('MATCHED', 'ACCEPTED')).toBe(true);
    });

    it('does not make MATCHED block AVAILABLE → EXPIRED / CANCELLED', () => {
      expect(canTransition('AVAILABLE', 'EXPIRED')).toBe(true);
      expect(canTransition('AVAILABLE', 'CANCELLED')).toBe(true);
      expect(canTransition('MATCHED', 'EXPIRED')).toBe(true);
      expect(canTransition('MATCHED', 'CANCELLED')).toBe(true);
    });
  });

  describe('terminal / backward transitions are rejected', () => {
    it.each([
      ['COMPLETED', 'AVAILABLE'],
      ['COMPLETED', 'ACCEPTED'],
      ['EXPIRED', 'AVAILABLE'],
      ['EXPIRED', 'ACCEPTED'],
      ['CANCELLED', 'AVAILABLE'],
      ['CANCELLED', 'ACCEPTED'],
      ['ACCEPTED', 'AVAILABLE'],
      ['DELIVERED', 'ACCEPTED'],
      ['PICKUP_ASSIGNED', 'ACCEPTED'],
      ['COMPLETED', 'COMPLETED'],
    ] as Array<[DonationStatus, DonationStatus]>)('%s -> %s === false', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });
  });

  it('derives leading statuses from the single transition map', () => {
    expect(donationStatusesLeadingTo('CANCELLED')).toEqual(['AVAILABLE', 'MATCHED']);
    expect(donationStatusesLeadingTo('ACCEPTED')).toEqual(['AVAILABLE', 'MATCHED']);
    expect(donationStatusesLeadingTo('AVAILABLE')).toEqual(['DRAFT']);
    expect(donationStatusesLeadingTo('COMPLETED')).toEqual(['DELIVERED']);
  });
});

// ---------------------------------------------------------------------------
// Integration: the existing acceptance path routes its status check through
// the central guard, so MATCHED donations are now acceptable (D-05) while
// invalid statuses still return 409. Cancellation integration is already
// proven by donations.cancel.test.ts (AVAILABLE/MATCHED 200; others 409).

function recipientRow(status: VerificationStatus | null) {
  return {
    id: 'user-1',
    name: 'Rita Recipient',
    email: 'rita@example.com',
    phone: '+1 555-123-4567',
    passwordHash: 'bcrypt-hash-placeholder',
    role: 'RECIPIENT',
    organizationId: status ? 'org-1' : null,
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    organization: status ? { id: 'org-1', verificationStatus: status } : null,
  };
}

function donationRow(status: string) {
  return { id: 'don-1', providerId: 'prov-1', status };
}

function mockAcceptBackend(user: Record<string, unknown> | null, donation: Record<string, unknown> | null) {
  const userFind = vi.fn(async () => user);
  const donationFind = vi.fn(async () => donation);
  const donationUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...donationRow('AVAILABLE'),
    ...args.data,
  }));
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    donation: { findUnique: donationFind, update: donationUpdate },
  } as unknown as PrismaClient);
  return { userFind, donationFind, donationUpdate };
}

function recipientToken(): string {
  return signAccessToken({ id: 'user-1', email: 'rita@example.com', role: 'RECIPIENT', organizationId: 'org-1' });
}

describe('DON-09 acceptance integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still accepts an AVAILABLE donation directly (no MATCHED prerequisite)', async () => {
    const { donationUpdate } = mockAcceptBackend(recipientRow('VERIFIED'), donationRow('AVAILABLE'));
    const app = createApp();
    const res = await request(app)
      .post('/api/donations/don-1/accept')
      .set('Authorization', `Bearer ${recipientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.donation.status).toBe('ACCEPTED');
    expect(donationUpdate).toHaveBeenCalledWith({ where: { id: 'don-1' }, data: { status: 'ACCEPTED' } });
  });

  it('accepts a persisted MATCHED donation (D-05 informational)', async () => {
    const { donationUpdate } = mockAcceptBackend(recipientRow('VERIFIED'), donationRow('MATCHED'));
    const app = createApp();
    const res = await request(app)
      .post('/api/donations/don-1/accept')
      .set('Authorization', `Bearer ${recipientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.donation.status).toBe('ACCEPTED');
    expect(donationUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(['DRAFT', 'ACCEPTED', 'PICKUP_ASSIGNED', 'DELIVERED', 'COMPLETED', 'EXPIRED', 'CANCELLED'] as const)(
    'rejects acceptance from %s with 409 and zero mutation (central guard)',
    async (status) => {
      const { donationUpdate } = mockAcceptBackend(recipientRow('VERIFIED'), donationRow(status));
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/accept')
        .set('Authorization', `Bearer ${recipientToken()}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(donationUpdate).not.toHaveBeenCalled();
    }
  );
});
