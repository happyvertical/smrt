# Private asset records

`Asset.accessMode` is `public` by default: the record is available through ordinary
asset APIs subject to the existing tenant/authentication checks. It does not mean
that the underlying bytes are publicly hosted. `private` records are excluded
from ordinary list/get, projection/count and parent STI hydration, even in system
or super-admin contexts. The policy is installed by importing Asset itself.
Generated REST/MCP updates and deletes cannot discover a private record.

A trusted server may use `withPrivateAssetAccess({ tenantId, actorUserId,
ownerProfileId, assetIds }, callback)` after independently authorizing the actor's
relationship to the owning business record. Never expose this capability as a
request option or populate it from arbitrary request JSON. It permits only the
exact private IDs and owner; ordinary public rows are not included within that
scope. The current tenant/user must match at each operation. Nested scopes may
only narrow IDs with the same owner, and scopes close when their callback ends.
Await every operation inside the callback. Async-local storage is resolved lazily
on Node; without that server capability, private scope creation explicitly fails
and ordinary policy reads remain public-only. This does not promise full package
browser runtime support: existing tenancy dependencies retain their own platform
limitations.

Hosts that only need display metadata call `runtime.getPrivateAssetMetadata({
tenantId, actorUserId, assetId })` after the same host authorization. It resolves
the owner internally, performs a guarded read of exactly that one ID, and returns
an allowlisted projection (never owner, `sourceUri`, description or metadata) or
`null` for missing, public and other-tenant assets. It never exposes the
capability.

Private writes require the same capability. Classification and ownership of an
existing private record are immutable. Core applies a mandatory persisted-write
predicate at the final database mutation, including natural-key adoption, so an
ordinary create/upsert cannot overwrite a private record that committed after its
pre-save probe. Guarded new writes never fall back to an unconditional SDK upsert;
a late insert collision can require a caller retry. The instance transaction
executor is used throughout. Raw `AssetCollection.query()` is rejected because
arbitrary SQL cannot reliably preserve the private-row predicate; use the guarded
list/get APIs. `findGlobal` and `findWithGlobals` retain their behavior through
guarded list reads. Direct database access is trusted infrastructure, not an
untrusted request API.

Private bytes must reside in non-public storage. HTTP(S) source locators are
rejected for private records; hosts must also configure private bucket/filesystem
ACLs. Hiding a locator cannot protect bytes already publicly accessible. Serving
routes must authorize the business relationship, validate their signed claim and
open only that exact asset capability before resolving the record.

## Schema and release

The new `access_mode` column has a `public` default, preserving existing asset
visibility after explicit migration. Generate/apply the normal manifest migration
before running the new runtime; runtime checks never create or alter application
schema. Rebuild assets and downstream manifests. A low-cardinality standalone
index on access mode is not added: exact reads use the primary key and scoped
lists retain their existing tenant predicates/indexes.

Education captures and split worksheet pages are private from their initial
transactional insert. Database metadata is atomic; external bytes use the
education service's compensating cleanup contract, not a distributed transaction.
