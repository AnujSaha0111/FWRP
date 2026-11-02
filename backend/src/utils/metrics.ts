import type { DeliveryStatus, DonationStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// ANALYTICS-01: pure impact/KPI aggregation (PRD §9, §10, §11). One function
// feeds the dashboards, the impact endpoint and reports so the numbers agree.
//
// Definitions (PRD §10):
//   Food redistributed     = Σ received quantity of confirmed deliveries
//                            (per unit; meals and kg are never summed together)
//   Fulfillment rate       = COMPLETED / valid × 100, valid = not DRAFT/CANCELLED
//   Expiry rate            = EXPIRED / valid × 100
//   Avg matching time      = first acceptance (allocation) − donation creation
//   Avg pickup time        = pickupTime − assignedAt
//   Avg delivery time      = confirmedAt − pickupTime

export interface MetricDelivery {
  status: DeliveryStatus;
  assignedAt: Date;
  pickupTime: Date | null;
  confirmedAt: Date | null;
  quantityReceived: number | null;
}

export interface MetricAllocation {
  createdAt: Date;
  committedQuantity: number;
}

export interface MetricDonation {
  status: DonationStatus;
  quantity: number;
  unit: string;
  createdAt: Date;
  allocations: MetricAllocation[];
  deliveries: MetricDelivery[];
}

export interface QuantityByUnit {
  unit: string;
  quantity: number;
}

export interface DonationMetrics {
  total: number;
  valid: number;
  byStatus: Partial<Record<DonationStatus, number>>;
  active: number;
  completed: number;
  expired: number;
  cancelled: number;
  /** Percentages with 1 decimal; null when there are no valid donations. */
  fulfillmentRate: number | null;
  expiryRate: number | null;
  quantityListed: QuantityByUnit[];
  redistributed: QuantityByUnit[];
  mealsRedistributed: number;
  weightRedistributedKg: number;
  /** Minutes with 1 decimal; null when no sample exists. */
  averageMatchingMinutes: number | null;
  averagePickupMinutes: number | null;
  averageDeliveryMinutes: number | null;
}

export const ACTIVE_DONATION_STATUSES: readonly DonationStatus[] = [
  'AVAILABLE',
  'MATCHED',
  'ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
];

const MEAL_UNITS = new Set(['meal', 'meals', 'portion', 'portions', 'serving', 'servings', 'plate', 'plates']);
const KG_FACTORS: Record<string, number> = {
  kg: 1,
  kgs: 1,
  kilogram: 1,
  kilograms: 1,
  g: 0.001,
  gram: 0.001,
  grams: 0.001,
};

export function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}

function averageMinutes(samples: number[]): number | null {
  if (samples.length === 0) return null;
  return round1(samples.reduce((a, b) => a + b, 0) / samples.length / 60000);
}

function addTo(map: Map<string, number>, unit: string, quantity: number): void {
  const key = normalizeUnit(unit);
  map.set(key, (map.get(key) ?? 0) + quantity);
}

function toList(map: Map<string, number>): QuantityByUnit[] {
  return [...map.entries()]
    .map(([unit, quantity]) => ({ unit, quantity: round1(quantity) }))
    .sort((a, b) => b.quantity - a.quantity || a.unit.localeCompare(b.unit));
}

/** Received quantity of a donation: confirmed delivery amounts, else nothing. */
export function receivedQuantity(donation: Pick<MetricDonation, 'deliveries'>): number {
  return donation.deliveries
    .filter((d) => d.status === 'CONFIRMED')
    .reduce((sum, d) => sum + (d.quantityReceived ?? 0), 0);
}

export function aggregateDonationMetrics(donations: readonly MetricDonation[]): DonationMetrics {
  const byStatus: Partial<Record<DonationStatus, number>> = {};
  const listed = new Map<string, number>();
  const redistributed = new Map<string, number>();
  const matching: number[] = [];
  const pickup: number[] = [];
  const delivery: number[] = [];

  for (const d of donations) {
    byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    if (d.status !== 'DRAFT' && d.status !== 'CANCELLED') addTo(listed, d.unit, d.quantity);

    const received = receivedQuantity(d);
    if (received > 0) addTo(redistributed, d.unit, received);

    if (d.allocations.length > 0) {
      const accepted = Math.min(...d.allocations.map((a) => a.createdAt.getTime()));
      matching.push(Math.max(0, accepted - d.createdAt.getTime()));
    }
    for (const del of d.deliveries) {
      if (del.pickupTime) pickup.push(Math.max(0, del.pickupTime.getTime() - del.assignedAt.getTime()));
      if (del.pickupTime && del.confirmedAt) {
        delivery.push(Math.max(0, del.confirmedAt.getTime() - del.pickupTime.getTime()));
      }
    }
  }

  const count = (s: DonationStatus) => byStatus[s] ?? 0;
  const valid = donations.length - count('DRAFT') - count('CANCELLED');
  const redistributedList = toList(redistributed);
  let meals = 0;
  let kg = 0;
  for (const { unit, quantity } of redistributedList) {
    if (MEAL_UNITS.has(unit)) meals += quantity;
    if (unit in KG_FACTORS) kg += quantity * KG_FACTORS[unit];
  }

  return {
    total: donations.length,
    valid,
    byStatus,
    active: ACTIVE_DONATION_STATUSES.reduce((sum, s) => sum + count(s), 0),
    completed: count('COMPLETED'),
    expired: count('EXPIRED'),
    cancelled: count('CANCELLED'),
    fulfillmentRate: rate(count('COMPLETED'), valid),
    expiryRate: rate(count('EXPIRED'), valid),
    quantityListed: toList(listed),
    redistributed: redistributedList,
    mealsRedistributed: round1(meals),
    weightRedistributedKg: round1(kg),
    averageMatchingMinutes: averageMinutes(matching),
    averagePickupMinutes: averageMinutes(pickup),
    averageDeliveryMinutes: averageMinutes(delivery),
  };
}
