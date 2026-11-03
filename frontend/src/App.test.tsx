import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { emptyPage, mockApi, profile, renderRoute } from '@/test/utils';

// End-to-end-ish UI tests over the real router, providers and API client,
// with fetch answered by an in-memory fake backend.

const anonymous = {
  'GET /api/users/me': () => ({ status: 401, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
  'POST /api/auth/refresh': () => ({ status: 401, error: { code: 'UNAUTHORIZED', message: 'Refresh token required' } }),
};

function signedIn(role: 'PROVIDER' | 'RECIPIENT' = 'PROVIDER', verification = 'VERIFIED') {
  return {
    'GET /api/users/me': () => ({ data: profile(role, verification) }),
    'GET /api/notifications/unread-count': () => ({ data: { count: 3 } }),
  };
}

const providerDashboard = {
  role: 'PROVIDER',
  activeDonations: 2,
  completedDonations: 5,
  expiredDonations: 1,
  successfulRedistributions: 5,
  quantityDonated: [{ unit: 'meals', quantity: 120 }],
  quantityRedistributed: [{ unit: 'meals', quantity: 98 }],
  fulfillmentRate: 62.5,
  recentActivity: [{ donationId: 'don-1', foodName: 'Veg biryani', status: 'AVAILABLE', updatedAt: new Date().toISOString() }],
};

describe('sign out', () => {
  it('clears the session, lands on sign in, and stays signed out', async () => {
    let signedIn = true;
    const { calls } = mockApi({
      'GET /api/users/me': () => (signedIn ? { data: profile('PROVIDER') } : { status: 401, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      'POST /api/auth/refresh': () => ({ status: 401, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return { data: { loggedOut: true } };
      },
      'GET /api/notifications/unread-count': () => ({ data: { count: 0 } }),
      'GET /api/analytics/dashboard': () => ({ data: providerDashboard }),
    });
    const { router } = renderRoute('/provider');
    await userEvent.click(await screen.findByRole('button', { name: /Account menu/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/logout')).toBe(true);
    // Going back to a protected page must not restore the old session.
    await router.navigate('/provider');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('routing and guards', () => {
  it('sends anonymous visitors to sign in', async () => {
    mockApi(anonymous);
    renderRoute('/provider/donations');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('sends a signed-in user from another role’s area to their own home', async () => {
    mockApi({ ...signedIn('PROVIDER'), 'GET /api/analytics/dashboard': () => ({ data: providerDashboard }) });
    const { router } = renderRoute('/recipient');
    await waitFor(() => expect(router.state.location.pathname).toBe('/provider'));
  });

  it('shows the unread count on the bell and a pending-verification banner', async () => {
    mockApi({ ...signedIn('PROVIDER', 'PENDING'), 'GET /api/analytics/dashboard': () => ({ data: providerDashboard }) });
    renderRoute('/provider');
    expect(await screen.findByRole('link', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getByText('Verification pending')).toBeInTheDocument();
  });
});

describe('sign in', () => {
  it('validates before calling the API', async () => {
    const { calls } = mockApi(anonymous);
    renderRoute('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/auth/login')).toBe(false);
  });

  it('explains wrong credentials and signs in to the role home', async () => {
    let authed = false;
    let attempts = 0;
    mockApi({
      'GET /api/users/me': () => (authed ? { data: profile('PROVIDER') } : { status: 401, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      'POST /api/auth/refresh': () => ({ status: 401, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      'POST /api/auth/login': () => {
        attempts += 1;
        if (attempts === 1) return { status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } };
        authed = true;
        return { data: { user: profile('PROVIDER').user } };
      },
      'GET /api/notifications/unread-count': () => ({ data: { count: 0 } }),
      'GET /api/analytics/dashboard': () => ({ data: providerDashboard }),
    });
    const { router } = renderRoute('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'ravi@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That email and password do not match an active account.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/provider'));
    expect(await screen.findByText('Hello, Ravi')).toBeInTheDocument();
  });
});

describe('registration', () => {
  it('requires the organization and its map location for providers, then registers and signs in', async () => {
    let authed = false;
    const { calls } = mockApi({
      'GET /api/users/me': () => (authed ? { data: profile('PROVIDER', 'PENDING') } : { status: 401, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      'POST /api/auth/refresh': () => ({ status: 401, error: { code: 'UNAUTHORIZED', message: 'x' } }),
      'POST /api/auth/register': () => ({ status: 201, data: { user: profile('PROVIDER').user, organization: null } }),
      'POST /api/auth/login': () => {
        authed = true;
        return { data: { user: profile('PROVIDER').user } };
      },
      'GET /api/notifications/unread-count': () => ({ data: { count: 0 } }),
      'GET /api/analytics/dashboard': () => ({ data: providerDashboard }),
    });
    const { router } = renderRoute('/register');
    await userEvent.click(await screen.findByRole('button', { name: /I have surplus food/ }));
    await userEvent.type(screen.getByLabelText(/Your name/), 'Ravi Kumar');
    await userEvent.type(screen.getByLabelText(/Email/), 'ravi@example.com');
    await userEvent.type(screen.getByLabelText(/Phone/), '+91 98450 10000');
    await userEvent.type(screen.getByLabelText(/Password/), 'longenough1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter your organization name')).toBeInTheDocument();
    expect(screen.getByText('Place the pin on your location')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Organization name/), 'Spice Route');
    await userEvent.type(screen.getByLabelText(/Street address/), '12 MG Road');
    await userEvent.click(screen.getByRole('button', { name: 'Set test location' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/provider'));
    expect(calls.find((c) => c.path === '/api/auth/register')?.body).toMatchObject({
      role: 'PROVIDER',
      orgName: 'Spice Route',
      organizationType: 'RESTAURANT',
      latitude: 12.97,
      longitude: 77.59,
    });
  });

  it('volunteers register without an organization section', async () => {
    mockApi(anonymous);
    renderRoute('/register');
    await userEvent.click(await screen.findByRole('button', { name: /I can deliver/ }));
    expect(screen.queryByLabelText(/Organization name/)).not.toBeInTheDocument();
  });
});

describe('provider screens', () => {
  const donation = {
    id: 'don-1',
    providerId: 'u-provider',
    foodName: 'Veg biryani',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 40,
    unit: 'meals',
    availableFrom: new Date(Date.now() - 3600_000).toISOString(),
    availableUntil: new Date(Date.now() + 5 * 3600_000).toISOString(),
    pickupLocation: '12 MG Road',
    pickupLatitude: null,
    pickupLongitude: null,
    storageRequirement: null,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider: { id: 'u-provider', name: 'Ravi', organization: null },
    time_remaining: 1,
  };

  it('dashboard shows the provider KPIs and recent activity', async () => {
    mockApi({ ...signedIn(), 'GET /api/analytics/dashboard': () => ({ data: providerDashboard }) });
    renderRoute('/provider');
    expect(await screen.findByText('62.5%')).toBeInTheDocument();
    expect(screen.getByText('98 meals')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Veg biryani/ })).toHaveAttribute('href', '/provider/donations/don-1');
  });

  it('donation list filters by status tab', async () => {
    mockApi({
      ...signedIn(),
      'GET /api/donations/history': () => ({
        data: {
          ...emptyPage,
          total: 2,
          items: [
            { ...donation, status: 'AVAILABLE', timeline: [] },
            { ...donation, id: 'don-2', foodName: 'Old bread', status: 'COMPLETED', timeline: [] },
          ],
        },
      }),
    });
    renderRoute('/provider/donations');
    expect(await screen.findByText('Veg biryani')).toBeInTheDocument();
    expect(screen.queryByText('Old bread')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Completed/ }));
    expect(await screen.findByText('Old bread')).toBeInTheDocument();
  });

  it('donation form rejects a deadline before the start and sends ISO dates', async () => {
    const { calls } = mockApi({
      ...signedIn(),
      'GET /api/organizations/me': () => ({ data: { organization: { ...profile().organization, latitude: 12.9, longitude: 77.5, contactInformation: null } } }),
      'GET /api/categories': () => ({ data: { categories: [{ id: 'c1', name: 'Prepared meals', slug: 'prepared-meals' }] } }),
      'POST /api/donations': (body) => ({ status: 201, data: { donation: { ...donation, ...(body as object), id: 'don-9', status: 'AVAILABLE' } } }),
      'GET /api/donations/don-9': () => ({ data: { donation: { ...donation, id: 'don-9', status: 'AVAILABLE' } } }),
      'GET /api/matches': () => ({ data: emptyPage }),
    });
    const { router } = renderRoute('/provider/donations/new');
    await userEvent.type(await screen.findByLabelText(/What is it/), 'Veg biryani');
    await userEvent.selectOptions(screen.getByLabelText(/Category/), 'Prepared meals');
    await userEvent.type(screen.getByLabelText(/^Type/), 'Vegetarian');
    await userEvent.type(screen.getByLabelText(/Quantity/), '40');
    const until = screen.getByLabelText(/Pick up by/);
    await userEvent.clear(until);
    await userEvent.type(until, '2020-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'List donation' }));
    expect(await screen.findByText(/must be (after the start|in the future)/)).toBeInTheDocument();

    await userEvent.clear(until);
    await userEvent.type(until, '2099-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'List donation' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/provider/donations/don-9'));
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/api/donations')?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ foodName: 'Veg biryani', category: 'Prepared meals', quantity: 40, unit: 'meals', pickupLocation: '12 MG Road' });
    expect(sent.availableUntil).toBe(new Date('2099-01-01T10:00').toISOString());
    expect(sent).not.toHaveProperty('pickupLatitude');
  });

  it('detail page lets the provider confirm the handover when the volunteer is at pickup', async () => {
    const delivery = {
      id: 'del-1',
      status: 'AT_PICKUP',
      needsReassignment: false,
      assignedAt: new Date().toISOString(),
      pickupTime: null,
      deliveryTime: null,
      declinedAt: null,
      declineReason: null,
      handoverConfirmedAt: null as string | null,
      confirmedAt: null,
      quantityReceived: null,
      receiverName: null,
      proofOfDelivery: null,
      notes: null,
      volunteer: { id: 'v1', name: 'Vikram', phone: '+91 98450 10006' },
      donation: { ...donation, status: 'PICKUP_ASSIGNED', committedQuantity: 40 },
      pickup: { location: '12 MG Road', latitude: 12.9, longitude: 77.5, provider: { name: 'Ravi', phone: '1', organization: 'Spice Route', contact: null } },
      dropoff: { location: 'Shelter', latitude: 12.95, longitude: 77.6, requirementId: 'r1', organization: { id: 'o2', name: 'Hope Shelter', contact: null } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { calls } = mockApi({
      ...signedIn(),
      'GET /api/donations/don-1': () => ({ data: { donation: { ...donation, status: 'PICKUP_ASSIGNED' } } }),
      'GET /api/deliveries': () => ({ data: { ...emptyPage, total: 1, items: [delivery] } }),
      'GET /api/matches': () => ({ data: emptyPage }),
      'POST /api/deliveries/del-1/handover': () => {
        delivery.handoverConfirmedAt = new Date().toISOString();
        delivery.status = 'PICKED_UP';
        return { data: { delivery } };
      },
    });
    renderRoute('/provider/donations/don-1');
    const card = (await screen.findByRole('heading', { name: 'Pickup & delivery' })).closest('section')!;
    expect(await within(card).findByText('Vikram')).toBeInTheDocument();
    expect(within(card).getByText('Hope Shelter')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Confirm handover' }));
    expect(await within(card).findByText(/You confirmed the handover/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/deliveries/del-1/handover')).toBe(true);
    // Editing is locked once a volunteer is assigned.
    expect(screen.queryByRole('link', { name: /Edit/ })).not.toBeInTheDocument();
  });
});
