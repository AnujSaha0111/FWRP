import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, ClipboardList, HandHeart, MapPin, Package, Search, Sparkles, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { categoriesApi } from '@/api/endpoints';
import { recipientApi } from '@/api/roles';
import type { Donation, MatchSummary, Requirement } from '@/api/types';
import { useProfile } from '@/auth/AuthProvider';
import { PRIORITY_LABEL } from '@/components/DeliverySummary';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/extras';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/form-controls';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatQuantity, formatRelative } from '@/lib/format';

/** Own organization's requirements that can still take food. */
export function useOpenRequirements() {
  const { user } = useProfile();
  return useQuery({
    queryKey: ['requirements', 'mine'],
    queryFn: () => recipientApi.requirements(),
    select: (page) => page.items.filter((r) => r.organization_id === user.organizationId),
  });
}

export function remaining(r: Requirement): number {
  return Math.max(0, r.quantity_required - r.quantity_fulfilled);
}

function invalidateRecipient(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ['matches', 'browse', 'requirements', 'deliveries', 'dashboard']) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

// ---------------------------------------------------------------- dashboard

export function RecipientDashboard() {
  const { user, organization } = useProfile();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: recipientApi.dashboard });
  const verified = organization?.verificationStatus === 'VERIFIED';

  return (
    <>
      <PageHeader
        title={`Hello, ${user.name.split(' ')[0]}`}
        description={organization?.name}
        action={
          verified && (
            <Button asChild>
              <Link to="/recipient/matches">
                <Sparkles aria-hidden="true" /> View matches
              </Link>
            </Button>
          )
        }
      />
      {dashboard.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : dashboard.isError ? (
        <Alert tone="danger">{errorMessage(dashboard.error)}</Alert>
      ) : (
        <>
          {dashboard.data.awaitingConfirmation > 0 && (
            <Alert tone="warning" className="mb-6" title={`${dashboard.data.awaitingConfirmation} delivery waiting for your confirmation`}>
              <Link to="/recipient/deliveries" className="font-medium underline">
                Confirm what you received
              </Link>{' '}
              so the donation can be completed.
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Matches for you" value={dashboard.data.recommendedMatches} icon={<Sparkles />} hint="Ranked donations nearby" />
            <Stat label="Open requirements" value={dashboard.data.openRequirements} icon={<ClipboardList />} />
            <Stat label="On the way" value={dashboard.data.pendingDeliveries} icon={<Truck />} hint="Accepted, not yet delivered" />
            <Stat label="Available now" value={dashboard.data.availableDonations} icon={<Package />} hint="All open donations" />
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Received so far" description={`${dashboard.data.history.completedDeliveries} completed deliveries`} />
              <CardBody>
                {dashboard.data.history.quantityReceived.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing received yet.</p>
                ) : (
                  <ul className="flex flex-wrap gap-x-6 gap-y-2">
                    {dashboard.data.history.quantityReceived.map((q) => (
                      <li key={q.unit} className="tabular font-mono text-xl font-semibold">
                        {formatQuantity(q.quantity, q.unit)}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Requirements" description={`${dashboard.data.fulfilledRequirements} fulfilled of ${dashboard.data.history.totalRequirements}`} />
              <CardBody className="flex flex-wrap gap-3">
                <Button asChild variant="secondary">
                  <Link to="/recipient/requirements">Manage requirements</Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link to="/recipient/browse">Browse donations</Link>
                </Button>
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- matches

function ScoreBadge({ score }: { score: number }) {
  return (
    <Badge tone={score >= 0.75 ? 'success' : score >= 0.5 ? 'info' : 'neutral'}>
      <span className="tabular">{Math.round(score * 100)}%</span> match
    </Badge>
  );
}

export function MatchesPage() {
  const queryClient = useQueryClient();
  const matches = useQuery({ queryKey: ['matches', 'recommended'], queryFn: () => recipientApi.matches({ status: 'RECOMMENDED' }) });
  const [pending, setPending] = useState<{ match: MatchSummary; action: 'accept' | 'reject' } | null>(null);

  const act = useMutation({
    mutationFn: async ({ match, action }: { match: MatchSummary; action: 'accept' | 'reject' }): Promise<void> => {
      if (action === 'accept') await recipientApi.acceptMatch(match.id);
      else await recipientApi.rejectMatch(match.id);
    },
    onSuccess: (_r, { match, action }) => {
      invalidateRecipient(queryClient);
      setPending(null);
      toast.success(action === 'accept' ? `Accepted "${match.donation.foodName}". A volunteer will be assigned.` : 'Match declined');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader title="Matches" description="Donations ranked for your requirements by distance, fit, quantity, urgency and volunteer availability." />
      {matches.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : matches.isError ? (
        <Alert tone="danger">{errorMessage(matches.error)}</Alert>
      ) : matches.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title="No matches right now"
            action={
              <Button asChild variant="secondary">
                <Link to="/recipient/requirements">Add a requirement</Link>
              </Button>
            }
          >
            Matches appear when a nearby donation fits one of your open requirements. You will get a notification.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {matches.data.items.map((m) => (
            <li key={m.id}>
              <Card className="flex h-full flex-col">
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{m.donation.foodName}</p>
                      <p className="text-sm text-muted-foreground">
                        {m.donation.category} · {m.donation.foodType}
                      </p>
                    </div>
                    <ScoreBadge score={m.matchingScore} />
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Quantity</dt>
                      <dd className="tabular font-medium">{formatQuantity(m.donation.quantity, m.donation.unit)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Distance</dt>
                      <dd className="tabular font-medium">{m.distance.toFixed(1)} km</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Pick up by</dt>
                      <dd className="font-medium">{formatRelative(m.donation.availableUntil)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">For requirement</dt>
                      <dd className="font-medium">
                        {m.requirement.foodCategory} · <span className="tabular">{m.requirement.quantityRequired - m.requirement.quantityFulfilled}</span> needed
                      </dd>
                    </div>
                  </dl>
                  <p className="flex items-start gap-1 text-sm text-muted-foreground">
                    <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {m.donation.pickupLocation}
                  </p>
                </div>
                <div className="flex gap-2 border-t border-border px-5 py-3">
                  <Button className="flex-1" onClick={() => setPending({ match: m, action: 'accept' })}>
                    Accept
                  </Button>
                  <Button variant="secondary" onClick={() => setPending({ match: m, action: 'reject' })}>
                    Decline
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setPending(null)}
          title={pending.action === 'accept' ? `Accept "${pending.match.donation.foodName}"?` : 'Decline this match?'}
          description={
            pending.action === 'accept'
              ? `The food is reserved for your ${pending.match.requirement.foodCategory} requirement and a volunteer is assigned to bring it to you.`
              : 'It will not be suggested to you again.'
          }
          confirmLabel={pending.action === 'accept' ? 'Accept donation' : 'Decline'}
          destructive={pending.action === 'reject'}
          loading={act.isPending}
          onConfirm={() => act.mutate(pending)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- browse

export function BrowsePage() {
  const [category, setCategory] = useState('');
  const [accepting, setAccepting] = useState<Donation | null>(null);
  const categories = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, staleTime: 30 * 60_000 });
  const donations = useQuery({
    queryKey: ['browse', { category }],
    queryFn: () => recipientApi.browseDonations({ category: category || undefined }),
  });

  return (
    <>
      <PageHeader title="Browse donations" description="Every donation open for pickup right now, soonest deadline first." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Category" className="w-full sm:w-64">
          {({ id }) => (
            <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {categories.data?.categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Card>
        {donations.isPending ? (
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : donations.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(donations.error)}</Alert>
          </div>
        ) : donations.data.items.length === 0 ? (
          <EmptyState icon={<Search />} title="No donations open right now">
            New donations appear here as soon as providers list them.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {[...donations.data.items]
              .sort((a, b) => new Date(a.availableUntil).getTime() - new Date(b.availableUntil).getTime())
              .map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="font-medium">{d.foodName}</p>
                    <p className="text-sm text-muted-foreground">
                      <span className="tabular">{formatQuantity(d.quantity, d.unit)}</span> · {d.category} · {d.foodType} · pick up by{' '}
                      {formatDateTime(d.availableUntil)}
                    </p>
                    <p className="mt-0.5 flex items-start gap-1 text-sm text-muted-foreground">
                      <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {d.pickupLocation}
                    </p>
                  </div>
                  <Button variant="secondary" onClick={() => setAccepting(d)}>
                    <HandHeart aria-hidden="true" /> Accept
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </Card>
      {accepting && <AcceptForRequirementDialog donation={accepting} onClose={() => setAccepting(null)} />}
    </>
  );
}

function AcceptForRequirementDialog({ donation, onClose }: { donation: Donation; onClose: () => void }) {
  const queryClient = useQueryClient();
  const requirements = useOpenRequirements();
  const open = useMemo(
    () => (requirements.data ?? []).filter((r) => (r.status === 'OPEN' || r.status === 'PARTIALLY_FULFILLED') && new Date(r.required_by).getTime() > Date.now()),
    [requirements.data]
  );
  // Default to a requirement in the same category, else the first open one.
  const [chosen, setChosen] = useState<string>('');
  const selected = chosen || open.find((r) => r.food_category === donation.category)?.id || open[0]?.id || '';

  const accept = useMutation({
    mutationFn: () => recipientApi.acceptDonation(donation.id, selected),
    onSuccess: () => {
      invalidateRecipient(queryClient);
      toast.success(`Accepted "${donation.foodName}". A volunteer will be assigned.`);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Accept "${donation.foodName}"`}
      description="Choose which of your requirements this donation is for. That decides where it is delivered."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => accept.mutate()} loading={accept.isPending} disabled={!selected}>
            Accept donation
          </Button>
        </>
      }
    >
      {requirements.isPending ? (
        <Skeleton className="h-11" />
      ) : open.length === 0 ? (
        <Alert tone="warning" title="You have no open requirement">
          <Link to="/recipient/requirements" className="font-medium underline">
            Add a requirement
          </Link>{' '}
          first, so the donation knows where to go.
        </Alert>
      ) : (
        <Field label="For requirement">
          {({ id }) => (
            <Select id={id} value={selected} onChange={(e) => setChosen(e.target.value)}>
              {open.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.food_category} · {r.food_type} — {remaining(r)} needed by {formatDateTime(r.required_by)} ({PRIORITY_LABEL[r.priority]})
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <p className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleCheck className="size-4" aria-hidden="true" /> {formatQuantity(donation.quantity, donation.unit)} from {donation.pickupLocation}
      </p>
    </Dialog>
  );
}
