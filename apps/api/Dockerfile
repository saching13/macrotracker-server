# syntax=docker/dockerfile:1
# Build context is the repo root (the workspace), e.g. `docker compose build api`.

FROM node:26-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Node 25+ no longer bundles corepack; install the pnpm that packageManager pins.
RUN npm install -g "$(node -p 'require("./package.json").packageManager')"
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
COPY openapi.json ./
# The web app builds into apps/api/web, which the API serves.
RUN pnpm --filter @macrotracker/shared build \
 && pnpm --filter @macrotracker/web build \
 && pnpm --filter @macrotracker/api build \
 && pnpm --filter @macrotracker/api deploy --prod --legacy /out

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
