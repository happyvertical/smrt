# @happyvertical/smrt-bundle-gate

> **Status:** private CI package; it is not published or installed by consumers.

Consumer-bundle reachability and size regression gate for s-m-r-t packages. It
recreates a downstream SvelteKit SSR build over published-style `dist` exports
and detects provider SDKs that become reachable from provider-neutral imports.

## What it protects

A static import edge through `smrt-chat`, `smrt-personas`, or `smrt-messages`
can make large email, Slack, Google, or file-provider SDKs reachable from every
consumer bundle. Runtime laziness does not help when a bundler can still follow
the import graph.

The gate has two fixtures:

- `consumer-neutral.ts` imports provider-neutral package roots and must not
  resolve any forbidden provider module.
- `consumer-with-providers.ts` opts into
  `@happyvertical/smrt-messages/providers/all` and proves provider modules remain
  available when requested explicitly.

Both fixtures build through package export maps from `dist`, not workspace
source aliases.

## Run the gate

Build its package dependencies first, then run the test:

```bash
pnpm --filter @happyvertical/smrt-chat build
pnpm --filter @happyvertical/smrt-personas build
pnpm --filter @happyvertical/smrt-messages build
pnpm --filter @happyvertical/smrt-bundle-gate test
```

Turbo already supplies those upstream builds in CI.

## Interpreting failures

- **Forbidden module resolution:** fix the import boundary. Do not raise a size
  budget to hide it.
- **Legitimate size growth:** inspect the emitted `[bundle-gate]` report and
  update the budget in the same change with a rationale.
- **New heavyweight provider:** add it to `FORBIDDEN_PROVIDER_MODULES` with a
  comment explaining why provider-neutral consumers must not reach it.

Budgets live beside the consumer-boundary test so a review sees the measurement
and its policy together.

## Ownership

Changes to the package boundaries of chat, personas, messages, core, or assets
must keep this gate green. The gate exists to model the consumer's build, so it
must not use workspace-only aliases or private package internals.

See [`AGENTS.md`](./AGENTS.md) for the regression history and budget-update
rules.
