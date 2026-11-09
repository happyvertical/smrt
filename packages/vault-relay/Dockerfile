# Blind snapshot relay image. Build from the repository root:
#   docker build -f packages/vault-relay/Dockerfile -t <registry>/smrt-vault-relay:<version> .
# Publication (registry, tag, digest pinning) is a separate reviewed operation.
FROM node:26.12.1-alpine@sha256:ae8e1c19d56886270987e99b3cfcef13a919f0655b376ae322bc64ada76f88cd AS build
WORKDIR /repo
# Node 25+ images no longer bundle Corepack; a pinned copy keeps
# `packageManager` authoritative for the pnpm version.
RUN npm install --global corepack@0.36.0 && corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter @happyvertical/smrt-vault-relay...
RUN pnpm --filter @happyvertical/smrt-vault-relay deploy --legacy --prod /out

FROM node:26.12.1-alpine@sha256:ae8e1c19d56886270987e99b3cfcef13a919f0655b376ae322bc64ada76f88cd AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out ./
USER node
# 8080: device API (public). 8081: admin API (cluster-internal only).
EXPOSE 8080 8081
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
