# Matching Engine (MATCH-06..MATCH-10)

Recommends recipient requirements for each donation (and vice versa), ranked by
a deterministic weighted score. PRD §1, §4, §8.

## Pipeline

| Step | Module | Role |
|---|---|---|
| Inputs | `utils/matchingInput.ts` (MATCH-01) | Maps rows → inputs; remaining quantity = quantity − allocations |
| Feasibility | `utils/matchingCompatibility.ts` (MATCH-02) | Status, remaining quantity, expiry, deadline gates |
| Distance | `utils/distance.ts` (MATCH-03/04) | Haversine km |
| Score | `utils/matchingScore.ts` (MATCH-06) | Weighted score in [0, 1] |
| Persist / API | `services/matching.service.ts`, `routes/matches.ts` | Match rows + endpoints |

Configuration: `config/matching.ts`; radius via `MATCHING_MAX_DISTANCE_KM` (default 50),
scheduled refresh via `MATCHING_REFRESH_INTERVAL_MINUTES` (default 15, `0` disables).

## Score

`score = Σ weight × component`, each component in [0, 1]:

| Component | Weight | Rule |
|---|---|---|
| distance | 0.25 | `1 − km / maxDistanceKm`; pairs beyond the radius are **excluded** |
| food | 0.25 | MATCH-D03: same category + type 1, same category 0.5, else 0 (case-insensitive) |
| quantity | 0.15 | MATCH-D02: `min(remaining) / max(remaining)` (see "Remaining quantity") |
| priority | 0.15 | MATCH-D05: LOW 0.25, MEDIUM 0.5, HIGH 0.75, CRITICAL 1 |
| urgency | 0.10 | Earlier of donation expiry / requirement deadline: `1 − min(remaining, 24h) / 24h` |
| transport | 0.10 | LOG-08: 1 if a free volunteer window overlaps `[max(now, availableFrom), min(availableUntil, requiredBy))`, else 0 ([logistics.md](logistics.md)) |

Location (D-07): donation pickup coordinates, falling back to the provider
organization's coordinates; requirement uses its organization's coordinates.
Pairs with no known location are excluded — coordinates are never fabricated.

### Remaining quantity

- Donation: `quantity − Σ allocations`.
- Requirement: `quantityRequired − quantityFulfilled − in-flight`, where
  in-flight is the allocations of donations that are `ACCEPTED`,
  `PICKUP_ASSIGNED`, `PICKED_UP` or `IN_TRANSIT` (reserved, not yet delivered).
  Delivered quantity is already in `quantityFulfilled`; cancelled/expired
  donations release their reservation. A covered requirement stops receiving
  recommendations.


## Lifecycle

- Generation runs automatically (best-effort, never fails the write) after
  donation create/edit/cancel, admin override, requirement create/edit/cancel
  and acceptance, and on demand via the refresh endpoints.
- MATCH-11 scheduled refresh (`jobs/matchingRefresh.ts`, started by the server
  entrypoint): expires `RECOMMENDED` rows whose donation/requirement is no
  longer live, then re-scores every live donation so urgency keeps rising as
  deadlines approach. Runs never overlap.
- Moving an organization (`PUT /api/organizations/me` with `latitude` +
  `longitude`) re-scores its open requirements and its providers' donations
  that use the organization location. Verification needs no trigger: it is
  one-way (`VERIFIED` is terminal; unverified organizations cannot own
  requirements).
- Providers and recipients must give their organization's coordinates at
  registration; there is no default and `0, 0` is rejected.
- New pairs → `RECOMMENDED` (+ one `DONATION_MATCHED` notification per recipient
  user and per provider). Existing `RECOMMENDED`/`EXPIRED` pairs are re-scored.
  `RECOMMENDED` pairs that are no longer feasible → `EXPIRED`.
- `REJECTED` and `ACCEPTED` pairs are never modified by generation.
- Matching never changes `Donation.status` (D-05: `MATCHED` stays optional, so
  donations remain browseable and editable) and never writes allocations.
- Listing `RECOMMENDED` also re-checks that both sides are still live, so stale
  rows are hidden even before the next regeneration.

## API (`/api/matches`, authenticated)

| Method & path | Roles | Description |
|---|---|---|
| `GET /` | ADMIN, PROVIDER, RECIPIENT | Ranked list. Query: `status` (default `RECOMMENDED`), `donationId`, `requirementId`, `page`, `limit`. Scope: ADMIN all, PROVIDER own donations, RECIPIENT own organization's requirements. Order: score desc, then soonest-expiring donation. |
| `GET /:id` | ADMIN, PROVIDER, RECIPIENT | One match (404 when out of scope) |
| `POST /:id/reject` | ADMIN, RECIPIENT (owner) | `RECOMMENDED → REJECTED`, audited as `MATCH_REJECTED` |
| `POST /:id/accept` | RECIPIENT (owner, verified org) | Acceptance — see below |
| `POST /donations/:donationId/refresh` | ADMIN, PROVIDER (owner) | Regenerate for a donation |
| `POST /requirements/:requirementId/refresh` | ADMIN, RECIPIENT (owner) | Regenerate for a requirement |

Refresh response: `{ scope, id, recommended, created, refreshed, expired }`.

## Acceptance (ACCEPT-01)

`POST /api/matches/:id/accept`, or `POST /api/donations/:id/accept` with body
`{ "requirementId": "..." }`. One transaction, under the donation row lock:

1. Re-validate: donation acceptable (`AVAILABLE`/`MATCHED`, not expired);
   requirement owned by the caller's verified organization, open, deadline ahead.
2. Allocate `min(donation remaining, requirement remaining)` (409 if 0).
3. `Donation → ACCEPTED`; the match → `ACCEPTED` (direct acceptance updates the
   pair's match when one exists); the donation's other recommendations → `EXPIRED`.
4. Audit `DONATION_ACCEPTED`; notify the provider (`DONATION_ACCEPTED`).

Then the requirement's recommendations are refreshed so covered demand drops
out. Response: `{ donation, allocation, match }`. `Requirement.quantityFulfilled`
is untouched until delivery confirmation.

`POST /api/donations/:id/accept` without a body keeps its original behaviour
(status change only, no allocation).
