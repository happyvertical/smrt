# smrt-workbench

Shared developer workbench for SMRT packages and consumer projects.

## Role

- Owns the browser host, Vite discovery plugin, package workbench module
  contract, and read-only developer UI.
- Composes existing package route modules, `smrt-playground` previews, package
  metadata, scripts, docs, manifests, and knowledge summaries.
- Does not execute shell commands from browser UI. Commands are displayed as
  copyable text only.

## Boundaries

- `smrt-playground` continues to own preview discovery/rendering contracts.
- `smrt-dev-mcp` continues to own knowledge freshness, review/architecture
  bundles, and package specialist context generation.
- Package route modules remain package-owned. Workbench mounts them inline in a
  single shared host.

## Commands

```bash
pnpm --filter @happyvertical/smrt-workbench test
pnpm --filter @happyvertical/smrt-workbench typecheck
pnpm --filter @happyvertical/smrt-workbench build
```

The maintained host browser suite is `pnpm --filter smrt-workbench-host test:e2e`.
It builds its own host and uses port 5570; set `SMRT_WORKBENCH_TEST_PORT` to
isolate it from a running QA server. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
selects a supported system Chromium and `CI_TEST_TMPDIR` places browser results
in owned scratch space. Mobile regressions check the shell content and preview
bounds with navigation collapsed; document width alone misses clipped content.
