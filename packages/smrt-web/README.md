# @happyvertical/smrt-web

Browser data runtime for manifest-generated SMRT REST collections: cached reactive reads, request deduplication, optimistic writes, persistence, offline outbox replay, and live invalidation.

## Installation

```bash
pnpm add @happyvertical/smrt-web
```

## Main APIs

- `createSmrtWebClient()` creates an app-wide shared cache handle.
- `createSmrtCollection()` materializes a generated web collection definition.
- `createDefinitionFetchers()` derives CRUD calls from that definition.
- Capability hooks add durable persistence, offline outbox behavior, and live invalidation without exposing the underlying data engine.
- `initialData` seeds SSR results and avoids a duplicate first-render fetch.

Use one shared client per app and include tenant/identity scope in durable namespaces. Call collection cleanup during app teardown.

## Validation

```bash
pnpm --filter @happyvertical/smrt-web test
pnpm --filter @happyvertical/smrt-web typecheck
```
