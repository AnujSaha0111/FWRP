import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminVerification from './AdminVerification';
import type { Organization } from '../api/types';

function org(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org-1',
    name: 'Good Food Org',
    type: 'NGO',
    address: '12 Market Street',
    latitude: 12.5,
    longitude: 77.5,
    contactInformation: null,
    verificationStatus: 'PENDING',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

function pageResponse(items: Organization[]) {
  return { success: true, data: { items, total: items.length, page: 1, limit: 20, totalPages: 1, hasNext: false, hasPrev: false } };
}

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ORG-04 AdminVerification', () => {
  it('lists PENDING organizations by default and supports status filtering', async () => {
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org()])));
    render(<AdminVerification />);
    expect(await screen.findByText('Good Food Org')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/organizations?status=PENDING', expect.objectContaining({ credentials: 'include' }));

    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org({ id: 'org-2', name: 'Verified Org', verificationStatus: 'VERIFIED' })])));
    await user.selectOptions(screen.getByLabelText('Status filter'), 'VERIFIED');
    expect(await screen.findByText('Verified Org')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/organizations?status=VERIFIED', expect.anything());
  });

  it('shows detail with Review for PENDING and Verify/Reject for UNDER_REVIEW', async () => {
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org()])));
    const user = userEvent.setup();
    render(<AdminVerification />);
    await user.click(await screen.findByRole('button', { name: 'Good Food Org' }));
    expect(await screen.findByTestId('org-detail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark under review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org({ verificationStatus: 'UNDER_REVIEW' })])));
    await user.selectOptions(screen.getByLabelText('Status filter'), 'UNDER_REVIEW');
    await user.click(await screen.findByRole('button', { name: 'Good Food Org' }));
    expect(await screen.findByRole('button', { name: 'Verify' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark under review' })).not.toBeInTheDocument();
  });

  it('confirms review, refreshes the list, and shows the new status', async () => {
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org()])));
    const user = userEvent.setup();
    render(<AdminVerification />);
    await user.click(await screen.findByRole('button', { name: 'Good Food Org' }));
    await user.click(await screen.findByRole('button', { name: 'Mark under review' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/confirm review/i)).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(respond({ success: true, data: { organization: org({ verificationStatus: 'UNDER_REVIEW' }) } }));
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org({ verificationStatus: 'UNDER_REVIEW' })])));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/organizations/org-1/review', expect.objectContaining({ method: 'PUT' })));
    const detail = await screen.findByTestId('org-detail');
    expect(within(detail).getByText('UNDER_REVIEW')).toBeInTheDocument();
  });

  it('reject requires a reason and submits it', async () => {
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org({ verificationStatus: 'UNDER_REVIEW' })])));
    const user = userEvent.setup();
    render(<AdminVerification />);
    await user.click(await screen.findByRole('button', { name: 'Good Food Org' }));
    await user.click(await screen.findByRole('button', { name: 'Reject' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Rejection reason'), 'Incomplete documents');
    expect(confirm).not.toBeDisabled();

    fetchMock.mockResolvedValueOnce(respond({ success: true, data: { organization: org({ verificationStatus: 'REJECTED' }) } }));
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org({ verificationStatus: 'REJECTED' })])));
    await user.click(confirm);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/organizations/org-1/verify',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ action: 'REJECT', reason: 'Incomplete documents' }) }),
      ),
    );
    expect(within(screen.getByTestId('org-detail')).getByText('REJECTED')).toBeInTheDocument();
  });

  it('disables actions while a request is in flight and shows backend errors', async () => {
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org()])));
    const user = userEvent.setup();
    render(<AdminVerification />);
    await user.click(await screen.findByRole('button', { name: 'Good Food Org' }));
    await user.click(await screen.findByRole('button', { name: 'Mark under review' }));
    const dialog = await screen.findByRole('dialog');

    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('button', { name: 'Working…' })).toBeDisabled();

    release(respond({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid verification transition' } }, 400));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid verification transition');
  });

  it('shows terminal states with no further actions', async () => {
    fetchMock.mockResolvedValueOnce(respond(pageResponse([org({ verificationStatus: 'VERIFIED' })])));
    const user = userEvent.setup();
    render(<AdminVerification />);
    await user.click(await screen.findByRole('button', { name: 'Good Food Org' }));
    expect(await screen.findByText(/terminal state/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
  });
});
