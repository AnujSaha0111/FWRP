# FWRP frontend

React 19 + Vite 8 + TypeScript. Talks to the backend through `/api`, which the
dev server proxies to `http://localhost:3001` (override with `VITE_API_URL`).

```powershell
npm install
npm run dev        # http://localhost:5173 — start the backend first
npm test           # Vitest + Testing Library (no backend needed)
npm run typecheck
npm run lint
npm run build
```

Requires Node 20.19+, 22.12+ or 24+.

## Stack

| Concern | Library |
|---|---|
| Routing (code-split screens) | React Router |
| Server data and caching | TanStack Query |
| Forms and validation | React Hook Form + Zod |
| Styling | Tailwind CSS 4 with shadcn/ui-style components (Radix primitives) |
| Maps | Leaflet + OpenStreetMap (no API key) |
| Icons / toasts | lucide-react / sonner |

## Structure

```
src/
  api/          endpoint functions (endpoints.ts) and response types
  auth/         session provider (current user) and route guards
  components/
    ui/         buttons, form controls, cards, badges, dialogs, menus
    layout/     app shell: sidebar, top bar, notification bell, user menu
    map/        location picker, pickup → drop-off route map
    DeliverySummary.tsx  route, contacts and timeline shared by delivery screens
    status.tsx  status badges and status rules shared by screens
  lib/          API client, formatting, form helpers
  pages/        auth/, shared/, provider/, recipient/, volunteer/, admin/
  router.tsx    all routes
```

## Screens

| Role | Screens |
|---|---|
| Everyone | Sign in, register (map pin for organizations), forgot/reset password, notifications, profile and organization, report a problem |
| Provider | Dashboard, my donations, create/edit donation, donation page (matches, volunteer, confirm handover, cancel) |
| Recipient | Dashboard, ranked matches (accept/decline), browse donations (accept for a requirement), requirements, deliveries with receipt confirmation |
| Volunteer | Dashboard, assignments (accept/decline), delivery with route map and one-tap next step, availability windows |
| Admin | Overview and impact, pickup queue (assign/reassign), monitoring, organization verification, users, reports & disputes, analytics with CSV export, settings, activity log |

## Design

Minimal "Swiss" style with a fresh-green and food-amber palette. Tokens live in
`src/index.css` (`@theme`); components use semantic names (`bg-primary`,
`text-muted-foreground`), never raw colors. Text contrast meets WCAG AA,
focus is always visible, touch targets are at least 44 px, and motion is
reduced when the system asks for it.

## Sessions

The session is an httpOnly cookie set by the backend, so the app never
handles tokens. The API client renews an expired access token automatically
and returns to sign-in when the session has ended (signed out elsewhere,
password changed, or account suspended).
