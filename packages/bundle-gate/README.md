# @happyvertical/smrt-bundle-gate

Private CI package that protects provider-neutral SMRT imports from bundle-size and dependency-reachability regressions. It is not published for application use.

## What it checks

The test fixture performs a downstream-style SvelteKit SSR build against package `dist` exports. Neutral imports must not reach heavyweight messaging provider SDKs, while explicit provider imports must remain available. Emitted output must also stay within documented budgets.

## Validation

Build the package dependencies first, then run the gate:

```bash
pnpm --filter @happyvertical/smrt-bundle-gate... build
pnpm --filter @happyvertical/smrt-bundle-gate test
```

Fix forbidden import edges rather than raising budgets. A legitimate size-budget update must include measured evidence and rationale.
