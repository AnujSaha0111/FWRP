# Administration (ADMIN-01..05)

PRD §7.4: manage users, verify organizations, manage reported accounts,
monitor donations and deliveries, resolve disputes, configure system
parameters. Analytics and reports are in [analytics.md](analytics.md);
organization verification predates this module (`/api/admin/organizations`).

All `/api/admin/*` routes require an active ADMIN; the services re-check it.

## Users (ADMIN-01)

| Method & path | Description |
|---|---|
| `GET /api/admin/users` | `role`, `status`, `q` (name/email/organization, case-insensitive), `page`, `limit` |
| `GET /api/admin/users/:id` | Profile, organization, activity counts |
| `PUT /api/admin/users/:id/status` | `{ status: ACTIVE \| SUSPENDED \| DELETED, reason }` |
| `PUT /api/admin/users/:id/password` | Admin password reset (existing) |

- Suspending or deleting ends every session immediately (see
  [security.md](security.md)); reactivating does not. `DELETED` is a soft delete:
  history (donations, deliveries, audit) is kept.
- Admins cannot change their own status. A volunteer on an active delivery
  must be reassigned first (`409 ACTIVE_DELIVERY`). Every change is audited
  with its reason.

## Monitoring (ADMIN-02)

`GET /api/admin/monitoring` — unclaimed donations expiring within the alert
lead time, accepted donations waiting for a volunteer, active deliveries,
delayed or missed deliveries, open incident count and organizations awaiting
verification. Thresholds come from the alert settings below.

## Reported accounts and disputes (ADMIN-03)

Any signed-in user files and follows their own incidents:

| Method & path | Description |
|---|---|
| `POST /api/incidents` | `{ type, subjectUserId?, donationId?, deliveryId?, reason, description }` |
| `GET /api/incidents` | Own incidents (`type`, `status`, paging) |
| `GET /api/incidents/:id` | Own incident (admins: any) |

- `ACCOUNT_REPORT` needs `subjectUserId` (not yourself). `DISPUTE` needs
  `donationId`, and only a party may file one: the donation's provider, a user
  of the receiving organization, or a volunteer who delivered it.
- One open report per reporter and target (`409 DUPLICATE_INCIDENT`).
- Admins are notified (`INCIDENT_UPDATED`) of new incidents.

Admin workflow:

| Method & path | Description |
|---|---|
| `GET /api/admin/incidents` | `type`, `status`, paging |
| `GET /api/admin/incidents/:id` | Detail |
| `PUT /api/admin/incidents/:id` | `{ status: UNDER_REVIEW \| RESOLVED \| DISMISSED, resolution?, suspendSubject? }` |

`OPEN → UNDER_REVIEW → RESOLVED | DISMISSED` (OPEN may close directly; closed
is final). Closing requires a `resolution`. `suspendSubject: true` with
`RESOLVED` suspends the reported account in the same transaction. The reporter
is notified (and emailed) of every update.

## System settings (ADMIN-04)

| Method & path | Description |
|---|---|
| `GET /api/admin/settings` | Every setting: value, default, description, who changed it |
| `PUT /api/admin/settings` | `{ "<key>": value }`; `null` restores the default. All-or-nothing validation; audited |

| Key | Default | Range | Used by |
|---|---|---|---|
| `matching.maxDistanceKm` | `MATCHING_MAX_DISTANCE_KM` (50) | > 0, ≤ 20000 | matching radius |
| `matching.weights` | 0.25 / 0.25 / 0.15 / 0.15 / 0.10 / 0.10 | each 0–1, sum > 0 | score weights (distance, food, quantity, priority, urgency, transport) |
| `matching.urgencyHorizonHours` | 24 | 0–168 | urgency component |
| `alerts.leadMinutes` | 60 | 5–1440 | expiry warnings, pickup reminders, monitoring |
| `alerts.deliveryDelayMinutes` | 120 | 15–2880 | delay alerts, monitoring |

Changes apply within 30 s (cache) — the next matching refresh or alert run.
If settings cannot be read, defaults apply.

## Audit log search (ADMIN-05)

`GET /api/admin/audit-logs` — `entityType`, `entityId`, `actorId`, `action`,
`from`, `to` (`[from, to)`), paging; newest first, with the acting user.
