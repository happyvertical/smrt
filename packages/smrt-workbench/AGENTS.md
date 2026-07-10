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
