FROM node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS node
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
COPY --from=node /usr/local/ /usr/local/
WORKDIR /workspace/packages/smrt-playground/host
ENTRYPOINT ["node", "../../../node_modules/@playwright/test/cli.js", "test", "-c", "playwright.visual.config.ts"]
