import type { Donation, PrismaClient, User } from '@prisma/client';
import { AppError } from '../middleware/error';
import { getPrisma } from '../lib/prisma';

// ORG-05: minimum donation-acceptance contract carrying the verified-
// recipient gate. Only AVAILABLE → ACCEPTED is performed here; matching,
// allocation (D-06 unresolved), audit/notification fan-out, and concurrency
// controls belong to Phases 8/9 (ACCEPT-*) which extend this service.
// Browse paths stay untouched (still structural placeholders).

export interface AcceptDonationResult {
  donation: Pick<Donation, 'id' | 'status'>;
}

type RecipientWithOrg = User & {
  organization: { id: string; verificationStatus: string } | null;
};

function mapAcceptanceError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'ACCEPTANCE_FAILED', 'Acceptance failed');
}

// ORG-05 gate: the organization resolves ONLY from the authenticated session
// user row — never from path/body input — and its persisted verification
// status must be VERIFIED. All non-VERIFIED statuses share one generic 403
// so nothing leaks about the organization's state.
export async function acceptDonation(donationId: string, userId: string): Promise<AcceptDonationResult> {
  if (typeof donationId !== 'string' || donationId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'donationId', message: 'Donation id is required' },
    ]);
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  let recipient: RecipientWithOrg | null;
  try {
    recipient = (await client.user.findUnique({
      where: { id: userId },
      include: { organization: { select: { id: true, verificationStatus: true } } },
    })) as RecipientWithOrg | null;
  } catch (err) {
    throw mapAcceptanceError(err);
  }
  if (!recipient) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (recipient.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Belt-and-suspenders behind the route's requireRole('RECIPIENT').
  if (recipient.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can accept donations');
  }
  if (!recipient.organization || recipient.organization.verificationStatus !== 'VERIFIED') {
    throw new AppError(403, 'FORBIDDEN', 'Organization is not verified');
  }

  let donation: Donation | null;
  try {
    donation = await client.donation.findUnique({ where: { id: donationId } });
  } catch (err) {
    throw mapAcceptanceError(err);
  }
  if (!donation) {
    throw new AppError(404, 'NOT_FOUND', 'Donation not found');
  }
  if (donation.status !== 'AVAILABLE') {
    throw new AppError(409, 'CONFLICT', 'Donation is not available');
  }

  try {
    const updated = await client.donation.update({
      where: { id: donationId },
      data: { status: 'ACCEPTED' },
    });
    return { donation: { id: updated.id, status: updated.status } };
  } catch (err) {
    throw mapAcceptanceError(err);
  }
}

export interface DonationsService {
  acceptDonation(donationId: string, userId: string): Promise<AcceptDonationResult>;
}

export const donationsService: DonationsService = {
  acceptDonation: (donationId, userId) => acceptDonation(donationId, userId),
};
