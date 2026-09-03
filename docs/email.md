# Email Service (BE-NOTIF-03, D-11)

Typed abstraction over email delivery: `emailService.send({ to, subject, html, text, type })`
in `backend/src/services/email.service.ts`. The `type` is one of the 10 PRD §17
notification events, so Phase 13 can pass a notification's type straight through.
No business-event wiring lives here.

## Modes (provider selection)

| Environment | Provider | Credentials needed |
|---|---|---|
| development / test | deterministic in-memory mock (captures, never sends) | none |
| production + SMTP configured | SMTP via nodemailer | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| production + SMTP missing | fail-closed `EMAIL_NOT_CONFIGURED` error (never silently drops into the mock) | — |

The mock is never used in production, even if SMTP variables happen to be set in
development. Tests inject `MockEmailProvider` (with `getCaptured()` / `clear()`)
or stub providers — no SMTP server or network is ever required.

## Production variables (see `backend/.env.example`)

- `SMTP_HOST` — SMTP hostname (empty = unconfigured)
- `SMTP_PORT` — port, defaults to 587 (465 implies TLS)
- `SMTP_USER` / `SMTP_PASS` — SMTP credentials (never logged)
- `EMAIL_FROM` — sender address (defaults to `noreply@fwrp.local`)

## Explicitly out of scope

SMS and push notifications are future enhancements, not MVP (PRD §17, D-11).
Per-event templates and business-event wiring belong to Phase 13, not this service.
