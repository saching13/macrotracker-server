# MacroTracker server

An optional, self-hosted server for [MacroTracker](https://github.com/saching13/MacroTracker). The app works fine
without it. Running one adds:

- **Several people on one server** (you, family, friends), each with their own private data.
- **Several devices per person**, with the server as the central copy. Phones stay offline-first: they keep a local
  database and sync when they can reach the server.
- **A web app** for checking in and logging from a browser _(coming in S5)_.
- **An MCP endpoint** so AI agents can log food and read your status _(S6)_.
- **A shared recipe library** across the people on the server _(S7)_.

Status: **S0 (scaffold), S1 (accounts) and S2 (sync server) are done.** The app's sync client, the web app, MCP and
sharing follow. The plan is
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

| Path                  | What                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `apps/api`            | Fastify API, migrations (`drizzle/`), admin CLI, invite/reset pages   |
| `apps/web`            | React web app (Vite, TanStack Router/Query); the API serves its build |
| `packages/shared`     | Zod schemas, units and the TDEE engine port, shared with the web app  |
| `fixtures/engine`     | Golden vectors from the app's Dart engine (see below)                 |
| `docker/db/roles.sql` | First-boot database roles and grants                                  |
| `compose.yaml`        | `db`, `auth`, `api` (+ a `node` toolbox for dev and tests)            |
| `openapi.json`        | Generated API description; CI fails if it is stale                    |

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

### Sync

The app keeps its own database and syncs row by row (`/v1/sync/*`, signed-in devices only):

- **Push** sends local changes (`insert` / `update` / `delete`, each with a client-made `change_id`). Every change gets
  its own result: `applied`, `stale` (the server has something newer; the reply carries it) or `rejected` (invalid).
  Retrying a change is harmless.
- **Pull** returns the current state of every row changed after a cursor (`since`), oldest first, in pages. Each
  account has one counter (`rev`) across all its tables.
- **Conflicts** go to the most recent edit, timed by the server's clock: replies carry `server_now`, and a push's stamps
  are shifted by the gap between the phone's clock and the server's, so a phone with a wrong clock doesn't win (or
  lose) every conflict.
- **Deletes** leave a tombstone. A later edit from another phone doesn't bring the row back; only re-creating it (undo)
  does. Nothing is ever deleted because a list was shorter.
- **Bootstrap** uploads an app's existing data when it first connects: rows the server lacks are added, and the server
  keeps its version of the rest.
- What syncs: profile, weights, body measurements, your own foods (not the built-in USDA/INDB ones), servings, recipes,
  diary, goals, programs, targets and a few per-person settings. Progress photos and device settings stay on the phone.

### Data

For the web app and agents (`/v1/*`; personal access tokens need `mcp:read` / `mcp:write` / `mcp:destroy`):

| Endpoint                                               | What                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /v1/status?today=`                                | Trend weight, expenditure, today's totals and targets, the week, check-in |
| `GET /v1/day?date=`                                    | A day's entries, totals and targets                                       |
| `POST /v1/entries`, `PATCH`/`DELETE /v1/entries/{id}`  | Log a food (by id and amount), a recipe, or quick-add macros              |
| `GET /v1/foods/search?q=`, `/v1/foods/recent`, `/{id}` | Your foods, then the USDA reference foods                                 |
| `POST /v1/foods`                                       | Create a food (with servings)                                             |
| `GET`/`POST /v1/weights`, `DELETE /v1/weights/{id}`    | Weigh-ins (kg)                                                            |
| `GET`/`PATCH /v1/profile`                              | Profile; units                                                            |
| `GET`/`POST /v1/check-in?today=`                       | Preview or accept the weekly check-in                                     |
| `GET /v1/recipes`                                      | Your recipes                                                              |

- The server doesn't know your timezone, so calls pass the local date (`today`, `date`).
- Writes go through the same path as a phone's push: they get a `rev` and reach the phones on their next sync.
- An entry's macros are **snapshotted when it is logged** (or its amount changes), from the food as it is then. Later
  edits to the food never change past days.
- `status` and check-ins run the [engine](#engine) over the synced history, so they match the app.
- The **USDA reference foods** (SR Legacy, 7,793 foods per 100 g) ship in `apps/api/data` and load on first boot. They
  have the same ids as the app's copy, so a food logged on the web is the one the phone already has.

### MCP (AI agents)

`POST /mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server (Streamable HTTP, stateless), so an
AI agent can read your diary and log for you. Make a token in the web app (Settings › Access tokens) and add the server
to your agent, for example Claude Code:

```bash
claude mcp add --transport http macrotracker https://your-server/mcp --header "Authorization: Bearer mt_pat_…"
```

| Tools                                                                                                                 | Needs                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `get_status`, `get_day`, `daily_totals`, `list_diary`, `search_foods`, `recent_foods`, `list_recipes`, `list_weights` | `mcp:read`                                            |
| `log_food`, `log_recipe`, `quick_add`, `create_food`, `log_weight`, `log_body_metric`, `update_entry`, `check_in`     | `mcp:write`, `MCP_WRITE_ENABLED`                      |
| `delete_entry`, `delete_weight`                                                                                       | `mcp:destroy`, `MCP_DESTROY_ENABLED` (off by default) |

- An agent only sees the tools its token and the server allow. Changes and deletes need `confirm: true`, so the agent
  asks first.
- Tools take a local date; without one, "today" is in `DEFAULT_TIMEZONE`.
- Everything goes through the same data layer as the web app: macros are snapshotted, writes get a rev, and the phones
  see them on their next sync.

## Develop

```bash
make test          # unit tests + integration tests against throwaway Postgres + GoTrue containers
make lint          # eslint + prettier
make typecheck
make shell         # a Node 26 container with the repo mounted, on the test network
make gen-migration NAME=add_thing             # after editing apps/api/src/db/schema.ts
make gen-migration NAME=add_function CUSTOM=1 # hand-written SQL (functions, triggers, grants)
make gen-openapi   # after changing routes (also regenerates the web app's typed client)
make web-dev       # the web app with hot reload on http://localhost:5173, against `make up`
make e2e           # Playwright against a throwaway stack (SCREENSHOTS=1 also saves a visual tour)
make test-reset    # drop the test database (needed after editing docker/db/roles.sql)
```

### Engine

`packages/shared/src/engine` is a TypeScript port of the app's adaptive TDEE engine (`lib/core/engine/`), so the
server can compute trend weight, expenditure and targets for the web app and MCP. The app writes golden vectors (12
simulated histories × 24 programs, plus the check-in schedule and partial-day rules); `packages/shared/test` must
reproduce them bit for bit. After an engine change in the app:

```bash
make golden-engine                                   # in the app repo
scripts/sync-engine-fixtures.sh ../MacroTracker      # here; then update the port until make test-unit passes
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

[MIT](LICENSE). `apps/api/data/usda_sr_legacy.json.gz` is from USDA FoodData Central (SR Legacy, April 2018), which is
in the public domain (CC0 1.0).
