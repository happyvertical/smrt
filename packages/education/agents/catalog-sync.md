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
resource revision still matches, an active guardian actor, and a host storage
adapter that creates an authorized private Asset from the pinned bytes. It
creates a `personal-use-copy` external course, its section and lesson, and the
sole `LessonAsset` join; it never makes a browsed resource assignable. A host
may then supply curriculum and learner identifiers so the service calls the
existing guardian-authorized learner enrollment API. Missing provider subject
classification must be supplied explicitly by the guardian.
