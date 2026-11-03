# Everything runs in Docker; Node is not needed on the host.
#   make env     first-time secrets (.env)
#   make up      build and start db + auth + api
#   make admin EMAIL=you@example.com   create the first admin
#   make test    unit + integration tests against throwaway containers
#   make backup-now   a database dump in ./backups now (daily ones happen anyway)
#   make restore-drill   back up, wipe and restore a throwaway stack
#   make e2e     web end-to-end tests (Playwright) against a throwaway stack
#   make web-dev the web app with hot reload on :5173 (needs `make up`)

DC    := docker compose
TEST  := docker compose -p mt-test --env-file .env.test
TOOLS := $(TEST) run --rm node

.PHONY: help env up down logs ps admin shell install lint typecheck format \
        test test-unit test-int test-reset gen-migration gen-openapi check-openapi build \
        gen-api e2e web-dev backup-now restore-drill

help:
	@grep -E '^#' Makefile | sed 's/^# \{0,1\}//'

env:
	docker run --rm -v "$(CURDIR)":/w -w /w node:26-alpine node scripts/gen-env.mjs .env

up:
	mkdir -p backups
	$(DC) up -d --build --wait

down:
	$(DC) down

logs:
	$(DC) logs -f --tail=100

ps:
	$(DC) ps

# Prints an invite link that sets the admin's password.
admin:
	@test -n "$(EMAIL)" || (echo "usage: make admin EMAIL=you@example.com [NAME='Your Name']" && exit 2)
	$(DC) exec api node dist/cli/create-admin.js --email "$(EMAIL)" $(if $(NAME),--name "$(NAME)")

shell:
	$(TOOLS) sh

install:
	$(TOOLS) pnpm install --frozen-lockfile

lint: install
	$(TOOLS) sh -c 'pnpm lint && pnpm format:check'

typecheck: install
	$(TOOLS) pnpm typecheck

format: install
	$(TOOLS) pnpm format

test-unit: install
	$(TOOLS) pnpm test:unit

test-int: install
	$(TEST) up -d --wait db auth
	$(TOOLS) pnpm test:int

test: test-unit test-int

# Throws away the test database (e.g. after editing docker/db/roles.sql).
test-reset:
	$(TEST) down -v

# Usage: make gen-migration [NAME=add_x] [CUSTOM=1]
gen-migration: install
	$(TOOLS) sh -c 'cd apps/api && pnpm exec drizzle-kit generate $(if $(NAME),--name $(NAME)) $(if $(CUSTOM),--custom)'

# The OpenAPI document, then the web app's typed client from it.
gen-openapi: install
	$(TOOLS) pnpm gen:openapi
	$(TOOLS) pnpm --filter @macrotracker/web gen:api

gen-api: install
	$(TOOLS) pnpm --filter @macrotracker/web gen:api

# Fails if openapi.json (or the web client) is out of date with the routes.
check-openapi: gen-openapi
	git diff --exit-code openapi.json apps/web/src/api/schema.d.ts

build: install
	$(TOOLS) pnpm build
	$(DC) build api

e2e: install
	scripts/e2e.sh

# Proxies /v1 to the API that `make up` runs on the host.
web-dev: install
	$(TEST) run --rm -p 127.0.0.1:5173:5173 -e API_URL=http://host.docker.internal:8080 \
	  node sh -c 'cd apps/web && pnpm dev'

backup-now:
	$(DC) exec -T backup /backup.sh now

restore-drill:
	scripts/restore-drill.sh
