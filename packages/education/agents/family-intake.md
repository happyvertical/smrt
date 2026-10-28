# Family intake

`FamilyIntakeService` retains guardian-only originals before a learner is known.
The host supplies a trusted actor/tenant and a current family authorizer; each
read, original download, assignment and adoption revalidates this authority on
the service's exact executor. Learners cannot browse the family inbox. Generated
CRUD, CLI, MCP and AI surfaces remain closed.

Retain the whole document with its source identity, delivery key, immutable hash
and original private assets. Source delivery retries must preserve identical
content and provenance. Email and scanner adapters are separate host configuration;
this service does not configure or select them. Trusted candidate DTOs and their
quoted evidence are advisory. A guardian's active learner preference, visible
marks, uncertain names or a first-page guess never establish ownership. Mixed
learner PDFs stay unresolved until an explicit whole-document assignment is safe.

Assignment records an immutable guardian decision with a revision and request
key. It does not create learner work. Adoption freezes that assignment and borrows
the exact original assets through learner photo ownership joins; it never rewrites
source confidentiality or creates grades. The existing photo resolution and
completed-work capture preconditions still apply. Existing derived capture copies
are permitted. Once adopted, a receipt cannot silently change learners; recovery
requires a separate explicit policy. An unadopted attribution can be corrected by
another audited decision with the current revision.

Family ownership retains originals beyond generic receipt expiry. Adoption does
not transfer or delete that ownership. Cleanup and rollback must preserve shared
retained bytes and compensate only newly created files. Every access checks the
original hash before adoption or download.

Validation uses shared family workflows on real SQLite and isolated PostgreSQL;
no AI providers, scanner/email services or containers are required.

Import `FamilyIntakeService`, `receiveFamilyIntake` and
`retainFamilyIntakeReceipt` from `@happyvertical/smrt-education/ingestion`.
The bridge uses the fixed `familyIntakeScopeId(tenantId)` namespace and public
`getReceiptSource` to retain authoritative delivery identity. A receive that
succeeds before education retention fails is repaired by retrying the same
receipt, never by inventing another delivery identity.

Deploy manifest migrations for all three FamilyIntake models and the nullable
`WorkbookPhotoIntake.familyIntakeId` FK before use. There is no runtime DDL.
Adoption commits its immutable audit and exact photo/original joins atomically;
the family asset remains the sole original owner. Existing derived submission
copies use normal capture compensation. The exact adoption audit is required
when validating borrowing joins, reads and immutable family-scope analysis.
`countFamilyIntakes` counts unadopted receipts across the full inbox, while
`listFamilyIntakes` pages the complete receipt history.

After adoption, use the returned `photoIntakeId` with ordinary photo
resolution/capture methods. Family-scope photo analysis checks the exact adopted
item/learner binding; learner-scoped uploads retain their existing strict scope.
The existing submission/assessment ingestion handlers still revalidate the
captured learner/attempt. Temporary ingestion expiry does not prevent manual
resolution/capture from retained education originals; re-analysis of an expired
receipt needs a separately authorized retained-input orchestration.

This initial contract assigns a whole receipt/document. It does not split a
mixed-child PDF, automatically infer a child or configure a source adapter.
Future range adoption must preserve original hashes and page provenance; the
retained immutable originals remain available for such an explicit workflow.

Source-tree retention includes image/PDF attachments beneath metadata envelopes.
A supported-media descendant of another supported original (for example a PDF's
page thumbnail) stays in the evidence graph but is not duplicated as learner
work. The immutable graph retains only IDs, parent IDs, media types and hashes;
it does not copy email bodies, arbitrary headers or credentials into public
source metadata. A source image such as an email logo is not automatically
classified as completed work. Whole-document attribution/classification remains
an explicit guardian decision; ambiguous mixed contents need resolution.

Custom source adapters must follow this supported convention: metadata parents
contain independent original attachments; descendants of supported media are
renditions of that media. Extraction outputs already live separately from source
evidence. An adapter that uses media-child relationships for independently
authored attachments is unsupported by this bridge until its role is explicitly
established; do not claim complete attachment fidelity for that shape or infer
roles from first-page content. Full immutable evidence lineage is retained even
when a rendition is excluded from capture pages.

The bridge rejects an entire receipt containing an unsupported independent
original, including a mixed PDF/TIFF bundle, before family retention. Generic
source originals remain available for recovery; no partial family receipt or
adoption is created. Hosts must acknowledge successful family import only after
family retention succeeds and surface failed source imports. Known JSON
metadata wrappers and media descendants under the supported rendition convention
are not independent originals.
