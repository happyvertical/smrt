FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS node
FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579
COPY --from=node /usr/local/ /usr/local/
WORKDIR /workspace/packages/smrt-playground/host
ENTRYPOINT ["node", "../../../node_modules/@playwright/test/cli.js", "test", "-c", "playwright.visual.config.ts"]
