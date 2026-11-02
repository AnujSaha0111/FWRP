import { z } from 'zod';
import type { DonationStatus, Prisma, PrismaClient, Role } from '@prisma/client';
import { DonationStatus as DonationStatusEnum } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { ACTIVE_DELIVERY_STATUSES } from '../utils/deliveryState';
import { MATCHABLE_DONATION_STATUSES, MATCHABLE_REQUIREMENT_STATUSES } from '../utils/matchingCompatibility';
import {
  ACTIVE_DONATION_STATUSES,
  aggregateDonationMetrics,
  receivedQuantity,
  type DonationMetrics,
  type QuantityByUnit,
} from '../utils/metrics';
import { strictDateField } from '../utils/validation';
import { IN_FLIGHT_DONATION_STATUSES } from './matching.service';

// ---------------------------------------------------------------------------
// ANALYTICS-02..05: role dashboards (PRD §9), impact metrics (§10) and admin
// reports (§11). Read-only. All figures come from aggregateDonationMetrics
// (utils/metrics.ts) over an explicitly scoped donation set, so a dashboard,
// the impact endpoint and a report over the same scope agree.

type Client = PrismaClient;

/** Upper bound on donations aggregated per request; narrow the date range beyond it. */
export const MAX_ANALYTICS_ROWS = 20000;

const METRIC_SELECT = {
  id: true,
  providerId: true,
  foodName: true,
  category: true,
  status: true,
  quantity: true,
  unit: true,
  pickupLocation: true,
  createdAt: true,
  provider: { select: { name: true, organization: { select: { id: true, name: true } } } },
  allocations: {
    select: {
      createdAt: true,
      committedQuantity: true,
      requirement: { select: { organization: { select: { id: true, name: true } } } },
    },
  },
  deliveries: {
    select: { status: true, assignedAt: true, pickupTime: true, confirmedAt: true, quantityReceived: true },
  },
} as const;

type MetricRow = Prisma.DonationGetPayload<{ select: typeof METRIC_SELECT }>;

// ---------------------------------------------------------------------------
// Helpers

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  return parsed.data;
}

function mapAnalyticsError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak SQL, constraint names, or connection details.
  return new AppError(500, 'ANALYTICS_FAILED', 'Analytics request failed');
}

async function loadCaller(client: Client, userId: string) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, organizationId: true },
  });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  return user;
}

function requireAdmin(role: Role): void {
  if (role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
}

async function loadMetricRows(client: Client, where: Prisma.DonationWhereInput): Promise<MetricRow[]> {
  const rows = await client.donation.findMany({
    where,
    select: METRIC_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: MAX_ANALYTICS_ROWS + 1,
  });
  if (rows.length > MAX_ANALYTICS_ROWS) {
    throw new AppError(
      413,
      'REPORT_TOO_LARGE',
      `More than ${MAX_ANALYTICS_ROWS} donations match; narrow the date range or filters`
    );
  }
  return rows;
}

const dateRange = {
  from: strictDateField('from').optional(),
  to: strictDateField('to').optional(),
};

function assertRange(from?: Date, to?: Date): void {
  if (from && to && to.getTime() <= from.getTime()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'to', message: 'to must be after from' },
    ]);
  }
}

/** Date range applies to donation creation time: [from, to). */
function createdWithin(from?: Date, to?: Date): Prisma.DonationWhereInput {
  if (!from && !to) return {};
  return { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
}

function receivedByUnit(rows: MetricRow[]): QuantityByUnit[] {
  return aggregateDonationMetrics(rows).redistributed;
}

// ---------------------------------------------------------------------------
// ANALYTICS-02: dashboards (PRD §9)

export const dashboardQuerySchema = z.object(dateRange).strict();

export interface ProviderDashboard {
  role: 'PROVIDER';
  activeDonations: number;
  completedDonations: number;
  expiredDonations: number;
  successfulRedistributions: number;
  quantityDonated: QuantityByUnit[];
  quantityRedistributed: QuantityByUnit[];
  fulfillmentRate: number | null;
  recentActivity: Array<{ donationId: string; foodName: string; status: DonationStatus; updatedAt: Date }>;
}

export interface RecipientDashboard {
  role: 'RECIPIENT';
  openRequirements: number;
  fulfilledRequirements: number;
  availableDonations: number;
  recommendedMatches: number;
  acceptedDonations: number;
  pendingDeliveries: number;
  awaitingConfirmation: number;
  history: { completedDeliveries: number; quantityReceived: QuantityByUnit[]; totalRequirements: number };
}

export interface VolunteerDashboard {
  role: 'VOLUNTEER';
  activeDeliveries: number;
  completedDeliveries: number;
  upcomingAvailabilityWindows: number;
  averagePickupMinutes: number | null;
}

export interface AdminDashboard {
  role: 'ADMIN';
  activeDonations: number;
  completedDonations: number;
  expiredDonations: number;
  pendingPickups: number;
  activeDeliveries: number;
  verifiedOrganizations: number;
  activeVolunteers: number;
  kpis: ImpactKpis;
}

export type Dashboard = ProviderDashboard | RecipientDashboard | VolunteerDashboard | AdminDashboard;

export async function getDashboard(userId: string, query: unknown, now: Date = new Date()): Promise<Dashboard> {
  const q = parse(dashboardQuerySchema, query);
  assertRange(q.from, q.to);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  try {
    switch (caller.role) {
      case 'PROVIDER':
        return await providerDashboard(client, caller.id, q.from, q.to);
      case 'RECIPIENT':
        if (!caller.organizationId) throw new AppError(403, 'FORBIDDEN', 'Organization required');
        return await recipientDashboard(client, caller.organizationId, now, q.from, q.to);
      case 'VOLUNTEER':
        return await volunteerDashboard(client, caller.id, now);
      case 'ADMIN':
        return await adminDashboard(client, now, q.from, q.to);
      default:
        throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    }
  } catch (err) {
    throw mapAnalyticsError(err);
  }
}

async function providerDashboard(client: Client, providerId: string, from?: Date, to?: Date): Promise<ProviderDashboard> {
  const where: Prisma.DonationWhereInput = { providerId, ...createdWithin(from, to) };
  const [rows, recent] = await Promise.all([
    loadMetricRows(client, where),
    client.donation.findMany({
      where: { providerId },
      select: { id: true, foodName: true, status: true, updatedAt: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 10,
    }),
  ]);
  const m = aggregateDonationMetrics(rows);
  return {
    role: 'PROVIDER',
    activeDonations: m.active,
    completedDonations: m.completed,
    expiredDonations: m.expired,
    successfulRedistributions: m.completed,
    quantityDonated: m.quantityListed,
    quantityRedistributed: m.redistributed,
    fulfillmentRate: m.fulfillmentRate,
    recentActivity: recent.map((d) => ({ donationId: d.id, foodName: d.foodName, status: d.status, updatedAt: d.updatedAt })),
  };
}

async function recipientDashboard(
  client: Client,
  organizationId: string,
  now: Date,
  from?: Date,
  to?: Date
): Promise<RecipientDashboard> {
  const toOrg = { allocations: { some: { requirement: { organizationId } } } };
  const [requirementGroups, availableDonations, recommendedMatches, accepted, pendingDeliveries, awaiting, rows] =
    await Promise.all([
      client.requirement.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
      // Same visibility as the recipient browse (DON-06): AVAILABLE and inside its window.
      client.donation.count({ where: { status: 'AVAILABLE', availableFrom: { lte: now }, availableUntil: { gt: now } } }),
      client.match.count({
        where: {
          status: 'RECOMMENDED',
          requirement: { organizationId, status: { in: [...MATCHABLE_REQUIREMENT_STATUSES] }, requiredBy: { gt: now } },
          donation: { status: { in: [...MATCHABLE_DONATION_STATUSES] }, availableUntil: { gt: now } },
        },
      }),
      client.donation.count({ where: { ...toOrg, status: { in: [...IN_FLIGHT_DONATION_STATUSES, 'DELIVERED'] } } }),
      client.delivery.count({ where: { donation: toOrg, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } }),
      client.delivery.count({ where: { donation: toOrg, status: 'DELIVERED' } }),
      loadMetricRows(client, { ...toOrg, ...createdWithin(from, to) }),
    ]);
  const byStatus = Object.fromEntries(requirementGroups.map((g) => [g.status, g._count._all])) as Record<string, number>;
  const completedForOrg = rows.filter((r) => r.status === 'COMPLETED');
  return {
    role: 'RECIPIENT',
    openRequirements: (byStatus.OPEN ?? 0) + (byStatus.PARTIALLY_FULFILLED ?? 0),
    fulfilledRequirements: byStatus.FULFILLED ?? 0,
    availableDonations,
    recommendedMatches,
    acceptedDonations: accepted,
    pendingDeliveries,
    awaitingConfirmation: awaiting,
    history: {
      completedDeliveries: completedForOrg.length,
      quantityReceived: receivedByUnit(completedForOrg),
      totalRequirements: requirementGroups.reduce((sum, g) => sum + g._count._all, 0),
    },
  };
}

async function volunteerDashboard(client: Client, volunteerId: string, now: Date): Promise<VolunteerDashboard> {
  const [active, completed, windows, pickups] = await Promise.all([
    client.delivery.count({ where: { volunteerId, declinedAt: null, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } }),
    client.delivery.count({ where: { volunteerId, status: { in: ['DELIVERED', 'CONFIRMED'] } } }),
    client.volunteerAvailability.count({ where: { volunteerId, availableUntil: { gt: now } } }),
    client.delivery.findMany({
      where: { volunteerId, pickupTime: { not: null } },
      select: { assignedAt: true, pickupTime: true },
    }),
  ]);
  const samples = pickups.map((p) => p.pickupTime!.getTime() - p.assignedAt.getTime());
  return {
    role: 'VOLUNTEER',
    activeDeliveries: active,
    completedDeliveries: completed,
    upcomingAvailabilityWindows: windows,
    averagePickupMinutes:
      samples.length > 0 ? Math.round((samples.reduce((a, b) => a + b, 0) / samples.length / 60000) * 10) / 10 : null,
  };
}

async function adminDashboard(client: Client, now: Date, from?: Date, to?: Date): Promise<AdminDashboard> {
  const [statusGroups, activeDeliveries, verifiedOrganizations, activeVolunteers, kpis] = await Promise.all([
    client.donation.groupBy({ by: ['status'], _count: { _all: true } }),
    client.delivery.count({ where: { declinedAt: null, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } }),
    client.organization.count({ where: { verificationStatus: 'VERIFIED' } }),
    // Active volunteer: active account that is on a delivery or has upcoming availability.
    client.user.count({
      where: {
        role: 'VOLUNTEER',
        status: 'ACTIVE',
        OR: [
          { volunteerAvailability: { some: { availableUntil: { gt: now } } } },
          { volunteerDeliveries: { some: { declinedAt: null, status: { in: [...ACTIVE_DELIVERY_STATUSES] } } } },
        ],
      },
    }),
    impactKpis(client, from, to),
  ]);
  const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all])) as Record<string, number>;
  return {
    role: 'ADMIN',
    activeDonations: ACTIVE_DONATION_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0),
    completedDonations: byStatus.COMPLETED ?? 0,
    expiredDonations: byStatus.EXPIRED ?? 0,
    // Accepted, waiting for a volunteer (assignment moves them to PICKUP_ASSIGNED).
    pendingPickups: byStatus.ACCEPTED ?? 0,
    activeDeliveries,
    verifiedOrganizations,
    activeVolunteers,
    kpis,
  };
}

// ---------------------------------------------------------------------------
// ANALYTICS-03: impact metrics (PRD §10)

export const impactQuerySchema = z.object(dateRange).strict();

export interface ImpactKpis {
  from: Date | null;
  to: Date | null;
  totalDonations: number;
  validDonations: number;
  completedDonations: number;
  expiredDonations: number;
  mealsRedistributed: number;
  weightRedistributedKg: number;
  redistributed: QuantityByUnit[];
  fulfillmentRate: number | null;
  expiryRate: number | null;
  averageMatchingMinutes: number | null;
  averagePickupMinutes: number | null;
  averageDeliveryMinutes: number | null;
}

function toKpis(m: DonationMetrics, from?: Date, to?: Date): ImpactKpis {
  return {
    from: from ?? null,
    to: to ?? null,
    totalDonations: m.total,
    validDonations: m.valid,
    completedDonations: m.completed,
    expiredDonations: m.expired,
    mealsRedistributed: m.mealsRedistributed,
    weightRedistributedKg: m.weightRedistributedKg,
    redistributed: m.redistributed,
    fulfillmentRate: m.fulfillmentRate,
    expiryRate: m.expiryRate,
    averageMatchingMinutes: m.averageMatchingMinutes,
    averagePickupMinutes: m.averagePickupMinutes,
    averageDeliveryMinutes: m.averageDeliveryMinutes,
  };
}

async function impactKpis(client: Client, from?: Date, to?: Date): Promise<ImpactKpis> {
  return toKpis(aggregateDonationMetrics(await loadMetricRows(client, createdWithin(from, to))), from, to);
}

export async function getImpact(userId: string, query: unknown): Promise<ImpactKpis> {
  const q = parse(impactQuerySchema, query);
  assertRange(q.from, q.to);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireAdmin(caller.role);
  try {
    return await impactKpis(client, q.from, q.to);
  } catch (err) {
    throw mapAnalyticsError(err);
  }
}

// ---------------------------------------------------------------------------
// ANALYTICS-04/05: admin reports (PRD §11) with CSV export

export const reportQuerySchema = z
  .object({
    ...dateRange,
    providerId: z.string().trim().min(1).max(255).optional(),
    recipientOrganizationId: z.string().trim().min(1).max(255).optional(),
    category: z.string().trim().min(1).max(200).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    status: z.nativeEnum(DonationStatusEnum).optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface ReportParty {
  id: string;
  name: string;
  donations: number;
  completed: number;
  redistributed: QuantityByUnit[];
}

export interface Report {
  filters: Omit<ReportQuery, 'format'>;
  generatedAt: Date;
  summary: ImpactKpis & { cancelledDonations: number; byStatus: DonationMetrics['byStatus'] };
  averageResponseMinutes: number | null;
  mostActiveDonors: ReportParty[];
  mostActiveRecipients: ReportParty[];
  failedDonations: Array<{
    donationId: string;
    foodName: string;
    status: DonationStatus;
    provider: string;
    createdAt: Date;
  }>;
}

function reportWhere(q: ReportQuery): Prisma.DonationWhereInput {
  return {
    ...createdWithin(q.from, q.to),
    ...(q.providerId ? { providerId: q.providerId } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.category ? { category: { equals: q.category, mode: 'insensitive' as const } } : {}),
    ...(q.location ? { pickupLocation: { contains: q.location, mode: 'insensitive' as const } } : {}),
    ...(q.recipientOrganizationId
      ? { allocations: { some: { requirement: { organizationId: q.recipientOrganizationId } } } }
      : {}),
  };
}

function rankParties(groups: Map<string, { name: string; rows: MetricRow[] }>): ReportParty[] {
  return [...groups.entries()]
    .map(([id, g]) => {
      const m = aggregateDonationMetrics(g.rows);
      return { id, name: g.name, donations: g.rows.length, completed: m.completed, redistributed: m.redistributed };
    })
    .sort((a, b) => b.completed - a.completed || b.donations - a.donations || a.name.localeCompare(b.name))
    .slice(0, 10);
}

export function buildReport(rows: MetricRow[], q: ReportQuery, now: Date): Report {
  const m = aggregateDonationMetrics(rows);
  const donors = new Map<string, { name: string; rows: MetricRow[] }>();
  const recipients = new Map<string, { name: string; rows: MetricRow[] }>();
  for (const r of rows) {
    const donorName = r.provider.organization?.name ?? r.provider.name;
    const donor = donors.get(r.providerId) ?? { name: donorName, rows: [] };
    donor.rows.push(r);
    donors.set(r.providerId, donor);
    for (const org of new Map(r.allocations.map((a) => [a.requirement.organization.id, a.requirement.organization])).values()) {
      const entry = recipients.get(org.id) ?? { name: org.name, rows: [] };
      entry.rows.push(r);
      recipients.set(org.id, entry);
    }
  }
  const { format: _format, ...filters } = q;
  return {
    filters,
    generatedAt: now,
    summary: { ...toKpis(m, q.from, q.to), cancelledDonations: m.cancelled, byStatus: m.byStatus },
    // Response time (PRD §11) = time from listing to acceptance.
    averageResponseMinutes: m.averageMatchingMinutes,
    mostActiveDonors: rankParties(donors),
    mostActiveRecipients: rankParties(recipients),
    failedDonations: rows
      .filter((r) => r.status === 'CANCELLED' || r.status === 'EXPIRED')
      .slice(0, 100)
      .map((r) => ({
        donationId: r.id,
        foodName: r.foodName,
        status: r.status,
        provider: r.provider.organization?.name ?? r.provider.name,
        createdAt: r.createdAt,
      })),
  };
}

const CSV_COLUMNS = [
  'donationId',
  'createdAt',
  'provider',
  'foodName',
  'category',
  'quantity',
  'unit',
  'status',
  'pickupLocation',
  'recipientOrganization',
  'acceptedAt',
  'pickedUpAt',
  'confirmedAt',
  'quantityReceived',
] as const;

/** RFC 4180 quoting; cells starting with = + - @ are prefixed to block spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toReportCsv(rows: MetricRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const accepted = r.allocations.length > 0 ? new Date(Math.min(...r.allocations.map((a) => a.createdAt.getTime()))) : null;
    const pickedUp = r.deliveries.find((d) => d.pickupTime)?.pickupTime ?? null;
    const confirmed = r.deliveries.find((d) => d.confirmedAt)?.confirmedAt ?? null;
    const received = receivedQuantity(r);
    const cells = [
      r.id,
      r.createdAt,
      r.provider.organization?.name ?? r.provider.name,
      r.foodName,
      r.category,
      r.quantity,
      r.unit,
      r.status,
      r.pickupLocation,
      [...new Set(r.allocations.map((a) => a.requirement.organization.name))].join('; '),
      accepted,
      pickedUp,
      confirmed,
      received > 0 ? received : null,
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export async function getReport(
  userId: string,
  query: unknown,
  now: Date = new Date()
): Promise<{ format: 'json'; report: Report } | { format: 'csv'; csv: string; filename: string }> {
  const q = parse(reportQuerySchema, query);
  assertRange(q.from, q.to);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireAdmin(caller.role);
  try {
    const rows = await loadMetricRows(client, reportWhere(q));
    if (q.format === 'csv') {
      return { format: 'csv', csv: toReportCsv(rows), filename: `fwrp-report-${now.toISOString().slice(0, 10)}.csv` };
    }
    return { format: 'json', report: buildReport(rows, q, now) };
  } catch (err) {
    throw mapAnalyticsError(err);
  }
}
