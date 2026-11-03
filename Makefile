# Everything runs in Docker; Node is not needed on the host.
#   make env     first-time secrets (.env)
#   make up      build and start db + auth + api
#   make admin EMAIL=you@example.com   create the first admin
#   make test    unit + integration tests against throwaway containers

DC    := docker compose
TEST  := docker compose -p mt-test --env-file .env.test
TOOLS := $(TEST) run --rm node

.PHONY: help env up down logs ps admin shell install lint typecheck format \
        test test-unit test-int test-reset gen-migration gen-openapi check-openapi build

help:
	@grep -E '^#' Makefile | sed 's/^# \{0,1\}//'

env:
	docker run --rm -v "$(CURDIR)":/w -w /w node:26-alpine node scripts/gen-env.mjs .env

up:
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

gen-openapi: install
	$(TOOLS) pnpm gen:openapi

# Fails if openapi.json is out of date with the routes.
check-openapi: gen-openapi
	git diff --exit-code openapi.json

build: install
	$(TOOLS) pnpm build
	$(DC) build api
