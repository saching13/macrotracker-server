# MacroTracker server

An optional, self-hosted server for [MacroTracker](https://github.com/saching13/MacroTracker). The app works fine
without it. Running one adds:

- **Several people on one server** (you, family, friends), each with their own private data.
- **Several devices per person**, with the server as the central copy. Phones stay offline-first: they keep a local
  database and sync when they can reach the server.
- **A web app** for checking in and logging from a browser _(coming in S5)_.
- **An MCP endpoint** so AI agents can log food and read your status _(S6)_.
- **A shared recipe library** across the people on the server _(S7)_.

Status: **S0 (scaffold) and S1 (accounts) are done.** Sync, the web app, MCP and sharing follow. The plan is
[`plans/plan-11-server.md`](https://github.com/saching13/MacroTracker/blob/main/plans/plan-11-server.md) in the app
repo.

## Architecture

```
 phone app ─┐                 ┌──────────────────────────── docker compose ─┐
 web app  ──┼── HTTPS ──►  api (Fastify, TypeScript)  ──►  db (Postgres 17)  │
 agents   ──┘   /v1, /mcp     │  REST + OpenAPI          │   app schema: RLS │
                              │  auth proxy              ▼                   │
                              └───────────────────►  auth (Supabase GoTrue)  │
                                                     internal only           │
                              └──────────────────────────────────────────────┘
```

- **One public surface.** Clients only ever talk to the API. GoTrue (Supabase Auth) and Postgres stay on the internal
  Docker network.
- **GoTrue handles credentials**: password hashing, sessions, rotating refresh tokens with reuse detection, invite and
  reset links. It signs access tokens with an ES256 key; the API verifies them locally against GoTrue's JWKS.
- **The API owns everything else**: devices, personal access tokens, roles, the audit log, and (later) sync, the web
  app and MCP.
- **Row-level security is a second lock.** The API connects as `mt_api`, a role that owns nothing, and every request
  runs in a transaction that sets `app.user_id`. A query that forgot its `WHERE user_id = …` still can't see someone
  else's rows. Migrations run as a separate owner role.

| Path                  | What                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `apps/api`            | Fastify API, migrations (`drizzle/`), admin CLI, invite/reset pages |
| `packages/shared`     | Zod schemas shared by the API and (later) the web app               |
| `docker/db/roles.sql` | First-boot database roles and grants                                |
| `compose.yaml`        | `db`, `auth`, `api` (+ a `node` toolbox for dev and tests)          |
| `openapi.json`        | Generated API description; CI fails if it is stale                  |

## Run it

Needs Docker. Node is not needed on the host.

```bash
make env                                   # writes .env with fresh random secrets (keep it safe)
make up                                    # builds and starts db + auth + api on 127.0.0.1:8080
make admin EMAIL=you@example.com NAME=You  # prints an invite link that sets your password
```

Open the link, pick a password, and you are the server's first admin. Invite others from the web app (S5) or the API:

```bash
curl -X POST localhost:8080/v1/admin/invites -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"email":"partner@example.com"}'
```

No email is ever sent: invite and reset links are returned to the admin to pass on (no SMTP needed). Links last 24
hours; `POST /v1/admin/users/{id}/reset-link` makes a fresh one.

### Reaching it from your phone

The default binds to `127.0.0.1`. For a tailnet, put it behind `tailscale serve`:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

and set `PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and `TRUST_PROXY=true` in `.env`, then `make up` again.
Public exposure (Cloudflare Tunnel, MCP OAuth) is a later phase.

### Configuration

All settings come from the environment (`.env`); the API refuses to start if any are invalid. See
[`.env.example`](.env.example) for the list. The ones you may change:

| Variable               | Meaning                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `PUBLIC_URL`           | The address people open the server at. Invite/reset links and cookie security use it.      |
| `WEB_ORIGINS`          | Comma-separated browser origins allowed to call the API with credentials.                  |
| `TRUST_PROXY`          | `true` (or proxy CIDRs) when behind tailscale serve / a tunnel.                            |
| `API_BIND`, `API_PORT` | Where the API is published on the host (default `127.0.0.1:8080`).                         |
| `LOG_LEVEL`            | `info` by default. Logs are JSON, carry `request_id`, and never include tokens or cookies. |

## API

- OpenAPI 3.1: `GET /v1/openapi.json` (also committed as [`openapi.json`](openapi.json)).
- `GET /healthz` (liveness), `GET /readyz` (database and auth reachable), `GET /v1/meta` (server identity and API
  version; the app checks it when you enter a server URL).
- Errors are always `{"error": {"code", "message", "request_id", "details?"}}`. Send `X-Request-ID` to correlate
  client and server logs; the server echoes it back.

### Signing in

| Client           | How                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App**          | `POST /v1/auth/login` with `client: "app"` returns an access token (15 min) and a refresh token. Refresh with `POST /v1/auth/refresh {refresh_token}`.                                                                 |
| **Browser**      | `client: "web"` puts the refresh token in an httpOnly, SameSite=Strict cookie scoped to `/v1/auth`. Refresh sends `x-csrf-token` equal to the `mt_csrf` cookie.                                                        |
| **Agents / MCP** | A personal access token (`mt_pat_…`) from `POST /v1/tokens`, with scopes `mcp:read`, `mcp:write`, `mcp:destroy`. Shown once, stored as a SHA-256 hash, revocable. Tokens can't manage the account or mint more tokens. |

Every login is a **device** (`GET /v1/devices`). Signing a device out (`DELETE /v1/devices/{id}`) stops its access
token immediately and refuses its refresh token. A password change or reset signs out every other device.

Accounts are **invite-only**, with two roles (`admin`, `member`). The server always keeps at least one admin. Deleting
an account removes all of its data. Security events (logins, failures, tokens, admin actions) go to an audit log
(`GET /v1/admin/audit`).

## Develop

```bash
make test          # unit tests + integration tests against throwaway Postgres + GoTrue containers
make lint          # eslint + prettier
make typecheck
make shell         # a Node 22 container with the repo mounted, on the test network
make gen-migration NAME=add_thing             # after editing apps/api/src/db/schema.ts
make gen-migration NAME=add_function CUSTOM=1 # hand-written SQL (functions, triggers, grants)
make gen-openapi   # after changing routes
make test-reset    # drop the test database (needed after editing docker/db/roles.sql)
```

`.env.test` holds **test-only** secrets and is committed on purpose so CI and local tests share one setup. Never use
it for a real server.

Dependencies are installed with a 7-day minimum release age (`pnpm-workspace.yaml`) as supply-chain hygiene.

## Backups

The data lives in the `db-data` volume. Until scheduled backups land, take one with:

```bash
docker compose exec db pg_dump -U postgres -Fc postgres > macrotracker-$(date +%F).dump
```

## License

[MIT](LICENSE)
