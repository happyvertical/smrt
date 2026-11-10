# Source import integration

`SourceImportService` is a server-side host boundary, with no generated REST,
CLI, MCP or AI operation. Recipes remain metadata only. Provision a closed
`CourseSource` in the owning tenant, then construct the service with the root
SQL database and an actor-bound `SourceImportAuthorizer`. Enable tenancy and
call within `withTenant({ tenantId, userId })`; the request must match both.
Missing context, a different actor/tenant and super-admin bypass fail closed.

Register Easy Peasy only after the host operator accepts its terms, using
`registerEasyPeasy({ termsAccepted: true, fetchPage })`. Do not derive that
boolean from an HTTP request. `fetchPage(url, { redirect: 'error' })` must reject
redirects, bound time/size and return `{ html, url }`. It fetches the page only,
never a PDF. The service checks the approved HTTPS URL before fetching, checks
the response URL, limits HTML to 2 million characters, then parses the complete
page before any write. There is no automatic registration or network access. Structural h1–h6 headings delimit day content, including trailing Resources
sections; ordinary non-lesson bold instructions do not. Supported
heading blocks are h1–h6 or a lesson marker as the first bold run in a
paragraph/list item.
Recognizable markers outside that layout, including multiple markers in one
paragraph, fail closed rather than silently assigning a PDF to the wrong day.

The authorizer must verify the authenticated actor's management grant and the
provisioned tenant's family/group classification. Tenant has no built-in kind;
neither hierarchy position nor client input establishes a family. Authorization
is required before fetch and again inside the transaction; callbacks must be
read-only decisions, since a rolled-back contention retry can call them again.

`sharing` is a ceiling: private permits private-family import only; group and
global permit private-family or group import. Group imports additionally require
nonblank host-recorded `config.licenseEvidence` and an explicit host grant that
validates that permission. Global/null destinations are unsupported and rejected;
there is no global/system bypass. Widening a source never promotes existing
imports. Private imports are draft `personal-use-copy` courses and retain the
catalog's immutable owner/license and no-publication protection. A host may
create a new licensed group source and import there after receiving permission.

Use a stable `courseRef` independent of source URLs. Identities derive from the
owning tenant, source row ID, course reference and lesson day; retain the source
row when updating policy. Changes to titles/page/PDF URLs update in place.
Missing days are retained, not deleted, so enrollment, progress, submission and
asset foreign keys remain valid. A changed lesson kind fails the whole import
rather than replacing a row. Only title and pointer fields are refreshed; body,
answer keys, learner state and manually authored settings are never replaced.
The packet URL is returned as a source link and is not downloaded or mirrored.

All source policy rechecks and catalog mutations use collections bound to the
same SQL transaction. Embedded writes use the public write queue; PostgreSQL
serializes an import identity with a transaction-scoped advisory lock. Only
rolled-back busy/serialization/deadlock errors retry (at most three retries),
without repeating fetch. Connection-invalidated and other failures propagate.
Do not wrap the service in a caller transaction if the caller expects a durable
commit before returning; any outer transaction remains the caller's boundary.

SQLite and PostgreSQL integration tests exercise real transactions and rollback.
Full catalog children remain unavailable on DuckDB due to core's existing
ON UPDATE CASCADE/self-referential schema limitations documented in
[catalog-service.md](catalog-service.md); no alternate schema is substituted.
Tests use synthetic local HTML and an injected fetch callback, never the network.

Google Drive discovery defaults every record to `teacher`. A trusted host may
make only an exact reviewed file ID visible by passing `studentSafeFileIds`;
folder IDs and descendant membership never grant visibility. A teacher-marked
folder or name still wins over that allowlist. File shortcuts are excluded: a
shortcut does not prove the target remains under a reviewed root or retains the
target's teacher-path classification. Resync after changing the allowlist: the
durable sync upsert rewrites existing visibility rather than retaining a
previous learner classification.

Generic “Printable” and “Printables” labels identify lesson PDFs; course packets
require explicit packet/whole-course/complete-course wording. Only actual href
attributes supply pointers; data-href metadata does not.
