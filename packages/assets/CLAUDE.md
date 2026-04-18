# @happyvertical/smrt-assets

Provider-agnostic asset management with versioning, type classification, and generic/provenance associations.

## Models

- **Asset** (STI base): versioning via `primaryVersionId` chain + `version` number. `ownerProfileId`, `typeSlug`, `statusSlug`, `mimeType`, `sourceUri`. Hierarchical via `parentId` (for derivatives).
- **AssetType** / **AssetStatus**: lookup tables for classification and lifecycle.
- **AssetMetafield**: custom metadata field definitions with JSON validation rules.
- **Folder**: STI subclass (typeSlug='folder') for hierarchical organization.
- **AssetAssociation**: generic/provenance polymorphic join — `assetId` + `metaType` + `metaId` + `role` + `sortOrder`. Use it when a relationship is not owned by a base/domain model join table like `content_assets`, `profile_assets`, `event_assets`, `place_assets`, or `product_assets`.

## Key Patterns

- **Versioning**: `createNewVersion()` increments version, chains via `primaryVersionId`. `findVersions()` to retrieve history.
- **Tag integration**: `addTag()`/`removeTag()` use raw `db.upsert()` on `asset_tags` join table (not a SMRT model).
- **AssetStore**: abstraction for provider-agnostic file I/O (S3, local, etc.).
- **Ownership rule**: base/domain-owned asset relationships should live on noun join tables such as `content_assets`, `profile_assets`, `event_assets`, `place_assets`, and `product_assets`; keep `AssetAssociation` for generic/provenance links like image derivation.

## Runtime surface

Apps and agents should depend on the public **asset runtime** rather than hand-wiring a collection + store per-package (#1128).

- `createAssetRuntime({ db, storage })` → `AssetRuntime` bundling `AssetCollection`, `AssetAssociationCollection`, and an initialized `AssetStore`.
- `AssetRuntime.storeSourceAsset(name, data, opts)` — create a new source asset (record + bytes).
- `AssetRuntime.storeDerivedAsset(source, name, data, opts)` — create a derivative with `parentId` set and (by default) a provenance `AssetAssociation` under a chosen role.
- `AssetRuntime.linkDerivation(source, derivative, { role })` — record provenance without touching bytes.
- `AssetRuntime.setExtractionStatus(asset, status, { error?, extractedAt? })` — write canonical extraction metadata into the asset's description JSON sidecar.

Agents that need asset I/O should accept an `AssetRuntimeLike` in their options rather than asking callers to pass a store + collection separately.

## Serving contract

- `serveAsset({ runtime, asset, tenantId?, disposition?, canAccess?, headers?, remoteMode? })` → standard Web `Response`.
  - `404` when the id doesn't resolve; `403` when the tenant mismatches or `canAccess` denies; `302` when `remoteMode: 'redirect'` and the asset's `sourceUri` is `http(s)`; `502` when `remoteMode: 'proxy'` and the origin fetch fails; `500` on store read errors or unexpected failures; `200` otherwise with `Content-Type`, `Content-Length`, and `Content-Disposition` set.
  - Assets whose `sourceUri` is `http(s)` are supported via `remoteMode`: `'proxy'` (default, fetch and return bytes), `'redirect'` (302 to the origin), or `'error'` (treat as misconfiguration). Pass `fetchImpl` to swap the fetch client.
  - `Content-Disposition` filenames are sanitised (control characters stripped, `"` / `\` / `/` replaced) to prevent header injection on untrusted asset names.
  - The 500 body is a generic `'Internal error serving asset'`; the underlying error is logged via `console.error` so operators can debug without leaking paths/bucket names to clients.
  - Works in SvelteKit `+server.ts` endpoints, Hono, and any runtime with a global `Response` (Node 18+). Pass `responseCtor` for older runtimes.
- `resolveAssetForServing(options)` → `{ asset, data, contentType, filename, size }` when callers want to render their own framework response. Throws `AssetServeError(status)` on the same failure modes.

## Source/derived vocabulary

The following roles are exported as `ASSET_ROLES` and should be preferred over ad-hoc strings when apps want cross-package tooling (serving, UI pickers) to agree on meaning:

| Role | Use |
|------|-----|
| `source_document` | original upstream document (agenda PDF, minutes) |
| `document_image` | page/extracted image derived from a source document |
| `thumbnail` | preview rendition of another asset |
| `proof` | non-canonical evidence asset backing a fact |
| `derivation_source` | "came from" link on generated media |
| `attachment` | generic owner-join link |
| `hero` | primary/featured asset on an owner |

Canonical metadata keys are exported as `ASSET_METADATA_KEYS`: `extractionStatus`, `extractionError`, `extractedAt`, `sourceUrl`, `sourceHash`, `pageNumber`. Extraction status values live in `ASSET_EXTRACTION_STATUS` (`pending | running | succeeded | failed`).

## Gotchas

- **Version history manual**: `findVersions()` chaining required — no ORM shortcut
- **Tag management uses raw SQL**: `asset_tags` is a join table, not an SMRT model
- **Folder tree traversal manual**: via `parentId` lookups, no built-in tree methods
- **AssetAssociation polymorphic FK**: requires manual `metaType` string matching
- **Optional tenancy**: assets can be global (tenantId=null) or tenant-scoped
