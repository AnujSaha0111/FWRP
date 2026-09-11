import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient, VerificationStatus } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { acceptDonation } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// ORG-05: VERIFIED gate on the minimum acceptance contract. Browse paths stay
// structural; only acceptance is gated. No Phase 6/8/9 workflows.

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

function mockBackend(user: Record<string, unknown> | null, donation: Record<string, unknown> | null) {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ORG-05 VERIFIED gate', () => {
  it('lets a VERIFIED recipient accept (AVAILABLE -> ACCEPTED, minimal payload)', async () => {
    const { userFind, donationUpdate } = mockBackend(recipientRow('VERIFIED'), donationRow('AVAILABLE'));
    const app = createApp();
    const res = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { donation: { id: 'don-1', status: 'ACCEPTED' } } });
    expect(userFind).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      include: { organization: { select: { id: true, verificationStatus: true } } },
    });
    expect(donationUpdate).toHaveBeenCalledWith({ where: { id: 'don-1' }, data: { status: 'ACCEPTED' } });
  });

  it.each(['PENDING', 'UNDER_REVIEW', 'REJECTED'] as const)('%s recipients get one identical 403 with zero mutation', async (status) => {
    const { donationUpdate } = mockBackend(recipientRow(status), donationRow('AVAILABLE'));
    const app = createApp();
    const res = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Organization is not verified');
    expect(donationUpdate).not.toHaveBeenCalled();
  });

  it('rejects org-less recipients and unknown/inactive users without mutation', async () => {
    const app = createApp();
    const noOrg = mockBackend(recipientRow(null), donationRow('AVAILABLE'));
    const resNoOrg = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(resNoOrg.status).toBe(403);
    expect(noOrg.donationUpdate).not.toHaveBeenCalled();

    mockBackend(null, donationRow('AVAILABLE'));
    const missing = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(missing.status).toBe(404);

    mockBackend({ ...recipientRow('VERIFIED'), status: 'SUSPENDED' }, donationRow('AVAILABLE'));
    const suspended = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(suspended.status).toBe(401);
  });

  it('rejects missing/unavailable donations without mutation', async () => {
    const app = createApp();
    mockBackend(recipientRow('VERIFIED'), null);
    const missing = await request(app).post('/api/donations/ghost/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(missing.status).toBe(404);

    const taken = mockBackend(recipientRow('VERIFIED'), donationRow('ACCEPTED'));
    const gone = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${recipientToken()}`);
    expect(gone.status).toBe(409);
    expect(taken.donationUpdate).not.toHaveBeenCalled();
  });

  it('client-supplied organization ids cannot bypass the session gate', async () => {
    const { userFind, donationUpdate } = mockBackend(recipientRow('PENDING'), donationRow('AVAILABLE'));
    const app = createApp();
    const res = await request(app)
      .post('/api/donations/don-1/accept')
      .set('Authorization', `Bearer ${recipientToken()}`)
      .send({ organizationId: 'org-verified', organization: { verificationStatus: 'VERIFIED' }, status: 'VERIFIED' });
    expect(res.status).toBe(403);
    expect(userFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' } }));
    expect(donationUpdate).not.toHaveBeenCalled();
  });

  it('enforces authentication and the recipient-only role', async () => {
    mockBackend(recipientRow('VERIFIED'), donationRow('AVAILABLE'));
    const app = createApp();
    const anon = await request(app).post('/api/donations/don-1/accept');
    expect(anon.status).toBe(401);
    for (const role of ['PROVIDER', 'VOLUNTEER', 'ADMIN'] as const) {
      const token = signAccessToken({ id: 'x', email: 'x@example.com', role, organizationId: null });
      const res = await request(app).post('/api/donations/don-1/accept').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  it('service rejects empty ids and masks persistence failures', async () => {
    const { donationFind } = mockBackend(recipientRow('VERIFIED'), donationRow('AVAILABLE'));
    await expect(acceptDonation('', 'user-1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(acceptDonation('don-1', '')).rejects.toMatchObject({ statusCode: 400 });
    expect(donationFind).not.toHaveBeenCalled();

    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => recipientRow('VERIFIED')) },
      donation: {
        findUnique: vi.fn(async () => donationRow('AVAILABLE')),
        update: vi.fn(async () => {
          throw new Error('UPDATE "donations" failed postgres://u:p@h/db');
        }),
      },
    } as unknown as PrismaClient);
    try {
      await acceptDonation('don-1', 'user-1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(500);
      expect((e as { code?: string }).code).toBe('ACCEPTANCE_FAILED');
      expect(JSON.stringify(e)).not.toContain('postgres://');
    }
  });
});
