// FWRP demo seed — `npm run seed` (or `npx prisma db seed`).
//
// Creates a complete, logged-in-ready demo in one city (Bengaluru):
// admin, providers, recipients, volunteers, categories, live donations and
// requirements that match each other, volunteer availability, plus one
// completed and one expired donation so dashboards and reports have data.
//
// Re-runnable: accounts, organizations and categories are upserted; demo
// activity (every row whose id starts with "seed-", and the seed accounts'
// notifications/availability/incidents) is deleted and recreated, so each run
// resets the demo to a fresh state with windows relative to "now". Nothing
// outside the seed data is touched. Refuses to run in production.

import type { OrganizationType, Prisma, Role } from '@prisma/client';
import { disconnectPrisma, getPrisma } from '../src/lib/prisma';
import { hashPassword } from '../src/services/auth.service';
import { generateMatchesForRequirement } from '../src/services/matching.service';

export const DEMO_PASSWORD = 'Password123!';

const H = 60 * 60 * 1000;
const D = 24 * H;

const CATEGORIES = ['Prepared meals', 'Bakery', 'Produce', 'Dairy', 'Packaged goods', 'Beverages'];

interface OrgSeed {
  id: string;
  name: string;
  type: OrganizationType;
  address: string;
  latitude: number;
  longitude: number;
  verified: boolean;
}

const ORGS: OrgSeed[] = [
  { id: 'seed-org-spice', name: 'Spice Route Restaurant', type: 'RESTAURANT', address: '12 MG Road, Bengaluru', latitude: 12.9757, longitude: 77.6062, verified: true },
  { id: 'seed-org-palace', name: 'Grand Palace Hotel', type: 'HOTEL', address: '1 Palace Road, Bengaluru', latitude: 12.9987, longitude: 77.5921, verified: true },
  { id: 'seed-org-hope', name: 'Hope Shelter', type: 'SHELTER', address: '45 Shivajinagar, Bengaluru', latitude: 12.9857, longitude: 77.6050, verified: true },
  { id: 'seed-org-foodbank', name: 'City Food Bank', type: 'FOOD_BANK', address: '8 Jayanagar 4th Block, Bengaluru', latitude: 12.9250, longitude: 77.5938, verified: true },
  { id: 'seed-org-little', name: 'Little Hands Kitchen', type: 'COMMUNITY_KITCHEN', address: '3 Koramangala, Bengaluru', latitude: 12.9352, longitude: 77.6245, verified: false },
];

interface UserSeed {
  id: string;
  name: string;
  email: string;
  role: Role;
  organizationId: string | null;
}

const USERS: UserSeed[] = [
  { id: 'seed-user-admin', name: 'Asha Admin', email: 'admin@fwrp.demo', role: 'ADMIN', organizationId: null },
  { id: 'seed-user-spice', name: 'Ravi (Spice Route)', email: 'provider1@fwrp.demo', role: 'PROVIDER', organizationId: 'seed-org-spice' },
  { id: 'seed-user-palace', name: 'Meera (Grand Palace)', email: 'provider2@fwrp.demo', role: 'PROVIDER', organizationId: 'seed-org-palace' },
  { id: 'seed-user-hope', name: 'John (Hope Shelter)', email: 'recipient1@fwrp.demo', role: 'RECIPIENT', organizationId: 'seed-org-hope' },
  { id: 'seed-user-foodbank', name: 'Priya (City Food Bank)', email: 'recipient2@fwrp.demo', role: 'RECIPIENT', organizationId: 'seed-org-foodbank' },
  { id: 'seed-user-little', name: 'Sam (Little Hands)', email: 'recipient3@fwrp.demo', role: 'RECIPIENT', organizationId: 'seed-org-little' },
  { id: 'seed-user-vol1', name: 'Vikram (Volunteer)', email: 'volunteer1@fwrp.demo', role: 'VOLUNTEER', organizationId: null },
  { id: 'seed-user-vol2', name: 'Neha (Volunteer)', email: 'volunteer2@fwrp.demo', role: 'VOLUNTEER', organizationId: null },
];

const SEED_USER_IDS = USERS.map((u) => u.id);

async function resetDemoActivity(): Promise<void> {
  const db = getPrisma();
  const seedRows = { startsWith: 'seed-' };
  await db.delivery.deleteMany({ where: { donationId: seedRows } });
  await db.match.deleteMany({ where: { OR: [{ donationId: seedRows }, { requirementId: seedRows }] } });
  await db.allocation.deleteMany({ where: { OR: [{ donationId: seedRows }, { requirementId: seedRows }] } });
  await db.donation.deleteMany({ where: { id: seedRows } });
  await db.requirementHistory.deleteMany({ where: { requirementId: seedRows } });
  await db.requirement.deleteMany({ where: { id: seedRows } });
  await db.notification.deleteMany({ where: { userId: { in: SEED_USER_IDS } } });
  await db.volunteerAvailability.deleteMany({ where: { volunteerId: { in: SEED_USER_IDS } } });
  await db.incident.deleteMany({ where: { reporterId: { in: SEED_USER_IDS } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: SEED_USER_IDS } } });
}

async function seedReferenceData(passwordHash: string): Promise<void> {
  const db = getPrisma();
  for (const name of CATEGORIES) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await db.category.upsert({ where: { name }, create: { name, slug, isActive: true }, update: { isActive: true } });
  }
  for (const o of ORGS) {
    const data = {
      name: o.name,
      type: o.type,
      address: o.address,
      latitude: o.latitude,
      longitude: o.longitude,
      contactInformation: `${o.name.toLowerCase().replace(/[^a-z]+/g, '.')}@fwrp.demo`,
      verificationStatus: o.verified ? ('VERIFIED' as const) : ('PENDING' as const),
    };
    await db.organization.upsert({ where: { id: o.id }, create: { id: o.id, ...data }, update: data });
  }
  for (const [i, u] of USERS.entries()) {
    const data = {
      name: u.name,
      role: u.role,
      organizationId: u.organizationId,
      phone: `+91 98450 ${String(10000 + i).slice(-5)}`,
      passwordHash,
      status: 'ACTIVE' as const,
    };
    const existing = await db.user.findUnique({ where: { email: u.email }, select: { id: true } });
    if (existing && existing.id !== u.id) {
      throw new Error(`${u.email} already belongs to a non-seed account (${existing.id}); refusing to overwrite it`);
    }
    // Bumping tokenVersion signs out sessions from an earlier demo run.
    await db.user.upsert({
      where: { email: u.email },
      create: { id: u.id, email: u.email, ...data },
      update: { ...data, tokenVersion: { increment: 1 } },
    });
  }
}

async function seedActivity(now: Date): Promise<void> {
  const db = getPrisma();
  const at = (ms: number) => new Date(now.getTime() + ms);

  await db.volunteerAvailability.createMany({
    data: [
      { volunteerId: 'seed-user-vol1', availableFrom: at(0), availableUntil: at(3 * D) },
      { volunteerId: 'seed-user-vol2', availableFrom: at(0), availableUntil: at(12 * H) },
    ],
  });

  const spice = ORGS[0];
  const palace = ORGS[1];
  const donations: Prisma.DonationCreateManyInput[] = [
    {
      id: 'seed-don-biryani', providerId: 'seed-user-spice', foodName: 'Vegetable biryani', category: 'Prepared meals', foodType: 'Vegetarian',
      quantity: 40, unit: 'meals', availableFrom: at(-1 * H), availableUntil: at(5 * H), pickupLocation: spice.address,
      pickupLatitude: spice.latitude, pickupLongitude: spice.longitude, storageRequirement: 'Keep hot (above 60°C)',
      description: 'Surplus from lunch service, packed in foil trays.', status: 'AVAILABLE', createdAt: at(-1 * H),
    },
    {
      id: 'seed-don-bread', providerId: 'seed-user-palace', foodName: 'Fresh bread loaves', category: 'Bakery', foodType: 'Bread',
      quantity: 25, unit: 'loaves', availableFrom: at(0), availableUntil: at(8 * H), pickupLocation: palace.address,
      pickupLatitude: palace.latitude, pickupLongitude: palace.longitude, description: 'Baked this morning.', status: 'AVAILABLE',
    },
    {
      id: 'seed-don-fruit', providerId: 'seed-user-spice', foodName: 'Bananas and apples', category: 'Produce', foodType: 'Fruit',
      quantity: 15, unit: 'kg', availableFrom: at(0), availableUntil: at(24 * H), pickupLocation: spice.address,
      pickupLatitude: spice.latitude, pickupLongitude: spice.longitude, storageRequirement: 'Cool, dry place', status: 'AVAILABLE',
    },
    // History for dashboards/reports.
    {
      id: 'seed-don-done', providerId: 'seed-user-palace', foodName: 'Paneer curry and rice', category: 'Prepared meals', foodType: 'Vegetarian',
      quantity: 30, unit: 'meals', availableFrom: at(-2 * D - 2 * H), availableUntil: at(-2 * D + 4 * H), pickupLocation: palace.address,
      pickupLatitude: palace.latitude, pickupLongitude: palace.longitude, status: 'COMPLETED', createdAt: at(-2 * D - 2 * H),
    },
    {
      id: 'seed-don-expired', providerId: 'seed-user-spice', foodName: 'Sandwich platters', category: 'Prepared meals', foodType: 'Mixed',
      quantity: 12, unit: 'meals', availableFrom: at(-3 * D), availableUntil: at(-3 * D + 3 * H), pickupLocation: spice.address,
      pickupLatitude: spice.latitude, pickupLongitude: spice.longitude, status: 'EXPIRED', createdAt: at(-3 * D),
    },
  ];
  await db.donation.createMany({ data: donations });

  const requirements: Prisma.RequirementCreateManyInput[] = [
    { id: 'seed-req-meals', organizationId: 'seed-org-hope', foodCategory: 'Prepared meals', foodType: 'Vegetarian', quantityRequired: 60, requiredBy: at(10 * H), priority: 'HIGH', location: 'Hope Shelter kitchen, Shivajinagar' },
    { id: 'seed-req-bread', organizationId: 'seed-org-foodbank', foodCategory: 'Bakery', foodType: 'Bread', quantityRequired: 20, requiredBy: at(12 * H), priority: 'MEDIUM', location: 'City Food Bank store room, Jayanagar' },
    { id: 'seed-req-produce', organizationId: 'seed-org-foodbank', foodCategory: 'Produce', foodType: 'Fruit', quantityRequired: 10, requiredBy: at(30 * H), priority: 'LOW', location: 'City Food Bank store room, Jayanagar' },
    // Fulfilled by the completed donation above.
    { id: 'seed-req-past', organizationId: 'seed-org-hope', foodCategory: 'Prepared meals', foodType: 'Vegetarian', quantityRequired: 30, quantityFulfilled: 28, requiredBy: at(-2 * D + 6 * H), priority: 'HIGH', location: 'Hope Shelter kitchen, Shivajinagar', status: 'PARTIALLY_FULFILLED', createdAt: at(-2 * D - 3 * H) },
  ];
  await db.requirement.createMany({ data: requirements });
  await db.requirementHistory.createMany({
    data: requirements.map((r) => ({
      requirementId: r.id!,
      organizationId: r.organizationId,
      actorId: r.organizationId === 'seed-org-hope' ? 'seed-user-hope' : 'seed-user-foodbank',
      action: 'CREATE' as const,
      foodCategory: r.foodCategory,
      foodType: r.foodType,
      quantityRequired: r.quantityRequired,
      quantityFulfilled: 0,
      requiredBy: r.requiredBy as Date,
      priority: r.priority!,
      location: r.location,
      status: 'OPEN' as const,
      timestamp: (r.createdAt as Date | undefined) ?? now,
    })),
  });

  // The completed donation's full trail: acceptance, delivery, confirmation.
  await db.allocation.create({
    data: { donationId: 'seed-don-done', requirementId: 'seed-req-past', committedQuantity: 30, createdAt: at(-2 * D - 1 * H) },
  });
  await db.delivery.create({
    data: {
      donationId: 'seed-don-done', volunteerId: 'seed-user-vol1', status: 'CONFIRMED',
      pickupLocation: palace.address, deliveryLocation: 'Hope Shelter kitchen, Shivajinagar',
      assignedAt: at(-2 * D - 50 * 60 * 1000), pickupTime: at(-2 * D - 20 * 60 * 1000), deliveryTime: at(-2 * D + 10 * 60 * 1000),
      handoverConfirmedAt: at(-2 * D - 20 * 60 * 1000), confirmedAt: at(-2 * D + 15 * 60 * 1000),
      quantityReceived: 28, receiverName: 'John', proofOfDelivery: 'photo://seed/receipt-1',
    },
  });

  // Recommendations (and their notifications) through the real engine.
  for (const id of ['seed-req-meals', 'seed-req-bread', 'seed-req-produce']) {
    await generateMatchesForRequirement(id, now);
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new Error('Refusing to seed demo data in production (set SEED_ALLOW_PRODUCTION=true to override).');
  }
  const now = new Date();
  console.log('Seeding demo data…');
  await resetDemoActivity();
  await seedReferenceData(await hashPassword(DEMO_PASSWORD));
  await seedActivity(now);

  const matches = await getPrisma().match.count({ where: { requirementId: { startsWith: 'seed-' }, status: 'RECOMMENDED' } });
  console.log(`\nDone: ${CATEGORIES.length} categories, ${ORGS.length} organizations, ${USERS.length} accounts, ${matches} live matches.\n`);
  console.log(`All demo accounts use the password: ${DEMO_PASSWORD}\n`);
  console.table(
    USERS.map((u) => ({
      email: u.email,
      role: u.role,
      organization: ORGS.find((o) => o.id === u.organizationId)?.name ?? '—',
      verified: u.organizationId ? (ORGS.find((o) => o.id === u.organizationId)!.verified ? 'yes' : 'PENDING') : '—',
    }))
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
