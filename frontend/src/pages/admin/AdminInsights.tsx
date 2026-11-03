import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSearch, RotateCcw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { categoriesApi } from '@/api/endpoints';
import { adminApi } from '@/api/roles';
import type { DonationStatus, ReportParty, SettingView } from '@/api/types';
import { DONATION_STATUS, DonationStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Pagination, Table, Td, Th } from '@/components/ui/extras';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { KpiGrid } from './AdminOverview';

// ---------------------------------------------------------------- reports

interface Filters {
  from: string;
  to: string;
  category: string;
  location: string;
  status: DonationStatus | '';
}

const EMPTY: Filters = { from: '', to: '', category: '', location: '', status: '' };

function toQuery(f: Filters) {
  return {
    from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
    // Inclusive end date: the API range is [from, to).
    to: f.to ? new Date(new Date(`${f.to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
    category: f.category || undefined,
    location: f.location || undefined,
    status: f.status || undefined,
  };
}

function Parties({ title, rows }: { title: string; rows: ReportParty[] }) {
  return (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No data for these filters.</p>
      ) : (
        <ol className="divide-y divide-border">
          {rows.map((p, i) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <span className="flex min-w-0 items-center gap-3">
                <span className="tabular w-5 text-sm text-muted-foreground">{i + 1}</span>
                <span className="truncate font-medium">{p.name}</span>
              </span>
              <span className="tabular text-right text-sm text-muted-foreground">
                {p.completed} completed / {p.donations}
                {p.redistributed[0] && <span className="block">{formatQuantity(p.redistributed[0].quantity, p.redistributed[0].unit)}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function ReportsAdminPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [downloading, setDownloading] = useState(false);
  const categories = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, staleTime: 30 * 60_000 });
  const report = useQuery({ queryKey: ['report', applied], queryFn: () => adminApi.report(toQuery(applied)) });

  function apply(e: FormEvent) {
    e.preventDefault();
    if (draft.from && draft.to && draft.to < draft.from) return toast.error('The end date must be on or after the start date');
    setApplied(draft);
  }

  async function download() {
    setDownloading(true);
    try {
      const blob = await adminApi.reportCsv(toQuery(applied));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fwrp-report-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setDraft((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <PageHeader
        title="Reports"
        description="Filter donations and export them. Dates refer to when a donation was listed."
        action={
          <Button variant="secondary" onClick={download} loading={downloading}>
            {!downloading && <Download aria-hidden="true" />} Download CSV
          </Button>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <form onSubmit={apply} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
            <Field label="From">{({ id }) => <Input id={id} type="date" value={draft.from} onChange={set('from')} />}</Field>
            <Field label="To">{({ id }) => <Input id={id} type="date" value={draft.to} onChange={set('to')} />}</Field>
            <Field label="Category">
              {({ id }) => (
                <Select id={id} value={draft.category} onChange={set('category')}>
                  <option value="">All</option>
                  {categories.data?.categories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {({ id }) => (
                <Select id={id} value={draft.status} onChange={set('status')}>
                  <option value="">All</option>
                  {(Object.keys(DONATION_STATUS) as DonationStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {DONATION_STATUS[s].label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Location contains">{({ id }) => <Input id={id} value={draft.location} onChange={set('location')} placeholder="e.g. Jayanagar" />}</Field>
            <div className="flex gap-2">
              <Button type="submit">Apply</Button>
              <Button
                type="button"
                variant="ghost"
                aria-label="Clear filters"
                onClick={() => {
                  setDraft(EMPTY);
                  setApplied(EMPTY);
                }}
              >
                <RotateCcw aria-hidden="true" />
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {report.isPending ? (
        <Skeleton className="h-96" />
      ) : report.isError ? (
        <Alert tone="danger">{errorMessage(report.error)}</Alert>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>
              <strong className="tabular text-foreground">{report.data.summary.totalDonations}</strong> donations
            </span>
            <span>
              <strong className="tabular text-foreground">{report.data.summary.completedDonations}</strong> completed
            </span>
            <span>
              <strong className="tabular text-foreground">{report.data.summary.expiredDonations}</strong> expired
            </span>
            <span>
              <strong className="tabular text-foreground">{report.data.summary.cancelledDonations}</strong> cancelled
            </span>
          </div>
          <KpiGrid kpis={report.data.summary} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Parties title="Most active donors" rows={report.data.mostActiveDonors} />
            <Parties title="Most active recipients" rows={report.data.mostActiveRecipients} />
          </div>
          <Card>
            <CardHeader title="Failed and cancelled donations" />
            {report.data.failedDonations.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">None for these filters.</p>
            ) : (
              <Table label="Failed and cancelled donations">
                <thead>
                  <tr>
                    <Th>Food</Th>
                    <Th>Provider</Th>
                    <Th>Status</Th>
                    <Th>Listed</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.failedDonations.map((f) => (
                    <tr key={f.donationId}>
                      <Td className="font-medium">{f.foodName}</Td>
                      <Td>{f.provider}</Td>
                      <Td>
                        <DonationStatusBadge status={f.status} />
                      </Td>
                      <Td>{formatDate(f.createdAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- settings

const WEIGHT_LABELS: Record<string, string> = {
  distance: 'Distance',
  food: 'Food fit',
  quantity: 'Quantity fit',
  priority: 'Requirement priority',
  urgency: 'Urgency',
  transport: 'Volunteer availability',
};

const SETTING_META: Record<string, { label: string; unit?: string; step?: number }> = {
  'matching.maxDistanceKm': { label: 'Matching radius', unit: 'km', step: 1 },
  'matching.urgencyHorizonHours': { label: 'Urgency horizon', unit: 'hours', step: 1 },
  'alerts.leadMinutes': { label: 'Expiry and pickup alerts', unit: 'minutes before the deadline', step: 5 },
  'alerts.deliveryDelayMinutes': { label: 'Delivery delay alert', unit: 'minutes after pickup', step: 5 },
  'matching.weights': { label: 'Match score weights' },
};

export function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: adminApi.settings });
  return (
    <>
      <PageHeader title="System settings" description="Tune matching and alerts. Changes apply within 30 seconds, from the next matching refresh or alert run." />
      {settings.isPending ? (
        <Skeleton className="h-96" />
      ) : settings.isError ? (
        <Alert tone="danger">{errorMessage(settings.error)}</Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {settings.data.settings.map((s) => (
            // Re-mount when the stored value changes (e.g. reset to default) so the inputs show it.
            <SettingCard key={`${s.key}:${JSON.stringify(s.value)}`} setting={s} />
          ))}
        </div>
      )}
    </>
  );
}

function SettingCard({ setting }: { setting: SettingView }) {
  const queryClient = useQueryClient();
  const meta = SETTING_META[setting.key] ?? { label: setting.key };
  const isWeights = setting.key === 'matching.weights';
  const [value, setValue] = useState<string>(isWeights ? '' : String(setting.value));
  const [weights, setWeights] = useState<Record<string, string>>(
    isWeights ? Object.fromEntries(Object.entries(setting.value as Record<string, number>).map(([k, v]) => [k, String(v)])) : {}
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: unknown) => adminApi.updateSettings({ [setting.key]: next }),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      setError(null);
      toast.success(`${meta.label} saved`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (isWeights) {
      const parsed = Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number(v)]));
      if (Object.values(parsed).some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return setError('Each weight must be between 0 and 1.');
      if (Object.values(parsed).reduce((a, b) => a + b, 0) <= 0) return setError('At least one weight must be above 0.');
      save.mutate(parsed);
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return setError('Enter a positive number.');
      save.mutate(n);
    }
  }

  const total = isWeights ? Object.values(weights).reduce((a, v) => a + (Number(v) || 0), 0) : 0;
  return (
    <Card>
      <CardHeader
        title={meta.label}
        description={setting.description}
        action={
          setting.overridden && (
            <Button variant="ghost" size="sm" onClick={() => save.mutate(null)} disabled={save.isPending}>
              <RotateCcw aria-hidden="true" /> Default
            </Button>
          )
        }
      />
      <CardBody>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          {isWeights ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                {Object.keys(weights).map((k) => (
                  <Field key={k} label={WEIGHT_LABELS[k] ?? k}>
                    {({ id }) => <Input id={id} type="number" min={0} max={1} step={0.05} inputMode="decimal" value={weights[k]} onChange={(e) => setWeights((w) => ({ ...w, [k]: e.target.value }))} />}
                  </Field>
                ))}
              </div>
              <p className="tabular text-sm text-muted-foreground">Total {total.toFixed(2)} — weights are scaled to add up to 1.</p>
            </>
          ) : (
            <Field label={meta.unit ? `Value (${meta.unit})` : 'Value'} hint={`Default: ${String(setting.default)}`}>
              {({ id, describedBy }) => <Input id={id} type="number" step={meta.step ?? 1} min={0} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-describedby={describedBy} />}
            </Field>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="submit" loading={save.isPending}>
              Save
            </Button>
            {setting.updatedAt && (
              <span className="text-sm text-muted-foreground">
                Changed {formatDateTime(setting.updatedAt)}
                {setting.updatedBy && ` by ${setting.updatedBy.name}`}
              </span>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- audit log

function parseValue(v: string | null): string {
  if (!v) return '—';
  try {
    const parsed = JSON.parse(v) as unknown;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([k, val]) => `${k}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`)
        .join(', ');
    }
    return String(parsed);
  } catch {
    return v;
  }
}

export function AuditLogPage() {
  const [draft, setDraft] = useState({ entityType: '', entityId: '', action: '' });
  const [applied, setApplied] = useState(draft);
  const [page, setPage] = useState(1);
  const logs = useQuery({
    queryKey: ['audit', applied, page],
    queryFn: () =>
      adminApi.auditLogs({
        entityType: applied.entityType || undefined,
        entityId: applied.entityId.trim() || undefined,
        action: applied.action.trim().toUpperCase() || undefined,
        page,
      }),
  });

  return (
    <>
      <PageHeader title="Activity log" description="Every important change on the platform, newest first." />
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[12rem_1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
          setPage(1);
        }}
      >
        <Field label="Record type">
          {({ id }) => (
            <Select id={id} value={draft.entityType} onChange={(e) => setDraft((d) => ({ ...d, entityType: e.target.value }))}>
              <option value="">All</option>
              {['Donation', 'Requirement', 'Delivery', 'Match', 'Organization', 'User', 'Incident', 'SystemSetting', 'VolunteerAvailability'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Record ID">{({ id }) => <Input id={id} value={draft.entityId} onChange={(e) => setDraft((d) => ({ ...d, entityId: e.target.value }))} />}</Field>
        <Field label="Action">{({ id }) => <Input id={id} placeholder="e.g. DONATION_ACCEPTED" value={draft.action} onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))} />}</Field>
        <Button type="submit" variant="secondary">
          <FileSearch aria-hidden="true" /> Search
        </Button>
      </form>
      <Card>
        {logs.isPending ? (
          <div className="p-5">
            <Skeleton className="h-40" />
          </div>
        ) : logs.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(logs.error)}</Alert>
          </div>
        ) : logs.data.items.length === 0 ? (
          <EmptyState icon={<FileSearch />} title="No matching activity" />
        ) : (
          <Table label="Activity log">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Record</Th>
                <Th>Change</Th>
              </tr>
            </thead>
            <tbody>
              {logs.data.items.map((l) => (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(l.timestamp)}</Td>
                  <Td>{l.user ? l.user.name : <span className="text-muted-foreground">System</span>}</Td>
                  <Td>
                    <code className="font-mono text-xs">{l.action}</code>
                  </Td>
                  <Td>
                    {l.entityType}
                    <code className="block max-w-40 truncate font-mono text-xs text-muted-foreground" title={l.entityId}>
                      {l.entityId}
                    </code>
                  </Td>
                  <Td className="max-w-md text-xs text-muted-foreground">
                    {l.oldValue && <span className="block">From {parseValue(l.oldValue)}</span>}
                    {l.newValue && <span className="block text-foreground">To {parseValue(l.newValue)}</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {logs.data && <Pagination page={logs.data} onChange={setPage} />}
    </>
  );
}
