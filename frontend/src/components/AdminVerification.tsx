import { useCallback, useEffect, useState } from 'react';
import { adminOrganizationsApi } from '../api/client';
import type { Organization, VerificationStatus } from '../api/types';

type StatusFilter = '' | VerificationStatus;
type PendingActionKind = 'REVIEW' | 'VERIFY' | 'REJECT';
type PendingAction = { kind: PendingActionKind; org: Organization } | null;

const panel: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '1rem',
  marginTop: '1rem',
};

function StatusBadge({ status }: { status: VerificationStatus }) {
  const colors: Record<VerificationStatus, string> = {
    PENDING: '#8a6d00',
    UNDER_REVIEW: '#0b5cad',
    VERIFIED: '#137333',
    REJECTED: '#a50e0e',
  };
  return (
    <span style={{ color: colors[status], fontWeight: 600 }} data-testid="status-badge">
      {status}
    </span>
  );
}

export default function AdminVerification() {
  const [filter, setFilter] = useState<StatusFilter>('PENDING');
  const [items, setItems] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async (status: StatusFilter) => {
    try {
      const page = await adminOrganizationsApi.list(status);
      setItems(page.items);
      setSelected((prev) => (prev ? page.items.find((o) => o.id === prev.id) ?? null : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load organizations');
      setItems([]);
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await adminOrganizationsApi.list(filter);
        if (cancelled) return;
        setItems(page.items);
        setSelected((prev) => (prev ? page.items.find((o) => o.id === prev.id) ?? null : null));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load organizations');
        setItems([]);
        setSelected(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, load]);

  function startAction(kind: PendingActionKind, org: Organization) {
    setPendingAction({ kind, org });
    setReason('');
    setError(null);
  }

  async function confirmAction() {
    if (!pendingAction || busy) return;
    if (pendingAction.kind === 'REJECT' && reason.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const { kind, org } = pendingAction;
      const updated =
        kind === 'REVIEW'
          ? await adminOrganizationsApi.review(org.id)
          : await adminOrganizationsApi.verify(org.id, kind, kind === 'REJECT' ? reason.trim() : undefined);
      setPendingAction(null);
      await load(filter);
      setSelected(updated.organization);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Admin verification">
      <h2>Organization verification (admin)</h2>

      <label>
        Status filter:{' '}
        <select
          aria-label="Status filter"
          value={filter}
          onChange={(e) => {
            setLoading(true);
            setError(null);
            setFilter(e.target.value as StatusFilter);
          }}
          disabled={loading || busy}
        >
          <option value="">All</option>
          <option value="PENDING">PENDING</option>
          <option value="UNDER_REVIEW">UNDER_REVIEW</option>
          <option value="VERIFIED">VERIFIED</option>
          <option value="REJECTED">REJECTED</option>
        </select>
      </label>

      {error && (
        <p role="alert" style={{ color: '#a50e0e' }}>
          {error}
        </p>
      )}
      {loading ? (
        <p>Loading organizations…</p>
      ) : items.length === 0 ? (
        <p>No organizations match this filter.</p>
      ) : (
        <ul>
          {items.map((org) => (
            <li key={org.id}>
              <button type="button" onClick={() => setSelected(org)} disabled={busy}>
                {org.name}
              </button>{' '}
              <StatusBadge status={org.verificationStatus} />
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div style={panel} data-testid="org-detail">
          <h3>{selected.name}</h3>
          <p>
            Status: <StatusBadge status={selected.verificationStatus} />
          </p>
          <p>Type: {selected.type}</p>
          <p>Address: {selected.address}</p>
          {selected.contactInformation && <p>Contact: {selected.contactInformation}</p>}

          {selected.verificationStatus === 'PENDING' && (
            <button type="button" onClick={() => startAction('REVIEW', selected)} disabled={busy}>
              Mark under review
            </button>
          )}
          {selected.verificationStatus === 'UNDER_REVIEW' && (
            <>
              <button type="button" onClick={() => startAction('VERIFY', selected)} disabled={busy}>
                Verify
              </button>{' '}
              <button type="button" onClick={() => startAction('REJECT', selected)} disabled={busy}>
                Reject
              </button>
            </>
          )}
          {(selected.verificationStatus === 'VERIFIED' || selected.verificationStatus === 'REJECTED') && (
            <p>No further actions — terminal state.</p>
          )}
        </div>
      )}

      {pendingAction && (
        <div style={panel} role="dialog" aria-label="Confirm action">
          <p>
            Confirm {pendingAction.kind.toLowerCase()} of <strong>{pendingAction.org.name}</strong>?
          </p>
          {pendingAction.kind === 'REJECT' && (
            <label>
              Reason (required):{' '}
              <textarea
                aria-label="Rejection reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
            </label>
          )}
          <div>
            <button
              type="button"
              onClick={() => void confirmAction()}
              disabled={busy || (pendingAction.kind === 'REJECT' && reason.trim() === '')}
            >
              {busy ? 'Working…' : 'Confirm'}
            </button>{' '}
            <button type="button" onClick={() => setPendingAction(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
