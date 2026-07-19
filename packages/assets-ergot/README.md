# @happyvertical/smrt-assets-ergot

Optional Ergot-backed processing, search, workflow, and synchronization adapter for `@happyvertical/smrt-assets`.

## Installation

```bash
pnpm add @happyvertical/smrt-assets @happyvertical/smrt-assets-ergot
```

## Usage

Pass a compatible Ergot consumer client to `createErgotAssetProcessor()`, then register the returned provider with the SMRT asset runtime. SMRT remains the source of asset identity; Ergot records are joined through stable source references rather than shared primary keys.

## Capabilities

- External asset synchronization and nearby search.
- Variant URL resolution and workflow submission.
- Generated-candidate lineage and materialization.
- Tenant-qualified provider requests.

## Validation

```bash
pnpm --filter @happyvertical/smrt-assets-ergot test
pnpm --filter @happyvertical/smrt-assets-ergot typecheck
```
