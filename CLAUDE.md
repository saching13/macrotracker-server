# CLAUDE.md

Guidance for working in this repo. The product plan is `plans/plan-11-server.md` in the app repo
(github.com/saching13/MacroTracker); phases S0–S8 with exit criteria. Finish a phase's exit criteria before starting
the next.

## Environment

Docker only — never run `node`/`pnpm` on the host. Use `make` (see the Makefile header). Tool commands run in the
`node` service of the `mt-test` compose project (`docker compose -p mt-test --env-file .env.test run --rm node …`),
which sits on the same network as the test `db` and `auth`.

## Invariants

- **Clients only talk to the API.** GoTrue and Postgres are internal. New auth flows go through `services/gotrue.ts`.
- **Every data query runs inside `withContext(db, rlsFor(auth), …)`.** Row-level security is defense in depth, not the
  only check: still filter by `user_id` in queries. New user-data tables get `enableRLS()` and a policy keyed on
  `currentUserId` (see `db/schema.ts`).
- **Schema changes are migrations.** Edit `db/schema.ts`, then `make gen-migration NAME=…`. Things drizzle-kit can't
  express (FKs into `auth`, triggers, security-definer functions, grants) go in a `CUSTOM=1` migration. Never edit an
  applied migration.
- **Validate at the boundary with zod**; request/response schemas live in `packages/shared` so the web app reuses them.
  Every route declares its response schemas (they are the serializer and the OpenAPI doc). Run `make gen-openapi`
  after route changes; CI fails on a stale `openapi.json`.
- **Errors** are `AppError`s (`errors.ts`) → `{error: {code, message, request_id}}`. Never leak internals.
- **Secrets never reach logs** (pino redacts auth headers and cookies; don't log bodies). Tokens are stored hashed.
- **Personal access tokens can't do account management** (`sessionOnly`). Add a scope only when the endpoints that
  check it ship.
- **Audit** security-relevant actions with `audit()`.
- Free and self-hostable only: no paid services, no SMTP requirement.

## Testing

- `test/unit`: no database; `buildApp` with a fake `Database`.
- `test/int`: real Postgres + GoTrue. Use `helpers.ts` (`createUser`, `session`, `owner` pool for arranging data).
  Every new user-data table gets an RLS isolation test in `rls.test.ts`.
- American English in code, comments and docs.
