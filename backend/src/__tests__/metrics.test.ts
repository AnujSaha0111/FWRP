import { describe, it, expect } from 'vitest';
import { aggregateDonationMetrics, type MetricDonation } from '../utils/metrics';

// ANALYTICS-01: PRD §10 formulas on hand-computed fixtures.

const T0 = new Date('2026-09-01T10:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60000);

function donation(overrides: Partial<MetricDonation> = {}): MetricDonation {
  return { status: 'AVAILABLE', quantity: 10, unit: 'meals', createdAt: T0, allocations: [], deliveries: [], ...overrides };
}

function completed(quantityReceived: number, unit = 'meals', times = { accept: 30, assign: 40, pickup: 60, confirm: 120 }): MetricDonation {
  return donation({
    status: 'COMPLETED',
    quantity: quantityReceived,
    unit,
    allocations: [{ createdAt: min(times.accept), committedQuantity: quantityReceived }],
    deliveries: [
      { status: 'CONFIRMED', assignedAt: min(times.assign), pickupTime: min(times.pickup), confirmedAt: min(times.confirm), quantityReceived },
    ],
  });
}

describe('ANALYTICS-01 aggregateDonationMetrics', () => {
  it('returns nulls (not zeros or NaN) for empty input', () => {
    const m = aggregateDonationMetrics([]);
    expect(m).toMatchObject({
      total: 0,
      valid: 0,
      fulfillmentRate: null,
      expiryRate: null,
      averageMatchingMinutes: null,
      averagePickupMinutes: null,
      averageDeliveryMinutes: null,
      redistributed: [],
      mealsRedistributed: 0,
    });
  });

  it('fulfillment and expiry rates use valid donations (excluding DRAFT and CANCELLED)', () => {
    const m = aggregateDonationMetrics([
      completed(10),
      completed(10),
      donation({ status: 'EXPIRED' }),
      donation({ status: 'AVAILABLE' }),
      donation({ status: 'CANCELLED' }),
      donation({ status: 'DRAFT' }),
    ]);
    expect(m.total).toBe(6);
    expect(m.valid).toBe(4);
    expect(m.fulfillmentRate).toBe(50);
    expect(m.expiryRate).toBe(25);
    expect(m.active).toBe(1);
    expect(m.cancelled).toBe(1);
  });

  it('food redistributed sums confirmed received quantities per unit, never mixing units', () => {
    const m = aggregateDonationMetrics([
      completed(40),
      completed(25),
      completed(12.5, 'kg'),
      completed(500, 'g'),
      // Delivered but not yet confirmed: not redistributed.
      donation({
        status: 'DELIVERED',
        deliveries: [{ status: 'DELIVERED', assignedAt: T0, pickupTime: T0, confirmedAt: null, quantityReceived: null }],
      }),
    ]);
    expect(m.redistributed).toEqual([
      { unit: 'g', quantity: 500 },
      { unit: 'meals', quantity: 65 },
      { unit: 'kg', quantity: 12.5 },
    ]);
    expect(m.mealsRedistributed).toBe(65);
    expect(m.weightRedistributedKg).toBe(13);
  });

  it('uses the received quantity, not the listed quantity', () => {
    const d = completed(45);
    d.quantity = 60;
    const m = aggregateDonationMetrics([d]);
    expect(m.redistributed).toEqual([{ unit: 'meals', quantity: 45 }]);
    expect(m.quantityListed).toEqual([{ unit: 'meals', quantity: 60 }]);
  });

  it('averages matching, pickup and delivery times in minutes', () => {
    const m = aggregateDonationMetrics([
      completed(10, 'meals', { accept: 30, assign: 40, pickup: 60, confirm: 120 }),
      completed(10, 'meals', { accept: 90, assign: 100, pickup: 140, confirm: 160 }),
    ]);
    expect(m.averageMatchingMinutes).toBe(60); // (30 + 90) / 2
    expect(m.averagePickupMinutes).toBe(30); // (20 + 40) / 2
    expect(m.averageDeliveryMinutes).toBe(40); // (60 + 20) / 2
  });

  it('matching time uses the first acceptance when there are several allocations', () => {
    const d = completed(10);
    d.allocations = [
      { createdAt: min(50), committedQuantity: 5 },
      { createdAt: min(20), committedQuantity: 5 },
    ];
    expect(aggregateDonationMetrics([d]).averageMatchingMinutes).toBe(20);
  });

  it('treats unit spelling case-insensitively', () => {
    const m = aggregateDonationMetrics([completed(5, ' Meals '), completed(5, 'MEALS')]);
    expect(m.redistributed).toEqual([{ unit: 'meals', quantity: 10 }]);
  });
});
