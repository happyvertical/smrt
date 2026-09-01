FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false
ENV NODE_ENV=production
ENV SMRT_RUNTIME_PROFILE=self-hosted
COPY --from=build /app/build ./build
COPY --from=build /app/.smrt ./.smrt
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/smrt.config.ts ./smrt.config.ts
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "build"]
