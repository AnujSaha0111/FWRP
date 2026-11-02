# Pickup & Delivery (LOG-01..LOG-08, DELCONF-01..03)

Volunteer availability, pickup assignment, the volunteer workflow, provider
handover and recipient confirmation. PRD §7.1–7.4, §8, FR-12..FR-15; state
machine per [database.md §11.3](database.md).

## Flow

```text
Recipient accepts (Allocation)        Donation ACCEPTED
Admin assigns volunteer               Delivery ASSIGNED      Donation PICKUP_ASSIGNED
Volunteer accepts                     Delivery ACCEPTED
Volunteer at pickup                   Delivery AT_PICKUP
Provider handover / volunteer pickup  Delivery PICKED_UP     Donation PICKED_UP
Volunteer in transit                  Delivery IN_TRANSIT    Donation IN_TRANSIT
Volunteer delivered (+ proof)         Delivery DELIVERED     Donation DELIVERED
Recipient confirms receipt            Delivery CONFIRMED     Donation COMPLETED, Requirement fulfilled
```

Each step is one transaction: a conditional write on the expected status
(concurrent changes lose with `409`), the mirrored donation status through the
central donation guard, an audit event and notifications.

Declining keeps the delivery `ASSIGNED` with `declinedAt` set
(`needsReassignment: true`) until an admin reassigns it (ASSIGNED → ASSIGNED).
A declined assignment no longer occupies the volunteer or appears in their list.

## Rules

- **Assignment (admin, FR-12):** donation must be `ACCEPTED`, within its pickup
  window, and have an allocation (the destination is the allocated
  requirement's location, else its organization's address). Donations accepted
  without a `requirementId` cannot be assigned (`409 NO_RECIPIENT_ALLOCATION`).
- **Volunteer (BR-05):** active `VOLUNTEER`, no other active non-declined
  delivery (`409 OVERLAPPING_ASSIGNMENT`), and an availability window
  overlapping `[max(now, availableFrom), availableUntil)`
  (`409 VOLUNTEER_UNAVAILABLE`). The volunteer row is locked during the check,
  so two concurrent assignments cannot both succeed.
- **Reassignment:** only before pickup (`ASSIGNED`/`ACCEPTED`).
- **Handover (provider, PRD §7.1):** allowed from `AT_PICKUP` onwards, once. At
  `AT_PICKUP` it performs the pickup (`PICKED_UP`, `pickupTime`); later it only
  records `handoverConfirmedAt`.
- **Proof of delivery:** an optional reference string (photo URL/path, code)
  with `DELIVERED`. There is no file upload in the MVP.
- **Confirmation (recipient of the allocated organization, FR-15):**
  `quantityReceived` defaults to the allocated quantity and cannot exceed the
  donated quantity. If the requirement is still `OPEN`/`PARTIALLY_FULFILLED`,
  `quantityFulfilled += quantityReceived` and its status is derived (REQ-04;
  `OPEN → FULFILLED` passes through `PARTIALLY_FULFILLED`), with a
  RequirementHistory `UPDATE` entry. A cancelled or expired requirement is left
  unchanged; the donation still completes. This is the only code path that
  completes donations or writes `quantityFulfilled`.

## Transport in matching (LOG-08)

The match score gains a `transport` component (weight 0.10): 1 when a free
volunteer's window overlaps `[max(now, availableFrom), min(availableUntil,
requiredBy))`, otherwise 0. Volunteer changes are picked up by the scheduled
refresh (MATCH-11). See [matching.md](matching.md).

## API

`/api/deliveries` (authenticated; reads are role-scoped: ADMIN all, VOLUNTEER
own, PROVIDER own donations, RECIPIENT own organization; out-of-scope ids → 404)

| Method & path | Role | Body | Description |
|---|---|---|---|
| `GET /` | any | — | List. Query: `status`, `active`, `needsReassignment`, `donationId`, `page`, `limit` |
| `GET /pending` | ADMIN | — | `{ awaitingVolunteer, declined }` work queue |
| `POST /` | ADMIN | `{ donationId, volunteerId, notes? }` | Assign (201) |
| `GET /:id` | any (scoped) | — | Detail with pickup/drop-off locations, coordinates and contacts |
| `POST /:id/reassign` | ADMIN | `{ volunteerId, notes? }` | Reassign before pickup |
| `POST /:id/respond` | VOLUNTEER | `{ action: ACCEPT \| DECLINE, reason? }` | Accept or decline |
| `POST /:id/status` | VOLUNTEER | `{ status: AT_PICKUP \| PICKED_UP \| IN_TRANSIT \| DELIVERED, proofOfDelivery?, notes? }` | Progress |
| `POST /:id/handover` | PROVIDER | — | Confirm handover |
| `POST /:id/confirm` | RECIPIENT | `{ quantityReceived?, receiverName?, notes? }` | Confirm receipt |

`/api/volunteers`

| Method & path | Role | Description |
|---|---|---|
| `GET /me/availability` | VOLUNTEER | Upcoming windows |
| `POST /me/availability` | VOLUNTEER | `{ availableFrom, availableUntil }`; max 7 days each, 50 upcoming, no overlaps |
| `DELETE /me/availability/:id` | VOLUNTEER | Remove own window |
| `GET /available?donationId=` | ADMIN | Free volunteers for a donation's pickup window |

## Notifications

| Event | Recipients | Type |
|---|---|---|
| Assigned / reassigned | volunteer; provider + recipient users | `PICKUP_ASSIGNED` |
| Delivered | recipient users | `CONFIRMATION_PENDING` |
| Confirmed | provider, volunteer | `DELIVERY_COMPLETED` |

Declines are not notified (no matching notification type); they appear in
`GET /pending`. Pickup reminders and delay alerts (`PICKUP_REMINDER`,
`DELIVERY_DELAYED`) are part of the notifications/expiry work.
