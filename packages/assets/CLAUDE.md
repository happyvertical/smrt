# @happyvertical/smrt-assets

Provider-agnostic asset management with versioning, type classification, and generic/provenance associations.

## Models

- **Asset** (STI base): versioning via `primaryVersionId` chain + `version` number. `ownerProfileId`, `typeSlug`, `statusSlug`, `mimeType`, `sourceUri`. Hierarchical via `parentId` (for derivatives).
- **AssetType** / **AssetStatus**: lookup tables for classification and lifecycle.
- **AssetMetafield**: custom metadata field definitions with JSON validation rules.
- **Folder**: STI subclass (typeSlug='folder') for hierarchical organization.
- **AssetAssociation**: generic/provenance polymorphic join — `assetId` + `metaType` + `metaId` + `role` + `sortOrder`. Use it when a relationship is not owned by a base/domain model join table.

## Key Patterns

- **Versioning**: `createNewVersion()` increments version, chains via `primaryVersionId`. `findVersions()` to retrieve history.
- **Tag integration**: `addTag()`/`removeTag()` use raw `db.upsert()` on `asset_tags` join table (not a SMRT model).
- **AssetStore**: abstraction for provider-agnostic file I/O (S3, local, etc.).
- **Ownership rule**: base/domain-owned asset relationships should live on noun join tables such as `content_assets`; keep `AssetAssociation` for generic/provenance links like image derivation.

## Gotchas

- **Version history manual**: `findVersions()` chaining required — no ORM shortcut
- **Tag management uses raw SQL**: `asset_tags` is a join table, not an SMRT model
- **Folder tree traversal manual**: via `parentId` lookups, no built-in tree methods
- **AssetAssociation polymorphic FK**: requires manual `metaType` string matching
- **Optional tenancy**: assets can be global (tenantId=null) or tenant-scoped
