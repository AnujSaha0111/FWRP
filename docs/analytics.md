# Analytics & Reports (ANALYTICS-01..05)

Role dashboards (PRD §9), impact metrics (§10) and admin reports (§11).
Read-only. Every figure comes from one pure function,
`aggregateDonationMetrics` (`utils/metrics.ts`), so a dashboard, the impact
endpoint and a report over the same donations always agree.

## Metric definitions (PRD §10)

| Metric | Definition |
|---|---|
| Food redistributed | Σ `quantityReceived` of **confirmed** deliveries, per unit. Units are never summed together. |
| Meals redistributed | Food redistributed in meal-like units (meal(s), portion(s), serving(s), plate(s)) |
| Weight redistributed (kg) | Food redistributed in kg/g, converted to kg |
| Valid donations | All except `DRAFT` and `CANCELLED` |
| Fulfillment rate | `COMPLETED / valid × 100` |
| Expiry rate | `EXPIRED / valid × 100` |
| Average matching time | First acceptance (allocation) − donation creation |
| Average pickup time | `pickupTime − assignedAt` |
| Average delivery time | `confirmedAt − pickupTime` (PRD: confirmation − pickup) |
| Average response time (reports) | Same as average matching time |

Rates are percentages with one decimal; times are minutes with one decimal.
With no data they are `null`, never `0` or `NaN`.

Date ranges (`from`, `to`, ISO dates) select donations **created** in
`[from, to)`. At most 20 000 donations are aggregated per request; beyond that
the API answers `413 REPORT_TOO_LARGE` — narrow the range.

## API (`/api/analytics`, authenticated)

### `GET /dashboard` — every role, own scope (`from`/`to` optional)

| Role | Fields |
|---|---|
| PROVIDER | `activeDonations`, `completedDonations`, `expiredDonations`, `successfulRedistributions`, `quantityDonated` (listed, per unit), `quantityRedistributed`, `fulfillmentRate`, `recentActivity` (10 latest donations) |
| RECIPIENT | `openRequirements` (open + partially fulfilled), `fulfilledRequirements`, `availableDonations` (browseable now), `recommendedMatches`, `acceptedDonations` (in flight), `pendingDeliveries`, `awaitingConfirmation`, `history { completedDeliveries, quantityReceived, totalRequirements }` |
| VOLUNTEER | `activeDeliveries`, `completedDeliveries`, `upcomingAvailabilityWindows`, `averagePickupMinutes` |
| ADMIN | `activeDonations`, `completedDonations`, `expiredDonations`, `pendingPickups` (accepted, no volunteer), `activeDeliveries`, `verifiedOrganizations`, `activeVolunteers` (on a delivery or with upcoming availability), `kpis` (as `/impact`) |

The response always carries `role`.

### `GET /impact` — ADMIN

`from`, `to` optional. Returns totals, valid/completed/expired counts,
`mealsRedistributed`, `weightRedistributedKg`, `redistributed` per unit,
`fulfillmentRate`, `expiryRate`, and the three average times.

### `GET /reports` — ADMIN

Filters (all optional, combined with AND): `from`, `to`, `providerId`,
`recipientOrganizationId`, `category` (exact, case-insensitive), `location`
(pickup location contains, case-insensitive), `status`. `format=json`
(default) or `format=csv`.

JSON report: `filters`, `generatedAt`, `summary` (impact KPIs +
`cancelledDonations` + `byStatus`), `averageResponseMinutes`,
`mostActiveDonors` and `mostActiveRecipients` (top 10 by completed, then total
donations), `failedDonations` (cancelled/expired, up to 100).

CSV: downloaded as `fwrp-report-YYYY-MM-DD.csv`, one row per donation:
`donationId, createdAt, provider, foodName, category, quantity, unit, status,
pickupLocation, recipientOrganization, acceptedAt, pickedUpAt, confirmedAt,
quantityReceived`. Cells are RFC 4180-quoted, and text starting with
`= + - @` is prefixed with `'` so spreadsheets do not run it as a formula.
