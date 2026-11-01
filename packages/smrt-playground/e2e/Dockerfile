FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS node
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
COPY --from=node /usr/local/ /usr/local/
WORKDIR /workspace/packages/smrt-playground/host
ENTRYPOINT ["node", "../../../node_modules/@playwright/test/cli.js", "test", "-c", "playwright.visual.config.ts"]
