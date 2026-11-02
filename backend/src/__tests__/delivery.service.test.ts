import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import {
  assignDelivery,
  confirmHandover,
  confirmReceipt,
  getDelivery,
  listDeliveries,
  listPendingAssignments,
  reassignDelivery,
  respondToAssignment,
  updateDeliveryStatus,
} from '../services/delivery.service';
import { addAvailability, deleteAvailability, listAvailableVolunteers } from '../services/volunteers.service';
import {
  canDeliveryTransition,
  DELIVERY_TRANSITIONS,
  DONATION_STATUS_FOR_DELIVERY,
} from '../utils/deliveryState';
import { canTransition } from '../utils/donationState';
import { signAccessToken } from '../utils/jwt';

// LOG-01..LOG-07, DELCONF-01..03: availability, assignment, volunteer workflow,
// handover and receipt confirmation against an in-memory store.

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

type Row = Record<string, unknown> & { id: string };

function makeStore(overrides: { requirementStatus?: string; quantityFulfilled?: number; allocation?: boolean } = {}) {
  const orgs: Row[] = [
    { id: 'org-p', name: 'Bistro', address: 'Main St 1', latitude: 52.52, longitude: 13.405, contactInformation: 'p@x' },
    { id: 'org-r', name: 'Shelter', address: 'Side St 2', latitude: 52.53, longitude: 13.41, contactInformation: 'r@x' },
  ];
  const users: Row[] = [
    { id: 'admin', name: 'Ada', phone: '1', role: 'ADMIN', status: 'ACTIVE', organizationId: null },
    { id: 'prov', name: 'Pat', phone: '2', role: 'PROVIDER', status: 'ACTIVE', organizationId: 'org-p' },
    { id: 'rec', name: 'Rae', phone: '3', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-r' },
    { id: 'rec-other', name: 'Ola', phone: '4', role: 'RECIPIENT', status: 'ACTIVE', organizationId: 'org-x' },
    { id: 'vol', name: 'Val', phone: '5', role: 'VOLUNTEER', status: 'ACTIVE', organizationId: null },
    { id: 'vol2', name: 'Vic', phone: '6', role: 'VOLUNTEER', status: 'ACTIVE', organizationId: null },
  ];
  const requirements: Row[] = [
    {
      id: 'req',
      organizationId: 'org-r',
      foodCategory: 'Prepared meals',
      foodType: 'Vegetarian',
      quantityRequired: 100,
      quantityFulfilled: overrides.quantityFulfilled ?? 0,
      requiredBy: new Date(NOW.getTime() + 12 * HOUR),
      priority: 'HIGH',
      location: 'Shelter kitchen door',
      status: overrides.requirementStatus ?? 'OPEN',
    },
  ];
  const allocations: Row[] =
    overrides.allocation === false ? [] : [{ id: 'alloc', donationId: 'don', requirementId: 'req', committedQuantity: 60, createdAt: NOW }];
  const donations: Row[] = [
    {
      id: 'don',
      providerId: 'prov',
      foodName: 'Veg curry',
      category: 'Prepared meals',
      foodType: 'Vegetarian',
      quantity: 60,
      unit: 'meals',
      availableFrom: new Date(NOW.getTime() - HOUR),
      availableUntil: new Date(NOW.getTime() + 6 * HOUR),
      pickupLocation: 'Main St 1',
      pickupLatitude: null,
      pickupLongitude: null,
      storageRequirement: null,
      status: 'ACCEPTED',
    },
  ];
  const windows: Row[] = [
    { id: 'w-vol', volunteerId: 'vol', availableFrom: NOW, availableUntil: new Date(NOW.getTime() + 4 * HOUR) },
    { id: 'w-vol2', volunteerId: 'vol2', availableFrom: NOW, availableUntil: new Date(NOW.getTime() + 4 * HOUR) },
  ];
  const deliveries: Row[] = [];
  const history: Row[] = [];
  const notifications: Row[] = [];
  const audits: Row[] = [];
  let seq = 0;

  const user = (id: unknown) => users.find((u) => u.id === id);
  const org = (id: unknown) => orgs.find((o) => o.id === id) ?? null;
  const donationDetail = (d: Row) => ({
    ...d,
    provider: { ...user(d.providerId)!, organization: org(user(d.providerId)!.organizationId) },
    allocations: allocations
      .filter((a) => a.donationId === d.id)
      .map((a) => {
        const r = requirements.find((x) => x.id === a.requirementId)!;
        return { ...a, requirement: { ...r, organization: org(r.organizationId) } };
      }),
  });
  const deliveryDetail = (row: Row) => ({
    ...row,
    volunteer: user(row.volunteerId),
    donation: donationDetail(donations.find((d) => d.id === row.donationId)!),
  });
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'AND') return (v as Record<string, unknown>[]).every((w) => matches(row, w));
      if (k === 'donation' || k === 'volunteer') return true; // relation scopes covered by service checks
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ('in' in o) return (o.in as unknown[]).includes(row[k]);
        if ('not' in o) return o.not === null ? row[k] !== null && row[k] !== undefined : row[k] !== o.not;
        if ('lt' in o) return (row[k] as Date).getTime() < (o.lt as Date).getTime();
        if ('gt' in o) return (row[k] as Date).getTime() > (o.gt as Date).getTime();
        return true;
      }
      return (row[k] ?? null) === v;
    });

  const client: Record<string, unknown> = {
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => user(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => users.filter((u) => matches(u, where))),
    },
    donation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = donations.find((x) => x.id === where.id);
        return d ? donationDetail(d) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        donations.filter((d) => matches(d, where)).map(donationDetail)
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Record<string, unknown> }) => {
        const hits = donations.filter((d) => matches(d, where));
        hits.forEach((d) => Object.assign(d, data));
        return { count: hits.length };
      }),
    },
    delivery: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = deliveries.find((x) => x.id === where.id);
        return r ? deliveryDetail(r) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        deliveries.filter((d) => matches(d, where)).map(deliveryDetail)
      ),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => deliveries.filter((d) => matches(d, where)).length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `del-${++seq}`,
          pickupTime: null,
          deliveryTime: null,
          proofOfDelivery: null,
          declinedAt: null,
          declineReason: null,
          handoverConfirmedAt: null,
          confirmedAt: null,
          quantityReceived: null,
          receiverName: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        } as Row;
        deliveries.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = deliveries.filter((d) => matches(d, where));
        hits.forEach((d) => Object.assign(d, data));
        return { count: hits.length };
      }),
    },
    volunteerAvailability: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const range = {
          from: (where.availableUntil as { gt?: Date })?.gt,
          until: (where.availableFrom as { lt?: Date })?.lt,
        };
        return windows
          .filter((w) => !where.volunteerId || w.volunteerId === where.volunteerId)
          .filter((w) => !range.from || (w.availableUntil as Date) > range.from)
          .filter((w) => !range.until || (w.availableFrom as Date) < range.until)
          .filter((w) => user(w.volunteerId)?.status === 'ACTIVE')
          .map((w) => ({ ...w, volunteer: user(w.volunteerId) }));
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `w-${++seq}`, ...data } as Row;
        windows.push(row);
        return { id: row.id, availableFrom: row.availableFrom, availableUntil: row.availableUntil };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; volunteerId: string } }) => {
        const i = windows.findIndex((w) => w.id === where.id && w.volunteerId === where.volunteerId);
        if (i >= 0) windows.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      }),
    },
    requirement: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => requirements.find((r) => r.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = requirements.filter((r) => matches(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { count: hits.length };
      }),
    },
    requirementHistory: { create: vi.fn(async ({ data }: { data: Row }) => (history.push(data), data)) },
    notification: { create: vi.fn(async ({ data }: { data: Row }) => (notifications.push(data), data)) },
    auditLog: { create: vi.fn(async ({ data }: { data: Row }) => (audits.push(data), data)) },
  };
  client.$transaction = vi.fn(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(client)
  );
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { client, users, donations, deliveries, windows, requirements, history, notifications, audits };
}

function token(id: string, role: string, organizationId: string | null = null) {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId } as never);
}

async function assigned(store = makeStore()) {
  const { delivery } = await assignDelivery('admin', { donationId: 'don', volunteerId: 'vol' }, NOW);
  return { store, id: delivery.id };
}

async function delivered() {
  const { store, id } = await assigned();
  await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
  for (const status of ['AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'] as const) {
    await updateDeliveryStatus('vol', id, { status }, NOW);
  }
  return { store, id };
}

beforeEach(() => {
  vi.mocked(getPrisma).mockReset();
});

describe('LOG-02 delivery state machine', () => {
  it('is linear ASSIGNED → … → CONFIRMED with no skips or reversals', () => {
    const order = ['ASSIGNED', 'ACCEPTED', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CONFIRMED'] as const;
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        expect(canDeliveryTransition(order[i], order[j])).toBe(j === i + 1);
      }
    }
    expect(DELIVERY_TRANSITIONS.CONFIRMED).toEqual([]);
  });

  it('every mirrored donation status follows the donation state machine in order', () => {
    const chain = ['ACCEPTED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'] as const;
    const mirrored = ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CONFIRMED'] as const;
    mirrored.forEach((s, i) => {
      expect(DONATION_STATUS_FOR_DELIVERY[s]).toBe(chain[i + 1]);
      expect(canTransition(chain[i], chain[i + 1])).toBe(true);
    });
  });
});

describe('LOG-01 volunteer availability', () => {
  it('adds a window and rejects overlapping, past or over-long windows', async () => {
    makeStore();
    const later = { availableFrom: new Date(NOW.getTime() + 5 * HOUR), availableUntil: new Date(NOW.getTime() + 8 * HOUR) };
    const { window } = await addAvailability('vol', later, NOW);
    expect(window.availableFrom).toEqual(later.availableFrom);
    await expect(addAvailability('vol', later, NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      addAvailability('vol', { availableFrom: new Date(NOW.getTime() - 3 * HOUR), availableUntil: new Date(NOW.getTime() - HOUR) }, NOW)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      addAvailability('vol', { availableFrom: NOW, availableUntil: new Date(NOW.getTime() + 8 * 24 * HOUR) }, NOW)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('only volunteers manage availability, and only their own windows', async () => {
    makeStore();
    await expect(addAvailability('prov', { availableFrom: NOW, availableUntil: new Date(NOW.getTime() + HOUR) }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteAvailability('vol', 'w-vol2')).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteAvailability('vol', 'w-vol')).resolves.toEqual({ deleted: true });
  });

  it('admin lookup lists free volunteers for the pickup window and drops busy ones', async () => {
    makeStore();
    const before = await listAvailableVolunteers('admin', { donationId: 'don' }, NOW);
    expect(before.volunteers.map((v) => v.id).sort()).toEqual(['vol', 'vol2']);
    await assignDelivery('admin', { donationId: 'don', volunteerId: 'vol' }, NOW);
    const after = await listAvailableVolunteers('admin', { donationId: 'don' }, NOW);
    expect(after.volunteers.map((v) => v.id)).toEqual(['vol2']);
  });
});

describe('LOG-03 assignment', () => {
  it('creates an ASSIGNED delivery, moves the donation to PICKUP_ASSIGNED and notifies everyone', async () => {
    const { store, id } = await assigned();
    const row = store.deliveries[0];
    expect(row).toMatchObject({ id, status: 'ASSIGNED', volunteerId: 'vol', pickupLocation: 'Main St 1', deliveryLocation: 'Shelter kitchen door' });
    expect(store.donations[0].status).toBe('PICKUP_ASSIGNED');
    expect(store.notifications.map((n) => n.userId).sort()).toEqual(['prov', 'rec', 'vol']);
    expect(store.audits).toContainEqual(expect.objectContaining({ action: 'DELIVERY_ASSIGNED' }));
  });

  it('rejects non-accepted donations, donations without an allocation, and busy/unavailable volunteers', async () => {
    const s1 = makeStore();
    s1.donations[0].status = 'AVAILABLE';
    await expect(assignDelivery('admin', { donationId: 'don', volunteerId: 'vol' }, NOW)).rejects.toMatchObject({ statusCode: 409 });

    makeStore({ allocation: false });
    await expect(assignDelivery('admin', { donationId: 'don', volunteerId: 'vol' }, NOW)).rejects.toMatchObject({ code: 'NO_RECIPIENT_ALLOCATION' });

    const s3 = makeStore();
    s3.windows.splice(0, s3.windows.length);
    await expect(assignDelivery('admin', { donationId: 'don', volunteerId: 'vol' }, NOW)).rejects.toMatchObject({ code: 'VOLUNTEER_UNAVAILABLE' });

    const s4 = makeStore();
    s4.deliveries.push({ id: 'busy', volunteerId: 'vol', donationId: 'other', status: 'IN_TRANSIT', declinedAt: null });
    await expect(assignDelivery('admin', { donationId: 'don', volunteerId: 'vol' }, NOW)).rejects.toMatchObject({ code: 'OVERLAPPING_ASSIGNMENT' });
    expect(s4.donations[0].status).toBe('ACCEPTED');
  });

  it('is admin-only', async () => {
    makeStore();
    await expect(assignDelivery('prov', { donationId: 'don', volunteerId: 'vol' }, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('LOG-04 volunteer response and reassignment', () => {
  it('accepting moves ASSIGNED → ACCEPTED; other volunteers cannot respond', async () => {
    const { store, id } = await assigned();
    await expect(respondToAssignment('vol2', id, { action: 'ACCEPT' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    const { delivery } = await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    expect(delivery.status).toBe('ACCEPTED');
    expect(store.deliveries[0].status).toBe('ACCEPTED');
  });

  it('declining keeps ASSIGNED, flags it for reassignment and frees the volunteer', async () => {
    const { store, id } = await assigned();
    const { delivery } = await respondToAssignment('vol', id, { action: 'DECLINE', reason: 'Car broke down' }, NOW);
    expect(delivery).toMatchObject({ status: 'ASSIGNED', needsReassignment: true, declineReason: 'Car broke down' });
    const pending = await listPendingAssignments('admin', NOW);
    expect(pending.declined.map((d) => d.id)).toEqual([id]);
    // Declined rows disappear from the volunteer's own list.
    expect((await listDeliveries('vol', {})).items).toHaveLength(0);
    await expect(respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW)).rejects.toMatchObject({ statusCode: 409 });

    const { delivery: moved } = await reassignDelivery('admin', id, { volunteerId: 'vol2' }, NOW);
    expect(moved).toMatchObject({ status: 'ASSIGNED', needsReassignment: false, volunteer: { id: 'vol2' } });
    expect(store.deliveries[0].declinedAt).toBeNull();
  });

  it('cannot reassign after pickup', async () => {
    const { id } = await assigned();
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    await updateDeliveryStatus('vol', id, { status: 'AT_PICKUP' }, NOW);
    await expect(reassignDelivery('admin', id, { volunteerId: 'vol2' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('LOG-05 progress updates', () => {
  it('walks the chain, stamps times, records proof and mirrors the donation status', async () => {
    const { store, id } = await assigned();
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    await updateDeliveryStatus('vol', id, { status: 'AT_PICKUP' }, NOW);
    expect(store.donations[0].status).toBe('PICKUP_ASSIGNED');
    await updateDeliveryStatus('vol', id, { status: 'PICKED_UP' }, NOW);
    expect(store.donations[0].status).toBe('PICKED_UP');
    expect(store.deliveries[0].pickupTime).toEqual(NOW);
    await updateDeliveryStatus('vol', id, { status: 'IN_TRANSIT' }, NOW);
    expect(store.donations[0].status).toBe('IN_TRANSIT');
    const { delivery } = await updateDeliveryStatus('vol', id, { status: 'DELIVERED', proofOfDelivery: 'photos/1.jpg' }, NOW);
    expect(delivery).toMatchObject({ status: 'DELIVERED', proofOfDelivery: 'photos/1.jpg', deliveryTime: NOW });
    expect(store.donations[0].status).toBe('DELIVERED');
    expect(store.notifications).toContainEqual(expect.objectContaining({ userId: 'rec', type: 'CONFIRMATION_PENDING' }));
  });

  it('rejects skipped steps, foreign volunteers and proof before delivery', async () => {
    const { id } = await assigned();
    await expect(updateDeliveryStatus('vol', id, { status: 'AT_PICKUP' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    await expect(updateDeliveryStatus('vol', id, { status: 'DELIVERED' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    await expect(updateDeliveryStatus('vol2', id, { status: 'AT_PICKUP' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      updateDeliveryStatus('vol', id, { status: 'AT_PICKUP', proofOfDelivery: 'x' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('DELCONF-01 provider handover', () => {
  it('at the pickup, the provider handover performs the pickup', async () => {
    const { store, id } = await assigned();
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    await expect(confirmHandover('prov', id, NOW)).rejects.toMatchObject({ statusCode: 409 });
    await updateDeliveryStatus('vol', id, { status: 'AT_PICKUP' }, NOW);
    const { delivery } = await confirmHandover('prov', id, NOW);
    expect(delivery).toMatchObject({ status: 'PICKED_UP', handoverConfirmedAt: NOW, pickupTime: NOW });
    expect(store.donations[0].status).toBe('PICKED_UP');
    await expect(confirmHandover('prov', id, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('after the volunteer already picked up, it only records the confirmation', async () => {
    const { id } = await assigned();
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    await updateDeliveryStatus('vol', id, { status: 'AT_PICKUP' }, NOW);
    await updateDeliveryStatus('vol', id, { status: 'PICKED_UP' }, NOW);
    const { delivery } = await confirmHandover('prov', id, NOW);
    expect(delivery).toMatchObject({ status: 'PICKED_UP', handoverConfirmedAt: NOW });
  });
});

describe('DELCONF-02/03 receipt confirmation', () => {
  it('confirms, completes the donation and partially fulfils the requirement with history', async () => {
    const { store, id } = await delivered();
    const result = await confirmReceipt('rec', id, { receiverName: 'Rae' }, NOW);
    expect(result.delivery).toMatchObject({ status: 'CONFIRMED', quantityReceived: 60, receiverName: 'Rae', confirmedAt: NOW });
    expect(result.requirement).toEqual({ id: 'req', quantityFulfilled: 60, status: 'PARTIALLY_FULFILLED' });
    expect(store.donations[0].status).toBe('COMPLETED');
    expect(store.history).toHaveLength(1);
    expect(store.history[0]).toMatchObject({ action: 'UPDATE', quantityFulfilled: 60, status: 'PARTIALLY_FULFILLED' });
    expect(store.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['DELIVERY_CONFIRMED', 'DONATION_COMPLETED']));
    expect(store.notifications.filter((n) => n.type === 'DELIVERY_COMPLETED').map((n) => n.userId).sort()).toEqual(['prov', 'vol']);
  });

  it('a delivery covering the remainder fulfils the requirement (OPEN → FULFILLED via REQ-04 steps)', async () => {
    const store = makeStore({ quantityFulfilled: 40 });
    await assigned(store);
    const id = store.deliveries[0].id;
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    for (const status of ['AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'] as const) {
      await updateDeliveryStatus('vol', id, { status }, NOW);
    }
    const result = await confirmReceipt('rec', id, {}, NOW);
    expect(result.requirement).toEqual({ id: 'req', quantityFulfilled: 100, status: 'FULFILLED' });
  });

  it('records a smaller received quantity and rejects more than was donated', async () => {
    const { id } = await delivered();
    await expect(confirmReceipt('rec', id, { quantityReceived: 61 }, NOW)).rejects.toMatchObject({ statusCode: 400 });
    const result = await confirmReceipt('rec', id, { quantityReceived: 45 }, NOW);
    expect(result.requirement?.quantityFulfilled).toBe(45);
  });

  it('leaves a closed requirement untouched but still completes the donation', async () => {
    const store = makeStore({ requirementStatus: 'CANCELLED' });
    await assigned(store);
    const id = store.deliveries[0].id;
    await respondToAssignment('vol', id, { action: 'ACCEPT' }, NOW);
    for (const status of ['AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'] as const) {
      await updateDeliveryStatus('vol', id, { status }, NOW);
    }
    const result = await confirmReceipt('rec', id, {}, NOW);
    expect(result.requirement).toBeNull();
    expect(store.requirements[0]).toMatchObject({ status: 'CANCELLED', quantityFulfilled: 0 });
    expect(store.donations[0].status).toBe('COMPLETED');
  });

  it('only the receiving organization can confirm, only once, and only after delivery', async () => {
    const { store, id } = await assigned();
    await expect(confirmReceipt('rec', id, {}, NOW)).rejects.toMatchObject({ statusCode: 409 });
    const { id: done } = await delivered();
    await expect(confirmReceipt('rec-other', done, {}, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await confirmReceipt('rec', done, {}, NOW);
    await expect(confirmReceipt('rec', done, {}, NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(store.deliveries[0].status).toBe('ASSIGNED');
  });
});

describe('LOG-06 reads', () => {
  it('scopes visibility: volunteer, provider and receiving recipient see it; others get 404', async () => {
    const { id } = await assigned();
    for (const userId of ['admin', 'vol', 'prov', 'rec']) {
      await expect(getDelivery(userId, id)).resolves.toBeDefined();
    }
    await expect(getDelivery('vol2', id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getDelivery('rec-other', id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('exposes pickup/drop-off locations and coordinates for the volunteer', async () => {
    const { id } = await assigned();
    const { delivery } = await getDelivery('vol', id);
    expect(delivery.pickup).toMatchObject({ location: 'Main St 1', latitude: 52.52, longitude: 13.405, provider: { name: 'Pat', organization: 'Bistro' } });
    expect(delivery.dropoff).toMatchObject({ location: 'Shelter kitchen door', latitude: 52.53, organization: { name: 'Shelter' } });
    expect(delivery.donation.committedQuantity).toBe(60);
  });
});

describe('LOG/DELCONF HTTP surface', () => {
  it('requires authentication and enforces roles per endpoint', async () => {
    const app = createApp();
    expect((await request(app).get('/api/deliveries')).status).toBe(401);
    makeStore();
    const asProvider = await request(app)
      .post('/api/deliveries')
      .set('Authorization', `Bearer ${token('prov', 'PROVIDER', 'org-p')}`)
      .send({ donationId: 'don', volunteerId: 'vol' });
    expect(asProvider.status).toBe(403);
    const asVolunteer = await request(app)
      .post('/api/deliveries/x/confirm')
      .set('Authorization', `Bearer ${token('vol', 'VOLUNTEER')}`)
      .send({});
    expect(asVolunteer.status).toBe(403);
    const avail = await request(app)
      .get('/api/volunteers/me/availability')
      .set('Authorization', `Bearer ${token('admin', 'ADMIN')}`);
    expect(avail.status).toBe(403);
  });

  it('validates bodies before reaching the service', async () => {
    makeStore();
    const app = createApp();
    const res = await request(app)
      .post('/api/deliveries/x/status')
      .set('Authorization', `Bearer ${token('vol', 'VOLUNTEER')}`)
      .send({ status: 'CONFIRMED' });
    expect(res.status).toBe(400);
    const bad = await request(app)
      .post('/api/deliveries/x/respond')
      .set('Authorization', `Bearer ${token('vol', 'VOLUNTEER')}`)
      .send({ action: 'MAYBE' });
    expect(bad.status).toBe(400);
  });

  it('serves the admin pending queue before /:id', async () => {
    makeStore();
    const res = await request(createApp())
      .get('/api/deliveries/pending')
      .set('Authorization', `Bearer ${token('admin', 'ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('awaitingVolunteer');
    expect(res.body.data).toHaveProperty('declined');
  });
});
