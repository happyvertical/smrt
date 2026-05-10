# @happyvertical/smrt-assets-ergot

Ergot-backed adapter for the SMRT asset runtime.

## Purpose

This package lets applications keep `@happyvertical/smrt-assets` as the app-facing asset API while delegating advanced media work to Ergot.

Use it when an app needs MAM-backed search, cloud processors, generated candidates, workflow jobs, or synchronization with an Ergot media library.

Do not import this package from generic SMRT packages unless they are explicitly wiring an Ergot backend.

## Dependency Shape

The adapter is structurally typed around the consumer asset client surface.

That keeps core SMRT assets usable without Ergot and avoids making every SMRT consumer install Ergot wire clients.

Hosts that enable this adapter must pass a compatible Ergot client into `createErgotAssetProcessor()`.

When Ergot publishes a stable SDK, that SDK should implement the same client shape and may become a documented peer dependency.

Tests should use fake clients that implement the small adapter-facing surface instead of reaching into Ergot internals.

## Source References

SMRT assets remain canonical inside SMRT.

Ergot assets are connected through stable source references and external refs, not shared primary keys.

Use `sourceRef` for idempotent sync.

Use `externalId` only when the upstream consumer already has a stable external identifier.

Never assume a SMRT asset id and Ergot asset id are interchangeable.

## Provider Behavior

The adapter implements SMRT asset capabilities such as external sync, nearby search, variant resolution, and workflow submission.

Unsupported Ergot behavior should surface as an unsupported capability or provider error, not as a dashboard-specific workaround.

Tenant scope must be present on every Ergot request that can expose or mutate tenant data.

List and nearby calls should rely on Ergot's consumer-scoped API contract rather than re-querying private internals.

Direct asset and job lookups still need explicit tenant validation.

## Variants And Outputs

Prefer SMRT variant names such as `thumb`, `card`, `preview`, and `publish`.

Map Ergot sized image URLs into SMRT variant metadata without copying bytes unless the caller asks to materialize an output.

Generated candidates are not final article assets until approved and materialized through the SMRT asset runtime.

Workflow outputs should preserve lineage back to the source asset and Ergot job metadata.

## Gotchas

Keep broad Ergot client contracts in the SDK, not in this adapter.

Keep Anytown-specific content image behavior out of this package.

Do not reach into Ergot database tables or private APIs from here.

When adding a new Ergot capability, first extend the SMRT asset provider interface if the behavior is app-facing.
