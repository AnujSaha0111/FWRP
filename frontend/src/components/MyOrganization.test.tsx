import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MyOrganization from './MyOrganization';

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const orgBody = {
  success: true,
  data: {
    organization: {
      id: 'org-1',
      name: 'Good Food Org',
      type: 'NGO',
      address: '12 Market Street',
      latitude: 12.5,
      longitude: 77.5,
      contactInformation: null,
      verificationStatus: 'UNDER_REVIEW',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    },
  },
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ORG-04 MyOrganization', () => {
  it('renders the caller organization status from the backend', async () => {
    fetchMock.mockResolvedValueOnce(respond(orgBody));
    render(<MyOrganization />);
    expect(await screen.findByTestId('my-org-detail')).toBeInTheDocument();
    expect(screen.getByTestId('my-org-status')).toHaveTextContent('UNDER_REVIEW');
    expect(screen.getByText('Good Food Org')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/me', expect.objectContaining({ credentials: 'include' }));
  });

  it('shows an empty state when the user has no organization', async () => {
    fetchMock.mockResolvedValueOnce(respond({ success: false, error: { code: 'NOT_FOUND', message: 'Organization not found' } }, 404));
    render(<MyOrganization />);
    expect(await screen.findByText(/no organization is associated/i)).toBeInTheDocument();
  });

  it('shows backend errors without leaking internals', async () => {
    fetchMock.mockResolvedValueOnce(respond({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401));
    render(<MyOrganization />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication required');
  });
});
