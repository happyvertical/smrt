---
"@happyvertical/smrt-core": minor
---

feat(dispatch): add `correlationId` for request/response linking

Adds a first-class `correlation_id` column to the dispatch system, enabling agents to link related dispatches (e.g. a video generation request and its completion response).

- New `correlationId` field on `DispatchEmitOptions`, `DispatchMetadata`, `DispatchListOptions`, `Dispatch`, and `DispatchData`
- Schema DDL includes `correlation_id` column and index
- Auto-migration for existing databases (adds column if missing)
- Query dispatches by `correlationId` via `bus.list({ correlationId })`
