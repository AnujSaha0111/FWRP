# FWRP — Food Waste Redistribution Platform

Connects food providers (restaurants, hotels, caterers) with verified
recipient organizations (shelters, food banks) and volunteer drivers, from
listing surplus food to confirmed delivery. See [PRD.md](PRD.md).

- **backend/** — Node + Express + TypeScript, Prisma, PostgreSQL (Supabase)
- **frontend/** — React + Vite + TypeScript (early stage)
- **docs/** — design and API documentation

## Prerequisites

- Node.js **20.19+, 22.12+ or 24+** (the frontend's Vite 8 requires it)
- A PostgreSQL database (a Supabase project works)

## Backend setup

```powershell
cd backend
npm install
copy .env.example .env      # then fill in DATABASE_URL and DIRECT_URL
npx prisma generate
npm run migrate             # applies all migrations
npm run seed                # demo data (safe to re-run; resets the demo)
npm run dev                 # http://localhost:3001  (health: /api/health)
```

Supabase: use the **session pooler** (port 5432) for both `DATABASE_URL`
(append `?connection_limit=5`) and `DIRECT_URL`. URL-encode special characters
in the password (`@` → `%40`).

Other commands: `npm test` (no database needed), `npm run typecheck`,
`npm run build && npm start`.

## Demo accounts (after `npm run seed`)

All use the password **`Password123!`**.

| Email | Role | Organization |
|---|---|---|
| admin@fwrp.demo | Admin | — |
| provider1@fwrp.demo | Provider | Spice Route Restaurant |
| provider2@fwrp.demo | Provider | Grand Palace Hotel |
| recipient1@fwrp.demo | Recipient | Hope Shelter |
| recipient2@fwrp.demo | Recipient | City Food Bank |
| recipient3@fwrp.demo | Recipient | Little Hands Kitchen (**pending verification** — try verifying it as admin) |
| volunteer1@fwrp.demo | Volunteer | available for the next 3 days |
| volunteer2@fwrp.demo | Volunteer | available for the next 12 hours |

The seed also creates categories, three live donations and three open
requirements in Bengaluru that already have ranked matches, plus one completed
and one expired donation so dashboards and reports show data. Re-running it
signs out earlier demo sessions and resets the demo to a fresh state.

### Try the full flow

1. **recipient1** — `GET /api/matches`, then `POST /api/matches/:id/accept` on the biryani match.
2. **admin** — `GET /api/deliveries/pending`, then `POST /api/deliveries` with the donation and `seed-user-vol1`.
3. **volunteer1** — `POST /api/deliveries/:id/respond` `{ "action": "ACCEPT" }`, then `POST /api/deliveries/:id/status` with `AT_PICKUP`, `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`.
4. **recipient1** — `POST /api/deliveries/:id/confirm`.
5. **admin** — `GET /api/analytics/dashboard`, `GET /api/analytics/reports?format=csv`.

Log in with `POST /api/auth/login` `{ "email", "password" }`; the session is a
cookie, or send `Authorization: Bearer <accessToken>`.

## Frontend

```powershell
cd frontend
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :3001)
```

## Background jobs (start with the backend)

| Job | Default interval | Purpose |
|---|---|---|
| Expiry | 1 min | Expire past-window donations and past-deadline requirements |
| Notifications | 1 min | Expiry warnings, pickup reminders, delay alerts; email outbox |
| Matching refresh | 15 min | Re-score live matches (urgency, transport) |

Set `EXPIRY_JOB_INTERVAL_MINUTES`, `NOTIFICATION_JOB_INTERVAL_MINUTES` or
`MATCHING_REFRESH_INTERVAL_MINUTES` to `0` to disable that job.

## Documentation

| Topic | Doc |
|---|---|
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Database & state machines | [docs/database.md](docs/database.md) |
| Matching & acceptance | [docs/matching.md](docs/matching.md) |
| Pickup & delivery | [docs/logistics.md](docs/logistics.md) |
| Notifications, alerts, expiry | [docs/notifications.md](docs/notifications.md) |
| Dashboards, impact, reports | [docs/analytics.md](docs/analytics.md) |
| Administration | [docs/admin.md](docs/admin.md) |
| Security | [docs/security.md](docs/security.md) |
| Email | [docs/email.md](docs/email.md) |
| **Manual testing guide** (for testers) | [docs/testing-guide.md](docs/testing-guide.md) |
