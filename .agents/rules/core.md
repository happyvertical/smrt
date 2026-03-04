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
- You MUST run `pnpm test` after any change to `@smrt()` or `SmrtCollection` to ensure you haven't broken the ORM layers for any neighboring packages like `users` or `agents`.
