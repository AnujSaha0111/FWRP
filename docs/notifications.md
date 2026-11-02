# Notifications (NOTIF-01..06)

In-app notifications for every workflow event, time-based alerts, and email
for the important ones. PRD §8, §12 (push is a future enhancement).

## Events

| Type | When | Recipients | Source |
|---|---|---|---|
| `DONATION_CREATED` | Donation listed | provider | donations.service |
| `DONATION_MATCHED` | New recommendation | recipient users, provider | matching.service |
| `DONATION_ACCEPTED` | Recipient accepts | provider | matching.service |
| `PICKUP_ASSIGNED` | Volunteer assigned / reassigned | volunteer; provider + recipients | delivery.service |
| `CONFIRMATION_PENDING` | Volunteer marks delivered | recipient users | delivery.service |
| `DELIVERY_COMPLETED` | Recipient confirms | provider, volunteer | delivery.service |
| `ORGANIZATION_VERIFIED` / `_REJECTED` | Admin decision | organization users | organizations.service |
| `EXPIRY_WARNING` | Unclaimed donation expires within 1 h | provider | alerts job |
| `EXPIRY_WARNING` | Accepted donation, no volunteer, expires within 1 h | admins | alerts job |
| `EXPIRY_WARNING` | Open requirement deadline within 1 h | recipient users | alerts job |
| `PICKUP_REMINDER` | Not picked up, window closes within 1 h | volunteer | alerts job |
| `DELIVERY_DELAYED` | Pickup window closed before collection | admins | alerts job |
| `DELIVERY_DELAYED` | Picked up > 2 h ago, not delivered | admins, recipient users | alerts job |
| `DONATION_EXPIRED` | Donation's window ended unaccepted | provider | expiry job |
| `INCIDENT_UPDATED` | New incident / admin update | admins / reporter | incidents.service |

Each notification stores its related record (`entityType` + `entityId`:
Donation, Requirement, Match, Delivery, Organization) for deep links. Event
notifications are created inside the business transaction, so a rolled-back
change leaves no notification.

## Background job (`jobs/notifications.ts`)

Runs every `NOTIFICATION_JOB_INTERVAL_MINUTES` (default 1, `0` disables),
started by the server entrypoint:

1. **Alerts** (`notificationAlerts.service.ts`): sends the time-based alerts
   above. Each is sent once per (user, type, entity) — re-runs and multiple
   server instances never duplicate them.
2. **Email outbox** (`notificationDispatch.service.ts`): emails committed
   notifications of these types — `DONATION_ACCEPTED`, `PICKUP_ASSIGNED`,
   `PICKUP_REMINDER`, `DELIVERY_DELAYED`, `EXPIRY_WARNING`, `DONATION_EXPIRED`,
   `CONFIRMATION_PENDING`, `DELIVERY_COMPLETED`, `ORGANIZATION_VERIFIED`,
   `ORGANIZATION_REJECTED`.
   - Only rows from the last 24 h; at most 3 attempts each.
   - Each row is claimed before sending, so two instances never email it twice.
   - Suspended/deleted accounts are never emailed.
   - Development/test use the in-memory mock provider; production uses SMTP
     ([email.md](email.md)).

## API (`/api/notifications`, authenticated, always the caller's own)

| Method & path | Description |
|---|---|
| `GET /` | Newest first. Query: `unread=true`, `page`, `limit` |
| `GET /unread-count` | `{ count }` |
| `GET /:id` | One notification (404 for other users' ids) |
| `POST /:id/read` | Mark read (idempotent) |
| `POST /read-all` | `{ count }` marked |

Notifications cannot be created or deleted over HTTP.

## Expiry job (`jobs/expiry.ts`)

Every `EXPIRY_JOB_INTERVAL_MINUTES` (default 1, `0` disables):

- Donations `AVAILABLE`/`MATCHED` past `availableUntil` → `EXPIRED`; their
  recommendations expire and the provider gets `DONATION_EXPIRED`.
- Requirements `OPEN` past `requiredBy` → `EXPIRED`, with a history entry and
  their recommendations expired.

Only transitions allowed by the state machines are used: accepted donations
that were never collected are not expired (the alert job flags them as missed
pickups; an admin can cancel them), and partially fulfilled requirements keep
their status after the deadline (they no longer match).
