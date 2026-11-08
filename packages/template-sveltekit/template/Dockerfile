FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /app
# Node 25+ images no longer bundle Corepack; a pinned copy keeps
# `packageManager` authoritative for the pnpm version.
RUN npm install --global corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS runtime
WORKDIR /app
RUN npm install --global corepack@0.36.0 && corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml* /app/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
ENV NODE_ENV=production
ENV SMRT_RUNTIME_PROFILE=self-hosted
COPY --from=build /app/build ./build
COPY --from=build /app/.smrt ./.smrt
COPY --from=build /app/smrt.config.ts ./smrt.config.ts
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "build"]
