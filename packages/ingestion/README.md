# @happyvertical/smrt-ingestion

Durable receipt, evidence, analysis attempts and action-journal foundations for
[ADR 0004](../../docs/adr/0004-application-aware-ingestion.md).

The root, `/models` and `/dto` entry points are browser-safe. Import
`IngestionService` from `/server` in trusted host code. Generated REST, CLI and
MCP access to the persistence models is disabled; hosts expose authorized DTO
methods through their authenticated application transport.

Before starting a service, deploy the package manifest through the public s-m-r-t
migration APIs or `smrt db:migrate`. `assertReady()` only checks existing tables.
SQLite and PostgreSQL are supported; other engines fail construction.

A host supplies a database, AssetRuntime, authenticated tenant/actor/confidential
scope, a live authorization callback, a registered jobs target, and an idempotent
`purgeDerived` callback for host-owned previews, retrieval indexes and caches.
The authorization callback receives the captured ceiling and the current
transaction executor; it must intersect current grants with that ceiling. Never
construct the scope, retention policy or budgets from incoming document labels.

`receive` accepts bounded original byte buffers, with stable source part IDs,
parent relationships and optional upstream identity/version. Source adapters own
streaming and upstream snapshot retrieval. Receipt identity is tenant + source +
delivery key; changing bytes or authenticated scope conflicts. Content equality
in a different conversation does not deduplicate an arrival. The returned item
ID and version are safe acknowledgment data, never a storage URL.

Storage intents contain a stable asset ID and a public AssetStore-planned URI
before byte I/O. Preservation verifies existing bytes instead of replacing them.
A receipt becomes ready only after every part is durable and its dispatch intent
commits. A source retries the same receive call after failure or lost
acknowledgment. Hosts schedule `repairDispatches` after restart and periodically;
it repairs missing/failed queue submissions through SmrtJobCollection. The host
job restores the captured scope and calls the analysis lifecycle methods. Run
TaskRunner with the `ingestion` queue enabled.

`analyze` appends immutable input/configuration revisions. `claimAnalysis` uses
leases, monotonic fences and attempt budgets; `completeAnalysis` rejects expired
or superseded workers. Terminal attempt output/provenance is preserved. Queue
submission budgets also stop repeated handler failures in visible
`needs_attention`. Reprocessing does not mint actions. `createAction`,
`publishProposal` and `appendPlan` persist explicit intentions and exact attempt
bindings for the later review/execution layer. They do not approve or apply
business operations. Decision/execution/feedback models are persistence
foundations; policy, handler expansion, review and business apply belong to the
later epic children.

`expire` revokes access and pending work before removing bytes and calling
`purgeDerived`. Interrupted deletion is retried by `repairDeletions` and
`sweepRetention`. Minimal receipt/action identities remain, including successful
action result digests; all content-bearing journal payloads are redacted. Private
cleanup locators remain in deletion tombstones so repeated sweeps can remove a
late stale writer's orphan bytes even after the asset owner row is gone. Source
adapters must enforce their configured delivery-age cutoff; expired replay IDs
never become fresh work. Continue running the cleanup sweep for the retained
storage namespace. Upstream source mutation/deletion cannot change copied
originals; explicit privacy deletion revokes every ingestion-derived payload and
requires host cache/index purge.

See [EXTRACTION.md](EXTRACTION.md) for bounded extraction, lease-bound input
snapshots, provider isolation requirements and the extraction corpus.

Validation commands are `pnpm test`, `pnpm test:postgres`, `pnpm test:providers`, `pnpm typecheck` and
`pnpm build` (including built browser import inspection). The PostgreSQL lane
requires the repository's configured database service and never silently skips.
The provider lane exercises local SDK adapters and process isolation; it does not
claim live remote recognition quality. Component, e2e and evaluation command names are reserved by the ADR and
explicitly unavailable until their owning children deliver the corresponding
capability. See the [behavior matrix](../../docs/test-matrix/3670-ingestion-foundation.md).

## Authoritative review and execution

Configure `IngestionOptions.execution` for policy, immutable previews, authenticated
decisions and idempotent domain execution. See [execution integration](agents/execution.md)
for the public handler catalog, required host authorization/target locks, deployment
migrations and jobs continuation integration. The maintained application reference
in `reference/handlers.ts` creates draft ContentDocuments and attaches retained
evidence through public domain APIs; it is not a published runtime adapter.
