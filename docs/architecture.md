# Architecture — FWRP (Iteration 0)

## 3-Layer Architecture (PRD §25)

```
┌──────────────────────────────┐
│        Presentation          │
│  Donor UI │ NGO UI │ Driver  │
│         Admin (future)       │
│      frontend/ (React)       │
└──────────────┬───────────────┘
               │  HTTP /api (CORS)
               ↓
┌──────────────────────────────┐
│       Application / API      │
│  backend/ (Express + TS)     │
│  Routes → Middleware →       │
│  Services → Audit/Notif      │
└──────────────┬───────────────┘
               │  Prisma (Phase 2)
               ↓
┌──────────────────────────────┐
│          Database            │
│   PostgreSQL (Supabase)      │
│   Prisma migrations          │
└──────────────────────────────┘
```

Iteration 0 implements only the skeleton: `GET /api/health` + conventions. No business tables.

## Module Boundaries (future, per PRD §25 & WBS)

- **Auth** — registration, login, JWT, RBAC (`FR-01, FR-02, NFR-03`)
- **Organization** — verification workflow (`FR-03`)
- **Donation** — CRUD, state machine, time windows (`FR-04..06, FR-16`)
- **Requirement** — recipient demand (`FR-07, FR-08`)
- **Matching** — deterministic scoring, Haversine (`FR-09, FR-10`)
- **Logistics** — volunteer, pickup assignment, delivery status (`FR-12..14`)
- **Notification** — in-app + email abstraction (`§17`)
- **Analytics** — KPIs, reports (`§20, §21`)
- **Admin** — verification, monitoring, audit query

Each module will own routes, services, validators, and tests; shared concerns live in `middleware/`, `utils/`, `config/`, and cross-cutting services (`auditService`, `notificationService`, `emailService` at `BE-AUDIT-*` / `BE-NOTIF-*` in Phase 3).

## Tech Stack (ADR 001)

- Frontend: React 19 + Vite 8 + TypeScript 6 + Vitest + Testing Library
- Backend: Node 22 + Express 4 + TypeScript 5 + Vitest + Supertest + Zod + pino + Prisma (Phase 2)
- DB: PostgreSQL via Supabase (Prisma, `DATABASE_URL` supplied when Supabase is configured)
- Auth: JWT (access 15m + refresh 7d) via httpOnly cookies (ADR 002)

## Project Structure

```
/
├── frontend/
│   ├── src/
│   │   ├── App.tsx          # Iteration 0 shell
│   │   ├── main.tsx
│   │   └── test/setup.ts
│   ├── index.html
│   └── vite.config.ts       # + vitest jsdom
├── backend/
│   ├── src/
│   │   ├── app.ts           # createApp()
│   │   ├── index.ts         # listen
│   │   ├── config/env.ts
│   │   ├── middleware/error.ts
│   │   ├── routes/health.ts
│   │   ├── utils/logger.ts
│   │   └── __tests__/health.test.ts
│   ├── package.json
│   └── tsconfig.json
├── docs/
│   ├── adr/001-technology-stack.md
│   ├── adr/002-authentication-strategy.md
│   ├── adr/003-repository-structure.md
│   ├── api.md
│   └── architecture.md
├── scripts/
├── .gitignore
├── PRD.md
└── TASK_CHECKLIST.md
```

## Conventions

- API base `/api`, envelope `{success, data, error}`, status codes per `docs/api.md`
- Error: `AppError` + centralized middleware
- Validation: Zod at controller boundary
- Logging: pino, requestId, JSON in prod / pretty in dev
- Testing: Vitest (backend + frontend), Supertest for HTTP

## Deployment (future, lightweight for academic MVP)

- Backend: Render/Railway/Fly (or VM) `npm run build && npm start`, health probe `/api/health`
- Frontend: Vercel/Netlify `npm run build`, `VITE_API_URL` → backend
- DB: managed Postgres (Neon/Supabase/Railway) with `DATABASE_URL`
- No APM/ELK/queue infra in MVP (Phase 20 notes: lightweight sufficient).

## Decisions

- ADR 001: React+Vite+TS / Node+Express+TS / Postgres+Prisma
- ADR 002: JWT httpOnly cookies
- ADR 003: Monorepo `frontend/`, `backend/`, `docs/`, `scripts/`
