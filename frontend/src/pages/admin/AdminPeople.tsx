import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '@/api/roles';
import type { AdminUser, Incident, IncidentStatus, IncidentType, Role, UserStatus } from '@/api/types';
import { ROLE_LABEL, useProfile } from '@/auth/AuthProvider';
import { VerificationBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog, Pagination, Table, Tabs, Td, Th } from '@/components/ui/extras';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Alert, Badge, Card, EmptyState, PageHeader, Skeleton, type Tone } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';

// ---------------------------------------------------------------- users

const USER_STATUS: Record<UserStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'warning' },
  DELETED: { label: 'Deleted', tone: 'neutral' },
};

export function UsersPage() {
  const [role, setRole] = useState<Role | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const users = useQuery({
    queryKey: ['admin-users', { role, status, q, page }],
    queryFn: () => adminApi.users({ role: role || undefined, status: status || undefined, q: q || undefined, page }),
  });

  return (
    <>
      <PageHeader title="Users" description="Search accounts, review activity and suspend or reactivate them." />
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem_10rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(search.trim());
          setPage(1);
        }}
      >
        <Field label="Search">
          {({ id }) => <Input id={id} type="search" placeholder="Name, email or organization" value={search} onChange={(e) => setSearch(e.target.value)} />}
        </Field>
        <Field label="Role">
          {({ id }) => (
            <Select
              id={id}
              value={role}
              onChange={(e) => {
                setRole(e.target.value as Role | '');
                setPage(1);
              }}
            >
              <option value="">All roles</option>
              {(['PROVIDER', 'RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <Select
              id={id}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as UserStatus | '');
                setPage(1);
              }}
            >
              <option value="">Any status</option>
              {(['ACTIVE', 'SUSPENDED', 'DELETED'] as const).map((s) => (
                <option key={s} value={s}>
                  {USER_STATUS[s].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          <Search aria-hidden="true" /> Search
        </Button>
      </form>
      <Card>
        {users.isPending ? (
          <div className="p-5">
            <Skeleton className="h-40" />
          </div>
        ) : users.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(users.error)}</Alert>
          </div>
        ) : users.data.items.length === 0 ? (
          <EmptyState icon={<Users />} title="No users match" />
        ) : (
          <Table label="Users">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th>Organization</Th>
                <Th>Status</Th>
                <Th>Joined</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <Td>
                    <span className="block font-medium">{u.name}</span>
                    <span className="text-muted-foreground">{u.email}</span>
                  </Td>
                  <Td>{ROLE_LABEL[u.role]}</Td>
                  <Td>{u.organization ? <span className="flex flex-col items-start gap-1">{u.organization.name}<VerificationBadge status={u.organization.verificationStatus} /></span> : '—'}</Td>
                  <Td>
                    <Badge tone={USER_STATUS[u.status].tone}>{USER_STATUS[u.status].label}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap">{formatDate(u.createdAt)}</Td>
                  <Td>
                    <Button variant="secondary" size="sm" onClick={() => setSelected(u)}>
                      Manage
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {users.data && <Pagination page={users.data} onChange={setPage} />}
      {selected && <UserDialog user={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function UserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const me = useProfile().user;
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['admin-users', 'detail', user.id], queryFn: () => adminApi.user(user.id) });
  const [target, setTarget] = useState<UserStatus | null>(null);
  const current = detail.data?.user ?? user;

  const change = useMutation({
    mutationFn: ({ status, reason }: { status: UserStatus; reason: string }) => adminApi.setUserStatus(user.id, status, reason),
    onSuccess: (_r, { status }) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setTarget(null);
      toast.success(status === 'ACTIVE' ? `${user.name} reactivated` : `${user.name} ${status === 'SUSPENDED' ? 'suspended' : 'deleted'}; signed out everywhere`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const self = user.id === me.id;
  return (
    <>
      <Dialog open={!target} onOpenChange={(o) => !o && onClose()} title={current.name} description={`${current.email} · ${current.phone}`}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Badge>{ROLE_LABEL[current.role]}</Badge>
            <Badge tone={USER_STATUS[current.status].tone}>{USER_STATUS[current.status].label}</Badge>
            {current.organization && <Badge tone="info">{current.organization.name}</Badge>}
          </div>
          {detail.data && (
            <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/60 p-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Donations</dt>
                <dd className="tabular font-medium">{detail.data.activity.donations}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Deliveries</dt>
                <dd className="tabular font-medium">{detail.data.activity.deliveries}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reports filed</dt>
                <dd className="tabular font-medium">{detail.data.activity.incidentsReported}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reports about them</dt>
                <dd className="tabular font-medium">{detail.data.activity.incidentsAbout}</dd>
              </div>
            </dl>
          )}
          <p className="text-sm text-muted-foreground">
            Account ID <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{current.id}</code>
          </p>
          {self ? (
            <p className="text-sm text-muted-foreground">You cannot change your own account status.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {current.status !== 'ACTIVE' && <Button onClick={() => setTarget('ACTIVE')}>Reactivate</Button>}
              {current.status === 'ACTIVE' && (
                <Button variant="secondary" onClick={() => setTarget('SUSPENDED')}>
                  Suspend
                </Button>
              )}
              {current.status !== 'DELETED' && (
                <Button variant="destructive" onClick={() => setTarget('DELETED')}>
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
      </Dialog>
      {target && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setTarget(null)}
          title={target === 'ACTIVE' ? `Reactivate ${user.name}?` : target === 'SUSPENDED' ? `Suspend ${user.name}?` : `Delete ${user.name}?`}
          description={
            target === 'ACTIVE'
              ? 'They can sign in again.'
              : 'They are signed out everywhere immediately. Their history (donations, deliveries) is kept. A volunteer on an active delivery must be reassigned first.'
          }
          confirmLabel={target === 'ACTIVE' ? 'Reactivate' : target === 'SUSPENDED' ? 'Suspend' : 'Delete account'}
          destructive={target !== 'ACTIVE'}
          reasonLabel="Reason (kept in the activity log)"
          loading={change.isPending}
          onConfirm={(reason) => change.mutate({ status: target, reason })}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- incidents

const INCIDENT_STATUS: Record<IncidentStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'info' },
  UNDER_REVIEW: { label: 'Under review', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
};

export function IncidentsPage() {
  const [status, setStatus] = useState<IncidentStatus>('OPEN');
  const [type, setType] = useState<IncidentType | ''>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Incident | null>(null);
  const incidents = useQuery({
    queryKey: ['admin-incidents', { status, type, page }],
    queryFn: () => adminApi.incidents({ status, type: type || undefined, page }),
  });

  return (
    <>
      <PageHeader
        title="Reports & disputes"
        description="Reported accounts and disputes about donations."
        action={
          <Field label="Type" className="w-56">
            {({ id }) => (
              <Select
                id={id}
                value={type}
                onChange={(e) => {
                  setType(e.target.value as IncidentType | '');
                  setPage(1);
                }}
              >
                <option value="">All types</option>
                <option value="DISPUTE">Disputes</option>
                <option value="ACCOUNT_REPORT">Account reports</option>
              </Select>
            )}
          </Field>
        }
      />
      <Tabs
        label="Status"
        value={status}
        onChange={(s) => {
          setStatus(s);
          setPage(1);
        }}
        items={(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'] as const).map((s) => ({ value: s, label: INCIDENT_STATUS[s].label }))}
      />
      <Card role="tabpanel">
        {incidents.isPending ? (
          <div className="p-5">
            <Skeleton className="h-14" />
          </div>
        ) : incidents.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(incidents.error)}</Alert>
          </div>
        ) : incidents.data.items.length === 0 ? (
          <EmptyState icon={<Flag />} title="Nothing here" />
        ) : (
          <ul className="divide-y divide-border">
            {incidents.data.items.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => setSelected(i)} className="flex w-full cursor-pointer flex-col items-start gap-1 px-5 py-4 text-left transition-colors duration-200 hover:bg-muted">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{i.reason}</span>
                    <Badge tone={i.type === 'DISPUTE' ? 'info' : 'warning'}>{i.type === 'DISPUTE' ? 'Dispute' : 'Account report'}</Badge>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    By {i.reporter.name} ({ROLE_LABEL[i.reporter.role]}){i.subjectUser && ` about ${i.subjectUser.name}`} · {formatDateTime(i.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {incidents.data && <Pagination page={incidents.data} onChange={setPage} />}
      {selected && <IncidentDialog incident={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function IncidentDialog({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [resolution, setResolution] = useState('');
  const [suspend, setSuspend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = incident.status === 'RESOLVED' || incident.status === 'DISMISSED';

  const update = useMutation({
    mutationFn: (status: Exclude<IncidentStatus, 'OPEN'>) =>
      adminApi.updateIncident(incident.id, {
        status,
        ...(status !== 'UNDER_REVIEW' ? { resolution: resolution.trim() } : {}),
        ...(status === 'RESOLVED' && suspend ? { suspendSubject: true } : {}),
      }),
    onSuccess: (_r, status) => {
      queryClient.invalidateQueries({ queryKey: ['admin-incidents'] });
      queryClient.invalidateQueries({ queryKey: ['monitoring'] });
      if (suspend) queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast.success(status === 'UNDER_REVIEW' ? 'Marked as under review' : `Report ${status.toLowerCase()}; the reporter was notified`);
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function close(status: 'RESOLVED' | 'DISMISSED') {
    setError(null);
    if (resolution.trim().length < 3) return setError('Write a short resolution note for the reporter.');
    update.mutate(status);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={incident.reason} description={<Badge tone={INCIDENT_STATUS[incident.status].tone}>{INCIDENT_STATUS[incident.status].label}</Badge>}>
      <div className="flex flex-col gap-4">
        <dl className="grid gap-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Reported by</dt>
            <dd>
              {incident.reporter.name} ({ROLE_LABEL[incident.reporter.role]}) · {formatDateTime(incident.createdAt)}
            </dd>
          </div>
          {incident.subjectUser && (
            <div>
              <dt className="text-muted-foreground">About</dt>
              <dd>
                {incident.subjectUser.name} ({ROLE_LABEL[incident.subjectUser.role]}, {USER_STATUS[incident.subjectUser.status].label.toLowerCase()})
              </dd>
            </div>
          )}
          {incident.donationId && (
            <div>
              <dt className="text-muted-foreground">Donation</dt>
              <dd>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{incident.donationId}</code>
              </dd>
            </div>
          )}
        </dl>
        <p className="whitespace-pre-line rounded-lg bg-muted/60 p-4 text-sm">{incident.description}</p>
        {closed ? (
          <p className="text-sm">
            <span className="font-medium">Resolution{incident.resolvedBy && ` by ${incident.resolvedBy.name}`}: </span>
            {incident.resolution}
          </p>
        ) : (
          <>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Resolution note" hint="Sent to the reporter when you resolve or dismiss.">
              {({ id, describedBy }) => <Textarea id={id} rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} aria-describedby={describedBy} />}
            </Field>
            {incident.subjectUser && incident.subjectUser.status === 'ACTIVE' && (
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={suspend} onChange={(e) => setSuspend(e.target.checked)} className="mt-1 size-4 accent-[var(--color-primary)]" />
                <span className="text-sm">Also suspend {incident.subjectUser.name} when resolving</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              {incident.status === 'OPEN' && (
                <Button variant="secondary" onClick={() => update.mutate('UNDER_REVIEW')} loading={update.isPending && update.variables === 'UNDER_REVIEW'}>
                  Start review
                </Button>
              )}
              <Button onClick={() => close('RESOLVED')} loading={update.isPending && update.variables === 'RESOLVED'}>
                Resolve
              </Button>
              <Button variant="secondary" onClick={() => close('DISMISSED')} loading={update.isPending && update.variables === 'DISMISSED'}>
                Dismiss
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
