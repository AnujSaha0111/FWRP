import { useEffect, useState } from 'react';
import { myOrganizationApi } from '../api/client';
import type { Organization } from '../api/types';

// ORG-04: recipient view of their own organization's verification status.
// Backend remains authoritative: this view only renders what GET
// /api/organizations/me returns (no client-side state machine).
export default function MyOrganization() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await myOrganizationApi.get();
        if (!cancelled) setOrg(result.organization);
      } catch (e) {
        if (cancelled) return;
        const status = (e as { status?: number }).status;
        if (status === 404) {
          setMissing(true);
        } else {
          setError(e instanceof Error ? e.message : 'Failed to load organization');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="My organization">
      <h2>My organization</h2>
      {loading ? (
        <p>Loading organization…</p>
      ) : error ? (
        <p role="alert" style={{ color: '#a50e0e' }}>
          {error}
        </p>
      ) : missing || !org ? (
        <p>No organization is associated with your account.</p>
      ) : (
        <div data-testid="my-org-detail">
          <p>
            <strong>{org.name}</strong> ({org.type})
          </p>
          <p>
            Verification status: <span data-testid="my-org-status">{org.verificationStatus}</span>
          </p>
          <p>Address: {org.address}</p>
        </div>
      )}
    </section>
  );
}
