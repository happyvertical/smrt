FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS node
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d
COPY --from=node /usr/local/ /usr/local/
WORKDIR /workspace/packages/smrt-playground/host
ENTRYPOINT ["node", "../../../node_modules/@playwright/test/cli.js", "test", "-c", "playwright.visual.config.ts"]
