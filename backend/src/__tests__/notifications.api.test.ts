import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { startNotificationJob } from '../jobs/notifications';
import { createEmailService, MockEmailProvider } from '../services/email.service';
import { collectAlerts, sendDueAlerts } from '../services/notificationAlerts.service';
import {
  dispatchPendingEmails,
  MAX_EMAIL_ATTEMPTS,
  renderNotificationEmail,
} from '../services/notificationDispatch.service';
import { signAccessToken } from '../utils/jwt';

// NOTIF-01 inbox API, NOTIF-04 time-based alerts, NOTIF-06 email outbox.

const NOW = new Date('2026-09-20T12:00:00.000Z');
const MIN = 60000;

type Row = Record<string, unknown> & { id: string };

function token(id: string, role = 'RECIPIENT') {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: null } as never);
}

// ---------------------------------------------------------------------------
// In-memory notification store for the inbox API and dispatcher.

function notificationStore(rows: Row[]) {
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ('in' in o) return (o.in as unknown[]).includes(r[k]);
        if ('lt' in o) return (r[k] as number) < (o.lt as number);
        if ('gte' in o) return (r[k] as Date).getTime() >= (o.gte as Date).getTime();
      }
      return (r[k] ?? null) === v;
    });
  const notification = {
    findMany: vi.fn(async ({ where, take, skip }: { where: Record<string, unknown>; take?: number; skip?: number }) =>
      rows
        .filter((r) => matches(r, where))
        .slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length))
        .map((r) => ({ ...r, user: r.user ?? { email: `${r.userId}@example.com`, name: String(r.userId), status: 'ACTIVE' } }))
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = rows.filter((r) => matches(r, where));
      for (const r of hits) {
        for (const [k, v] of Object.entries(data)) {
          r[k] = v && typeof v === 'object' && 'increment' in (v as object) ? (r[k] as number) + (v as { increment: number }).increment : v;
        }
      }
      return { count: hits.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `n-${rows.length + 1}`, isRead: false, createdAt: NOW, emailedAt: null, emailAttempts: 0, ...data };
      rows.push(row);
      return row;
    }),
  };
  return { notification, rows };
}

function notif(overrides: Partial<Row> = {}): Row {
  return {
    id: `n-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'u1',
    type: 'PICKUP_ASSIGNED',
    title: 'New pickup',
    message: 'Pick up the curry',
    isRead: false,
    createdAt: NOW,
    entityType: 'Delivery',
    entityId: 'del-1',
    emailedAt: null,
    emailAttempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getPrisma).mockReset();
});

describe('NOTIF-01 inbox API', () => {
  function mount(rows: Row[]) {
    const store = notificationStore(rows);
    vi.mocked(getPrisma).mockReturnValue({ notification: store.notification } as unknown as PrismaClient);
    return store;
  }

  it('lists only the caller’s notifications, optionally unread only', async () => {
    mount([notif({ id: 'a' }), notif({ id: 'b', isRead: true }), notif({ id: 'c', userId: 'u2' })]);
    const app = createApp();
    const all = await request(app).get('/api/notifications').set('Authorization', `Bearer ${token('u1')}`);
    expect(all.status).toBe(200);
    expect(all.body.data.items.map((n: Row) => n.id).sort()).toEqual(['a', 'b']);
    expect(all.body.data.items[0]).toMatchObject({ entityType: 'Delivery', entityId: 'del-1' });
    const unread = await request(app).get('/api/notifications?unread=true').set('Authorization', `Bearer ${token('u1')}`);
    expect(unread.body.data.items.map((n: Row) => n.id)).toEqual(['a']);
  });

  it('counts unread, marks one and all read, and hides other users’ rows (404)', async () => {
    const store = mount([notif({ id: 'a' }), notif({ id: 'b' }), notif({ id: 'c', userId: 'u2' })]);
    const app = createApp();
    const auth = { Authorization: `Bearer ${token('u1')}` };
    expect((await request(app).get('/api/notifications/unread-count').set(auth)).body.data).toEqual({ count: 2 });
    const one = await request(app).post('/api/notifications/a/read').set(auth);
    expect(one.body.data.notification).toMatchObject({ id: 'a', isRead: true });
    expect((await request(app).post('/api/notifications/c/read').set(auth)).status).toBe(404);
    expect((await request(app).get('/api/notifications/c').set(auth)).status).toBe(404);
    expect((await request(app).post('/api/notifications/read-all').set(auth)).body.data).toEqual({ count: 1 });
    expect(store.rows.find((r) => r.id === 'c')!.isRead).toBe(false);
  });

  it('requires authentication and validates the query', async () => {
    mount([]);
    const app = createApp();
    expect((await request(app).get('/api/notifications')).status).toBe(401);
    const bad = await request(app).get('/api/notifications?unread=maybe').set('Authorization', `Bearer ${token('u1')}`);
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('NOTIF-06 email outbox', () => {
  function setup(rows: Row[], fail = false) {
    const store = notificationStore(rows);
    const provider = new MockEmailProvider();
    const email = fail
      ? { providerName: 'mock', send: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'EMAIL_SEND_FAILED' }); }) }
      : createEmailService(provider);
    return { store, provider, email, client: { notification: store.notification } as unknown as PrismaClient };
  }

  it('emails committed rows of key types once, marking them emailed', async () => {
    const { store, provider, email, client } = setup([
      notif({ id: 'a' }),
      notif({ id: 'b', type: 'DONATION_CREATED' }), // not an email type
      notif({ id: 'c', createdAt: new Date(NOW.getTime() - 25 * 60 * MIN) }), // too old
      notif({ id: 'd', emailedAt: new Date(NOW.getTime() - MIN) }), // already sent
    ]);
    const summary = await dispatchPendingEmails(NOW, email, client);
    expect(summary).toEqual({ scanned: 1, sent: 1, failed: 0, skipped: 0 });
    const sent = provider.getCaptured();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'u1@example.com', subject: 'FWRP: New pickup', type: 'PICKUP_ASSIGNED' });
    expect(store.rows.find((r) => r.id === 'a')!.emailedAt).toEqual(NOW);
    expect(await dispatchPendingEmails(NOW, email, client)).toMatchObject({ scanned: 0, sent: 0 });
  });

  it('retries failures up to the attempt cap, then stops', async () => {
    const { store, email, client } = setup([notif({ id: 'a' })], true);
    for (let i = 0; i < MAX_EMAIL_ATTEMPTS + 2; i++) await dispatchPendingEmails(NOW, email, client);
    expect(email.send).toHaveBeenCalledTimes(MAX_EMAIL_ATTEMPTS);
    expect(store.rows[0]).toMatchObject({ emailedAt: null, emailAttempts: MAX_EMAIL_ATTEMPTS });
  });

  it('never emails inactive accounts', async () => {
    const { provider, email, client, store } = setup([
      notif({ id: 'a', user: { email: 'x@example.com', name: 'X', status: 'SUSPENDED' } }),
    ]);
    const summary = await dispatchPendingEmails(NOW, email, client);
    expect(summary.skipped).toBe(1);
    expect(provider.getCaptured()).toHaveLength(0);
    expect(store.rows[0].emailAttempts).toBe(MAX_EMAIL_ATTEMPTS);
  });

  it('escapes HTML and strips line breaks from the subject', () => {
    const body = renderNotificationEmail('<b>Ann</b>', 'Hi\r\nBcc: evil@x', 'Use <script>');
    expect(body.subject).toBe('FWRP: Hi Bcc: evil@x');
    expect(body.html).not.toContain('<script>');
    expect(body.html).not.toContain('<b>Ann</b>');
  });
});

// ---------------------------------------------------------------------------

describe('NOTIF-04 time-based alerts', () => {
  function alertClient(store: ReturnType<typeof notificationStore>) {
    const soon = new Date(NOW.getTime() + 30 * MIN);
    const past = new Date(NOW.getTime() - 10 * MIN);
    return {
      notification: store.notification,
      user: { findMany: vi.fn(async () => [{ id: 'admin' }]) },
      donation: {
        findMany: vi.fn(async ({ where }: { where: { status: unknown } }) =>
          where.status === 'ACCEPTED'
            ? [{ id: 'don-acc', foodName: 'Rice', availableUntil: soon }]
            : [{ id: 'don-av', providerId: 'prov', foodName: 'Curry', availableUntil: soon }]
        ),
      },
      requirement: {
        findMany: vi.fn(async () => [
          { id: 'req', foodCategory: 'Bakery', requiredBy: soon, organization: { users: [{ id: 'rec' }] } },
        ]),
      },
      delivery: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          'OR' in where
            ? [
                { id: 'del-late', status: 'IN_TRANSIT', donation: { foodName: 'Soup', allocations: [{ requirement: { organization: { users: [{ id: 'rec' }] } } }] } },
                { id: 'del-missed', status: 'ACCEPTED', donation: { foodName: 'Bread', allocations: [] } },
              ]
            : [{ id: 'del-pick', volunteerId: 'vol', pickupLocation: 'Main St', donation: { foodName: 'Curry', availableUntil: soon } }]
        ),
      },
      _past: past,
    } as unknown as PrismaClient;
  }

  it('collects expiry warnings, pickup reminders and delay alerts for the right people', async () => {
    const alerts = await collectAlerts(alertClient(notificationStore([])), NOW);
    const summary = alerts.map((a) => `${a.type}:${a.entityId}:${a.userId}`).sort();
    expect(summary).toEqual(
      [
        'EXPIRY_WARNING:don-av:prov',
        'EXPIRY_WARNING:don-acc:admin',
        'EXPIRY_WARNING:req:rec',
        'PICKUP_REMINDER:del-pick:vol',
        'DELIVERY_DELAYED:del-late:admin',
        'DELIVERY_DELAYED:del-late:rec',
        'DELIVERY_DELAYED:del-missed:admin',
      ].sort()
    );
    expect(alerts.find((a) => a.entityId === 'don-av')!.message).toContain('30 min');
  });

  it('sends each alert once per user and entity across runs', async () => {
    const store = notificationStore([]);
    const client = alertClient(store);
    const first = await sendDueAlerts(NOW, client);
    expect(first.sent).toBe(7);
    const second = await sendDueAlerts(NOW, client);
    expect(second).toEqual({ candidates: 7, sent: 0 });
    expect(store.rows).toHaveLength(7);
    expect(store.rows.every((r) => r.entityId && r.entityType)).toBe(true);
  });

  it('notification job is disabled at 0 minutes', () => {
    expect(startNotificationJob(0, vi.fn())).toBeNull();
  });
});
