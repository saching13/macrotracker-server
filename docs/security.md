# Security review

Reviewed 2026-11-03 before exposing a server publicly (plan-11 S8). Re-read this when adding an endpoint, a table or a
way in.

## What's protected, from whom

A server holds a few people's food diaries, weights and body measurements: personal health data. The threats are
someone on the internet, another account on the same server, a leaked token, and a stolen backup.

## Ways in

| Path                        | Who                                    | Controls                                                                                                                                                                                    |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/auth/*`                | anyone                                 | Invite-only accounts; GoTrue password hashing; 20 tries/min per address here plus GoTrue's own limits; refresh tokens rotate with reuse detection; generic errors (no account enumeration). |
| `/v1/*` data, sync, library | signed-in sessions, tokens with scopes | Access tokens verified locally against GoTrue's JWKS (ES256); devices can be signed out at once; tokens are scoped (`mcp:read` / `mcp:write` / `mcp:destroy`) and can't manage the account. |
| `/v1/admin/*`               | admins                                 | Admin role and a password session (no tokens); every action audited. Reachable wherever the server is (see _Choices_).                                                                      |
| `/mcp`                      | tokens (or sessions)                   | Same scopes, plus `MCP_*_ENABLED`; tools that change or delete need `confirm: true`.                                                                                                        |
| Web app, invite pages       | anyone                                 | Static files only (no wildcard routes); CSP `'self'`, frame-ancestors none; HSTS over HTTPS.                                                                                                |

## Isolation between accounts

- Every query filters by the caller, and Postgres row-level security enforces it again: the API connects as `mt_api`,
  which owns nothing, inside a transaction that sets `app.user_id`. `test/int/rls.test.ts` and `library.test.ts` prove
  another account can't read or change rows.
- Reference foods are read-only to the API (RLS allows only `select`). The shared library is readable by every account
  and writable only by its owner (admins may delete).
- Writes from the web and agents go through the same validation as a phone's push (zod schemas per synced table).

## Data handling

- Secrets live in `.env` (mode 600) or Docker secrets; tokens and refresh tokens are stored hashed; logs redact
  authorization headers and cookies and never include bodies.
- The browser keeps its access token in memory only; the refresh token is an httpOnly, SameSite=Strict cookie (Secure
  over HTTPS) scoped to `/v1/auth`, with a double-submit CSRF token.
- Backups (`backups/`) contain every account; files are mode 600. Keep copies somewhere equally private.
- The server makes no outbound requests except to GoTrue (no SSRF surface until a food-lookup proxy exists; when it
  does, it needs the SSRF guard in plan-11).
- INDB data never reaches the server, so it can't be redistributed through it.

## Findings

| #   | Finding                                                                                                                                                                               | Severity           | Status                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Helmet's default CSP sent `upgrade-insecure-requests`, breaking the web app over plain HTTP (tailnet).                                                                                | Low (availability) | Fixed: only over HTTPS.                                                                                                                                                    |
| 2   | The web app used `crypto.randomUUID`, missing outside secure contexts.                                                                                                                | Low (availability) | Fixed.                                                                                                                                                                     |
| 3   | Rate limits keyed on cloudflared's address behind the tunnel.                                                                                                                         | Medium             | Fixed: `TRUST_PROXY` is the tunnel network's subnet, so the client address (rightmost untrusted) is used.                                                                  |
| 4   | `pnpm audit`: moderate advisories in `glob` (via `@fastify/static`, which only lists our own files at startup), `minimatch` and `esbuild` (dev tooling). Not reachable from requests. | Low                | Accepted until the patched versions pass the 7-day release-age rule; Dependabot will propose them. CI now fails on high or critical advisories in production dependencies. |
| 5   | Admin routes are reachable through a public tunnel (plan-11 hoped to keep them tailnet-only).                                                                                         | Low                | Accepted: they need an admin's password session, are rate-limited and audited. Revisit with an `ADMIN_NETWORKS` allowlist if more people join.                             |
| 6   | The app accepts `http://` servers, which would send a password unencrypted on the open internet.                                                                                      | Low                | Accepted for tailnet/LAN use; the app assumes `https://` when no scheme is typed.                                                                                          |

## Choices

- Sign-up is closed; accounts come only from admin invites (links shown to the admin, never emailed).
- Deleting an account deletes all its data (cascades), including what it shared to the library.
- MCP deletes are off by default (`MCP_DESTROY_ENABLED=false`).
