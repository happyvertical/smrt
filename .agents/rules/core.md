---
description: Rules for @happyvertical/smrt-core package
---

# Rules for `@happyvertical/smrt-core`

These rules specifically target development occurring inside `packages/core`.

## Dependency Mapping

- **Relies On**: External AI/Files/SQL SDKs (`@happyvertical/sdk/*`).
- **Required By**: Almost every single downstream package and user namespace. Treat all API definitions inside `src/manifest/`, `src/generators/`, and the `SmrtCollection` class as highly stable and strictly version-controlled.

## Modification Guardrails
- **Code Generation (`/generators`)**: If you adjust `rest.ts`, `swagger.ts`, or `mcp.ts` inside `packages/core/src/generators/`, you must write or amend the corresponding unit tests to verify the AST and text generation output remain valid.
- **Vite Plugin**: Modifying the `.vite/` structure and plugin loaders mandates executing full monorepo build procedures since testing across all boundaries relies on metadata correctly extracted at runtime during `.vite` instantiation.
- **Scanner / SchemaGenerator rebuild required**: `src/vite-plugin/import-build-aware.ts` loads `src/scanner/*` and `src/schema/generator.ts` from `dist/` deterministically (the old `import.meta.url.endsWith('.ts')` sniff was non-deterministic under tsx and repeatedly broke publishes — see #1139). If you edit either directory, run `pnpm build` in core or have `pnpm dev` / `pnpm build:watch` running — otherwise your scanner/generator edits will not be reflected in consumer manifest generation, and any manual tests against a consumer project will silently use the stale dist.
- You MUST run `pnpm test` after any change to `@smrt()` or `SmrtCollection` to ensure you haven't broken the ORM layers for any neighboring packages like `users` or `agents`.
