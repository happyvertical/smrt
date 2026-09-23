# s-m-r-t Playground test host

Private SvelteKit application used by the `@happyvertical/smrt-playground` Playwright suite. It is a workspace fixture, not a published package or application template.

## Validation

```bash
pnpm --dir packages/smrt-playground/host build
pnpm --dir packages/smrt-playground/host test:e2e
```

To run against an already-built or external host, set `PLAYWRIGHT_BASE_URL`.
Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the Playwright-managed Chromium
binary is unavailable.

Playground runtime and component documentation lives in the [parent package README](../README.md).
