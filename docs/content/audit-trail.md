# Audit trails

`AuditLog` remains in `@happyvertical/smrt-profiles`: its actor and delegated
actor are Profiles. Core owns the dependency-inverted collection mutation
contract, and `@happyvertical/smrt-svelte` owns the authorized-data views.
The change feed continues to serve synchronization rather than audit history.

## Automatic collection CRUD

Declare `@smrt({ audit: true })` on a model. The opt-in is inherited. Initialize
each request's collection with a trusted actor and a transaction-bound writer:

```typescript
import { createAuditWriter } from '@happyvertical/smrt-profiles';

const jobs = await JobCollection.create({
  db,
  auditTrail: { actorId: authenticatedProfile.id, source: 'web', writer: createAuditWriter() },
});
const job = await jobs.create({ title: 'Install equipment' });
await jobs.update(job.id, { title: 'Install updated equipment' }, {
  actorId: authenticatedProfile.id,
  reason: 'Customer changed the specification',
});
await jobs.delete(job.id, { actorId: authenticatedProfile.id, reason: 'Duplicate' });
```

Provision the `audit_logs` application schema through ordinary migrations before
enabling audited writers. Runtime does not create it. Apply `smrt db:migrate`
and check `smrt db:status --parity` before deployment.

Never accept `actorId`, `onBehalfOfId`, a writer, or database options from an
untrusted request body. Resolve the principal and permissions in the consumer's
server entry point before calling collection methods. Collection `auditTrail`
options are scoped to that collection. For generated SvelteKit routes, wrap the request
in the Node-only `withAuditContext` helper from core:

```typescript
return withAuditContext({
  actorId: event.locals.profile.id,
  writer: createAuditWriter(),
  source: 'web',
}, () => resolve(event));
```

Authenticate and establish tenant context before entering this scope. Generated
REST, MCP, CLI and offline sync updates use the same collection audit boundary.
They retain their existing writable, permission and read-response policies.
The scope flows through asynchronous work and restores automatically after the
request, so shared collection instances do not retain the previous caller's
identity. Explicit collection `auditTrail` options take precedence; use the async scope
for shared/request-cached collections. Supply reasons through a trusted service
call's second argument or through the request scope after validating caller input.

Automatic audits support SQLite, PostgreSQL and native DuckDB transactions.
Cascade deletes reuse the exact transaction handle only within a framework-owned
transaction scope. Ordinary objects rebound to a raw DuckDB caller transaction
retain the detectable nested-transaction refusal; use the owning collection
mutation boundary for audited writes.
JSON export adapters refuse audited mutations before persistence because their
JSON file writes cannot share the SQL rollback guarantee. Run JSON-backed domain
services with an explicit external transactional audit design; do not claim an
automatic JSON audit succeeded. Existing caller transactions on engines without
savepoints may refuse nested audited collection transactions before any write;
use a root connection for the automatic mutation boundary.

Each successful create, update, or delete records a `created`, `updated`, or
`deleted` action with qualified resource type, id, tenant, actor, optional reason
and field changes. Ownership comes from the model's registered tenant field,
including custom fields such as `organizationId` declared on the model or
registered at runtime with `registerTenantScopedClass`. Multiple conflicting
runtime ownership columns refuse the mutation atomically. System/admin context never
replaces the resource's actual owner. `getOrUpsert` audits its existing-record
update path too.
The public serialization projection omits sensitive fields and fields requiring
read permission, including nested SMRT objects and STI metadata. Core revision
timestamps are omitted from the diff. Missing values appear as `null`.

The mutation and entry share one database transaction. Missing audit setup or a
writer failure refuses the mutation. A custom writer must use the provided
transaction handle and propagate errors. Audited creates use INSERT semantics:
a natural-key collision refuses the write rather than silently replacing a
record and misreporting an update as a creation. Use `update(id, values)` for
existing records; it permits registered mutable fields and refuses identity,
tenant, private, and readonly fields. Saves and deletes on directly held objects
and custom collection overrides are outside this collection CRUD seam: domain
services must explicitly record their actions in their own transaction.

## Manual service actions

`AuditLog.record()` and `AuditLogCollection.record()` accept `reason` and
`changes` along with the existing `profile`, `action`, resource and source
fields. Services can record named actions such as `approved` or `corrected`.
Manual metadata and diffs are trusted explicit inputs: services must remove
secrets and permission-gated values before supplying them. Pass the same
transaction-bound `db` used for the service mutation to make both atomic.

## Protected reads

The audit model is sensitive by default: the change feed withholds its row
identifiers and timing, and no REST, MCP or CLI read routes are generated.
Consumers expose their own authenticated endpoint and use `readAuditTrail`:

```typescript
import { AuditLogCollection, readAuditTrail } from '@happyvertical/smrt-profiles';

const logs = await AuditLogCollection.create({ db });
const entries = await readAuditTrail(logs, async (entry) => {
  return permissions.canReadAudit &&
    await canReadResource(principal, entry.resourceType, entry.resourceId);
}, { profileId, resourceType: 'Job', resourceId, from, to, limit: 100 });
```

The consumer checks both the audit permission and the referenced resource,
including deleted resources. Collection tenant interceptors still apply.
Only literal `true` permits an entry; errors and malformed hook results deny.
The candidate query is bounded (1–1000, default 100) before authorization, so
denials may produce a shorter page; no unauthorized total or cursor is returned.
Use qualified model names for automatically recorded resource types. Existing
low-level collection helpers remain trusted server APIs, not consumer endpoints.

## Retention

`pruneAuditTrail(logs, { maxAgeDays: 365, batchSize: 500 })` removes at most one
bounded batch older than the configured age. Schedule it in the application's
maintenance job and repeat batches until it returns fewer than `batchSize`.
It preserves current collection tenant scope. Run tenant maintenance in each
authorized tenant context; cross-tenant maintenance requires the consumer's
explicit trusted administrative context. No retention window is silently
imposed by importing profiles. Retry converges on the remaining old entries.

The indexed `occurredAt` timestamp serves date filters and retention. A schema
migration adding it gives historical rows the deploy-time default; choose an
explicit one-time backfill from `created_at` in the consumer's migration when
historical event timing must be preserved before enabling retention.

## History components

Import `RecordHistory` and `AuditList` from `@happyvertical/smrt-svelte`. Map
authorized server results to `AuditHistoryEntry`: `id`, `profileId`, `action`,
`resourceType`, `resourceId`, ISO `occurredAt`, optional `actorLabel`, `reason`,
`changes`, and `onBehalfOfId`. Neither component fetches nor authorizes data.

`RecordHistory` accepts optional `resourceType` and `resourceId` to display one
record's newest-first history. `AuditList` filters an already-authorized dataset
by person, record and date. For server paging, pass `onfilter`; the callback
receives person/record IDs and date-only strings, and the consumer reloads an
authorized page. Translate date-only inputs into the consumer's explicit
timezone and end-of-day bounds before calling `readAuditTrail`.
Both views support loading, errors, empty results and unknown action names.

Both components also accept optional `resourceLabel`, `actionLabel`,
`fieldLabel`, and `formatValue` callbacks for consumer-friendly text.
`resourceHref` can link the resolved resource label, but it is presentation
only: return a local path or explicit HTTP(S) URL only after the server has
authorized that destination for the current viewer. Unsafe schemes,
protocol-relative URLs, callback errors, and malformed callback results fall
back to plain default text. Label and value callback results are always rendered
as text, never HTML. `AuditList` forwards these callbacks to `RecordHistory`.
Set `showFilters={false}` when the consumer owns a separate authorized filter
form; the built-in filters remain visible by default.
