# Catalog synchronization contract

`CatalogResource` is a global provider-native metadata record. Its identity is
`providerId + stableId`; do not merge or overwrite it with a matching record
from another provider. `CatalogSelection` and `CatalogAcquisition` are required
tenant-scoped records and are the only catalog records that express family use.

Use `CatalogSyncService` with a durable `CatalogSyncStore`. Adapters enumerate
metadata through `CatalogSyncAdapter`; this API has no byte or download method.
Persist the cursor after every partial page. Only a terminal successful page may
mark a checkpoint complete and withdraw source records not seen in that run.
A failed, restricted, or incomplete enumeration remains incomplete and retains
its cursor and failures for resumption.

Use `CatalogPolicy` for server-side visibility and operation decisions. Unknown,
conflicting, and restricted license evidence denies content operations. Teacher
material is omitted for non-teachers before any DTO is formed. Acquisitions are
explicit selected-content requests through `CatalogAcquisitionService`; it
requires a currently pinned revision and available format, verifies the returned
revision and SHA-256, and returns an existing acquisition before contacting a
provider on retry. Catalog browsing and synchronization must never call it.

`CatalogMaterializationService` is the only framework path from an acquired
selection to learner material. It requires a tenant-owned acquisition whose
resource revision still matches, current host-derived guardian authorization
(`education.catalog.materialize`), and a host storage adapter that creates an
authorized private Asset from the pinned bytes. Caller-provided roles are never
authorized. Before private storage side effects it re-runs `CatalogPolicy` on
the current resource and its current license evidence (`print` for PDF,
`download` otherwise); restricted or conflicting evidence denies promotion. It
creates a `personal-use-copy` external course, its section and lesson, and the
sole `LessonAsset` join; it never makes a browsed resource assignable. A host
may then supply curriculum and learner identifiers so the service calls the
existing guardian-authorized learner enrollment API. Missing provider subject
classification must be supplied explicitly by the guardian.


`CatalogSyncPage.policyExclusions` contains normal policy omissions; the service
returns their bounded invocation-local `exclusionSummary` and never persists it.
A summary has `total`, up to 32 `{ code, count }` entries in `byCode`, and
`otherCount`. It is not a full-generation coverage count. Operational `exclusions`
or `paused` pages stay incomplete at the existing cursor and never withdraw.

The durable failure array stays backward compatible. It aggregates occurrence
`count` by code, caps retained diagnostics at 31 recent codes plus explicit
overflow, and declares compacted/truncated detail with `omittedDetailCount`.
Report-only `failureSummary` separates historical and current invocation counts.
Never infer that a legacy mixed ledger entry is a policy omission, or treat
history alone as a current error. A no-cursor historical checkpoint starts the
new adapter root and retains source rows until actual terminal withdrawal.

Valid coarse K–5 and unconfirmed OER snapshots use policy-only partial pages:
without a next cursor, their valid metadata is retained and the checkpoint
pauses for unconfirmed coverage, without inventing an operational failure or
withdrawing unseen rows. In Drive's catalog adapter, definite unsupported or
out-of-boundary shortcut omissions are policy; missing revisions and inaccessible
targets remain operational failures. The direct Drive discovery API is unchanged.


Observed representation metadata and legal permissions are separate. Use the
public `evaluateCatalogAcquisitionCapability` on a fresh record before creating
new selection/file state, then apply `CatalogPolicy` independently. The
`representation` serialized JSON field uses a nullable TEXT column (existing rows
remain SQL NULL; new model/store values use JSON null); apply its
additive manifest migration before runtime use. Missing/null remains legacy,
but malformed present metadata must never be erased into legacy absence:
`normalizeCatalogRepresentation` and the model getter throw a typed error and
the evaluator returns an explicit denial. Known ZIP/DOCX and over-cap PDF metadata
are retained; technical acquisition restrictions never remove legal evidence.
Current configured limits may tighten a recorded limit. Existing pinned-byte
retries retain their actor/selection/revision/legal checks and do not become
unavailable merely because future acquisition limits tightened.


The public IM adapter enumerates strictly hosted artifact links independent of
icons; only actual PDF/ZIP/DOCX MIME is recognized and only PDF is acquirable.
An eligible public HEAD with valid size and strong validators retains an explicit
`format: 'unknown'` representation when Content-Type is absent (`mediaType: null`,
`missing-content-type`) or syntactically valid but unrecognized (the bounded
canonical MIME token, `unrecognized-content-type`). Its acquisition status is
`unknown-format`, `availableFormats` is empty, and the public evaluator denies
before new selections, files or asset GETs. Legal evidence, size and validators
remain intact and metadata enumeration advances. Unknown MIME does not establish
technical support or change legal permission. Malformed present MIME and invalid
validators still pause without advancing. Unknown revisions encode MIME absence
or the observed token, so later recognition changes identity; ordinary PDF v1
revision encoding remains stable. Role/local ownership/malformed
markup checks apply to every format; external hosts remain outside coverage.
Expanded parsed inventory changes page fingerprints once: old offset cursors
must pause, never be reinterpreted against a different artifact list.

Recovery is quiescent **operator-only**, using existing public
`CatalogDatabaseSyncStore.getCheckpoint/saveCheckpoint`; see the concrete
[procedure](../README.md#recovering-an-old-partial-inventory-after-a-semantic-scope-change).
Fence/disable/drain every catalog producer, automatic continuation and job across
every pod/process and await all in-flight successes/failures before the fresh
paused/expected-run check and reset; browser Stop/paused status is insufficient.
Keep writers fenced through reset. Preserve rows, bounded ledger/counts,
last-success time and private bytes; use a fresh run UUID/no cursor/imported0,
incomplete/unpaused state. Only actual terminal success may later withdraw.
This is not an ordinary UI restart or multi-writer CAS guarantee. Old catalog
retries can be stale while already assigned private files remain unchanged;
new current-adapter pins remain stable on a same-adapter semantic refresh.
