---
description: SMRT Framework Global Rules
---

# Global Rules

Applies to all code in the `happyvertical/smrt` monorepo.

## Dependency Hierarchy

- **Upstream Structure**: `@happyvertical/sdk` -> Framework Monorepo
- **Downstream Structure**: Framework Monorepo -> Reference SaaS Workspace (`../happyvertical`)

## CI/CD Guardrails
Before committing any code that affects upstream or downstream capabilities or modifies `package.json` configurations across the pnpm workspaces:
1. **Testing**: You MUST run `pnpm test` successfully (requires `smrtVitestPlugin()` in `vitest.config.ts`).
2. **Build**: You MUST verify `pnpm build` works without errors to ensure cross-package type generation and Turborepo cache creation is functional.
3. **Linting**: Code must adhere strictly to the established biome configurations via `npm run format`.
4. **Docs Execution**: If the `CLAUDE.md` files are adjusted within the packages, consider running `smrt docs:claude` via `@happyvertical/smrt-cli` if required to propagate context down to downstream consumers.
