#!/bin/sh
# Web end-to-end tests: starts a throwaway stack (compose project mt-e2e,
# test-only secrets), creates an account, runs Playwright in its official
# image on the stack's network, then removes everything.
set -eu
cd "$(dirname "$0")/.."
PW_VERSION=$(node -p 'require("./apps/web/node_modules/@playwright/test/package.json").version' 2>/dev/null ||
  docker run --rm -v "$PWD":/w -w /w node:26-alpine node -p 'require("./apps/web/node_modules/@playwright/test/package.json").version')
export PUBLIC_URL=http://api:8080 API_PORT=18081
dc() { docker compose -p mt-e2e --env-file .env.test "$@"; }
trap 'dc down -v >/dev/null 2>&1 || true' EXIT

dc up -d --build --wait db auth api
EMAIL=e2e@example.test
PASSWORD=e2e-password-1234
printf '%s' "$PASSWORD" | dc exec -T api node dist/cli/create-admin.js --email "$EMAIL" --password-stdin

docker run --rm --network mt-e2e_default --ipc=host \
  -v "$PWD":/work -w /work/apps/web \
  -e CI="${CI:-}" -e SCREENSHOTS="${SCREENSHOTS:-}" -e E2E_URL=http://api:8080 -e E2E_EMAIL="$EMAIL" -e E2E_PASSWORD="$PASSWORD" \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" \
  node_modules/.bin/playwright test "$@"
