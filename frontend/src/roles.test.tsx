import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { emptyPage, mockApi, profile, renderRoute } from '@/test/utils';

// Recipient, volunteer and admin flows over the real router and API client.

const hour = 3600_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

function signedIn(role: 'RECIPIENT' | 'VOLUNTEER' | 'ADMIN') {
  return {
    'GET /api/users/me': () => ({ data: profile(role) }),
    'GET /api/notifications/unread-count': () => ({ data: { count: 0 } }),
  };
}

function page<T>(items: T[]) {
  return { ...emptyPage, items, total: items.length };
}

const match = {
  id: 'm-1',
  matchingScore: 0.89,
  distance: 1.12,
  status: 'RECOMMENDED',
  createdAt: iso(0),
  updatedAt: iso(0),
  donation: {
    id: 'don-1',
    providerId: 'p',
    foodName: 'Vegetable biryani',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 40,
    unit: 'meals',
    availableFrom: iso(-hour),
    availableUntil: iso(5 * hour),
    pickupLocation: '12 MG Road',
    status: 'AVAILABLE',
  },
  requirement: {
    id: 'req-1',
    organizationId: 'org-1',
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 60,
    quantityFulfilled: 0,
    requiredBy: iso(10 * hour),
    priority: 'HIGH',
    location: 'Hope Shelter',
    status: 'OPEN',
    organization: { id: 'org-1', name: 'Hope Shelter' },
  },
};

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    organization_id: 'org-1',
    food_category: 'Prepared meals',
    food_type: 'Vegetarian',
    quantity_required: 60,
    quantity_fulfilled: 20,
    required_by: iso(10 * hour),
    priority: 'HIGH',
    location: 'Hope Shelter kitchen',
    status: 'PARTIALLY_FULFILLED',
    created_at: iso(-hour),
    updated_at: iso(-hour),
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    status: 'DELIVERED',
    needsReassignment: false,
    assignedAt: iso(-2 * hour),
    pickupTime: iso(-hour),
    deliveryTime: iso(-60_000),
    declinedAt: null,
    declineReason: null,
    handoverConfirmedAt: null,
    confirmedAt: null,
    quantityReceived: null,
    receiverName: null,
    proofOfDelivery: null,
    notes: null,
    volunteer: { id: 'vol', name: 'Vikram', phone: '+91 98450 10006' },
    donation: {
      id: 'don-1',
      foodName: 'Vegetable biryani',
      category: 'Prepared meals',
      foodType: 'Vegetarian',
      quantity: 40,
      unit: 'meals',
      availableUntil: iso(4 * hour),
      storageRequirement: 'Keep hot',
      status: 'DELIVERED',
      committedQuantity: 40,
    },
    pickup: { location: '12 MG Road', latitude: 12.97, longitude: 77.6, provider: { name: 'Ravi', phone: '+91 1', organization: 'Spice Route', contact: null } },
    dropoff: { location: 'Hope Shelter kitchen', latitude: 12.98, longitude: 77.6, requirementId: 'req-1', organization: { id: 'org-1', name: 'Hope Shelter', contact: null } },
    createdAt: iso(-2 * hour),
    updatedAt: iso(0),
    ...overrides,
  };
}

// ---------------------------------------------------------------- recipient

describe('recipient', () => {
  it('accepts a match after confirming', async () => {
    const { calls } = mockApi({
      ...signedIn('RECIPIENT'),
      'GET /api/matches': () => ({ data: page([match]) }),
      'POST /api/matches/m-1/accept': () => ({ data: { donation: { id: 'don-1' }, allocation: { committedQuantity: 40 } } }),
    });
    renderRoute('/recipient/matches');
    expect(await screen.findByText('Vegetable biryani')).toBeInTheDocument();
    expect(screen.getByText('89%')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept donation' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/matches/m-1/accept')).toBe(true));
  });

  it('lists only the organization’s own requirements, not other open ones', async () => {
    mockApi({
      ...signedIn('RECIPIENT'),
      'GET /api/requirements': () => ({
        data: page([requirement(), requirement({ id: 'req-x', organization_id: 'org-other', food_category: 'Bakery', status: 'OPEN' })]),
      }),
    });
    renderRoute('/recipient/requirements');
    expect(await screen.findByText(/Prepared meals · Vegetarian/)).toBeInTheDocument();
    expect(screen.getByText('20 of 60 received')).toBeInTheDocument();
    expect(screen.queryByText(/Bakery/)).not.toBeInTheDocument();
  });

  it('confirms receipt with the received quantity', async () => {
    const { calls } = mockApi({
      ...signedIn('RECIPIENT'),
      'GET /api/deliveries/del-1': () => ({ data: { delivery: delivery() } }),
      'POST /api/deliveries/del-1/confirm': () => ({ data: { delivery: delivery({ status: 'CONFIRMED' }) } }),
    });
    renderRoute('/recipient/deliveries/del-1');
    const qty = await screen.findByLabelText(/Quantity received/);
    expect(qty).toHaveValue(40);
    await userEvent.clear(qty);
    await userEvent.type(qty, '35');
    await userEvent.type(screen.getByLabelText(/Received by/), 'John');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/deliveries/del-1/confirm')?.body).toEqual({ quantityReceived: 35, receiverName: 'John' }));
  });
});

// ---------------------------------------------------------------- volunteer

describe('volunteer', () => {
  it('accepts a new assignment', async () => {
    const { calls } = mockApi({
      ...signedIn('VOLUNTEER'),
      'GET /api/deliveries/del-1': () => ({ data: { delivery: delivery({ status: 'ASSIGNED', pickupTime: null, deliveryTime: null }) } }),
      'POST /api/deliveries/del-1/respond': () => ({ data: { delivery: delivery({ status: 'ACCEPTED' }) } }),
    });
    renderRoute('/volunteer/deliveries/del-1');
    await userEvent.click(await screen.findByRole('button', { name: 'Accept pickup' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/deliveries/del-1/respond')?.body).toEqual({ action: 'ACCEPT' }));
  });

  it('shows exactly one next step and advances the delivery', async () => {
    const { calls } = mockApi({
      ...signedIn('VOLUNTEER'),
      'GET /api/deliveries/del-1': () => ({ data: { delivery: delivery({ status: 'ACCEPTED', pickupTime: null, deliveryTime: null }) } }),
      'POST /api/deliveries/del-1/status': () => ({ data: { delivery: delivery({ status: 'AT_PICKUP' }) } }),
    });
    renderRoute('/volunteer/deliveries/del-1');
    await userEvent.click(await screen.findByRole('button', { name: 'I’m at the pickup' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/deliveries/del-1/status')?.body).toEqual({ status: 'AT_PICKUP' }));
    expect(screen.queryByRole('button', { name: 'Delivered' })).not.toBeInTheDocument();
  });

  it('validates availability windows before saving', async () => {
    const { calls } = mockApi({ ...signedIn('VOLUNTEER'), 'GET /api/volunteers/me/availability': () => ({ data: { windows: [] } }) });
    renderRoute('/volunteer/availability');
    const until = await screen.findByLabelText('Until');
    await userEvent.clear(until);
    await userEvent.type(until, '2020-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Add window' }));
    expect(await screen.findByText(/must be after the start|must be in the future/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

// ---------------------------------------------------------------- admin

describe('admin', () => {
  const org = {
    id: 'org-9',
    name: 'Little Hands Kitchen',
    type: 'COMMUNITY_KITCHEN',
    address: '3 Koramangala',
    latitude: 12.93,
    longitude: 77.62,
    contactInformation: null,
    verificationStatus: 'UNDER_REVIEW',
    createdAt: iso(-hour),
    updatedAt: iso(-hour),
  };

  it('rejecting an organization requires a reason', async () => {
    const { calls } = mockApi({
      ...signedIn('ADMIN'),
      'GET /api/admin/organizations': () => ({ data: page([org]) }),
      'PUT /api/admin/organizations/org-9/verify': () => ({ data: { organization: { ...org, verificationStatus: 'REJECTED' } } }),
    });
    renderRoute('/admin/organizations');
    await userEvent.click(await screen.findByRole('tab', { name: 'Under Review' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('Give a short reason (3+ characters)')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Address could not be confirmed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/admin/organizations/org-9/verify')?.body).toEqual({ action: 'REJECT', reason: 'Address could not be confirmed' })
    );
  });

  it('assigns a free volunteer from the pickup queue', async () => {
    const { calls } = mockApi({
      ...signedIn('ADMIN'),
      'GET /api/deliveries/pending': () => ({
        data: {
          awaitingVolunteer: [{ donationId: 'don-1', foodName: 'Vegetable biryani', quantity: 40, unit: 'meals', pickupLocation: '12 MG Road', availableUntil: iso(hour), recipientOrganization: 'Hope Shelter' }],
          declined: [],
        },
      }),
      'GET /api/volunteers/available': () => ({
        data: { from: iso(0), until: iso(hour), volunteers: [{ id: 'vol-1', name: 'Vikram', phone: '+91 1', windows: [{ id: 'w', availableFrom: iso(0), availableUntil: iso(3 * hour) }] }] },
      }),
      'POST /api/deliveries': () => ({ status: 201, data: { delivery: delivery({ status: 'ASSIGNED' }) } }),
    });
    renderRoute('/admin/pickups');
    await userEvent.click(await screen.findByRole('button', { name: /Assign volunteer/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('radio', { name: /Vikram/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/deliveries')?.body).toEqual({ donationId: 'don-1', volunteerId: 'vol-1' }));
  });

  it('suspends a user with a reason', async () => {
    const user = { ...profile('PROVIDER').user, id: 'u-9', name: 'Pat', organization: null };
    const { calls } = mockApi({
      ...signedIn('ADMIN'),
      'GET /api/admin/users': () => ({ data: page([user]) }),
      'GET /api/admin/users/u-9': () => ({ data: { user, activity: { donations: 3, deliveries: 0, incidentsReported: 0, incidentsAbout: 1 } } }),
      'PUT /api/admin/users/u-9/status': () => ({ data: { user: { ...user, status: 'SUSPENDED' } } }),
    });
    renderRoute('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend' }));
    const dialog = await screen.findByRole('dialog', { name: /Suspend Pat/ });
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Repeated no-shows');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ status: 'SUSPENDED', reason: 'Repeated no-shows' }));
  });

  it('settings reject invalid weights before saving', async () => {
    const { calls } = mockApi({
      ...signedIn('ADMIN'),
      'GET /api/admin/settings': () => ({
        data: {
          settings: [
            {
              key: 'matching.weights',
              value: { distance: 0.25, food: 0.25, quantity: 0.15, priority: 0.15, urgency: 0.1, transport: 0.1 },
              default: {},
              description: 'Score weights',
              overridden: false,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      }),
    });
    renderRoute('/admin/settings');
    const distance = await screen.findByLabelText('Distance');
    await userEvent.clear(distance);
    await userEvent.type(distance, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Each weight must be between 0 and 1.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('resolving an incident needs a note for the reporter', async () => {
    const incident = {
      id: 'inc-1',
      type: 'ACCOUNT_REPORT',
      status: 'OPEN',
      reason: 'No-show',
      description: 'Did not come to pick up.',
      donationId: null,
      deliveryId: null,
      resolution: null,
      resolvedAt: null,
      createdAt: iso(-hour),
      updatedAt: iso(-hour),
      reporter: { id: 'r', name: 'John', role: 'RECIPIENT' },
      subjectUser: { id: 'v', name: 'Vikram', role: 'VOLUNTEER', status: 'ACTIVE' },
      resolvedBy: null,
    };
    const { calls } = mockApi({
      ...signedIn('ADMIN'),
      'GET /api/admin/incidents': () => ({ data: page([incident]) }),
      'PUT /api/admin/incidents/inc-1': () => ({ data: { incident: { ...incident, status: 'RESOLVED' } } }),
    });
    renderRoute('/admin/incidents');
    await userEvent.click(await screen.findByRole('button', { name: /No-show/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(await within(dialog).findByText('Write a short resolution note for the reporter.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Resolution note'), 'Spoke with the volunteer; warned.');
    await userEvent.click(within(dialog).getByLabelText(/Also suspend Vikram/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ status: 'RESOLVED', resolution: 'Spoke with the volunteer; warned.', suspendSubject: true })
    );
  });
});
