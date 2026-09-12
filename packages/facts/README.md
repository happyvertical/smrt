# @happyvertical/smrt-facts

Knowledge base with semantic deduplication, provenance tracking, and confidence scoring for the s-m-r-t framework. Facts evolve through parent-child chains, are linked to sources and subjects, and undergo 3-zone reconciliation to prevent duplicates.

## Installation

```bash
pnpm add @happyvertical/smrt-facts
```

## Usage

```typescript
import {
  Fact, FactCollection,
  FactSource, FactSourceCollection,
  FactSubject, FactSubjectCollection,
  FactContent, FactContentCollection,
  FactTag, FactTagCollection,
  calculateConfidence, normalizeText,
} from '@happyvertical/smrt-facts';

// Create a fact with provenance
const facts = await FactCollection.create({ db });
const fact = await facts.create({
  textRefined: 'The Eiffel Tower is 330 meters tall',
  type: 'measurement',
  domain: 'landmarks',
  status: 'active',
});

// Attach a source with credibility score
const sources = await FactSourceCollection.create({ db });
await sources.create({
  factId: fact.id,
  sourceUrl: 'https://example.com/eiffel-tower',
  sourceTitle: 'Tourism Board',
  credibility: 0.9,
});

// Recalculate confidence from all sources
await facts.recalculateConfidence(fact.id);

// 3-zone semantic reconciliation
// >= 0.85 similarity: auto-merge (same fact, update metadata)
// 0.60-0.85: AI disambiguation (asks model to decide merge vs branch)
// < 0.60: create new fact
const result = await facts.reconcile({
  rawInput: 'The Eiffel Tower stands 330m tall',
  type: 'measurement',
  domain: 'landmarks',
  source: { sourceUrl: 'https://another-source.com', credibility: 0.8 },
});
// result.action: 'created' | 'merged' | 'branched'

// Evolution chains: branch creates a successor fact linked via previousFactId
const successor = await facts.branch(fact.id, {
  textRefined: 'The Eiffel Tower is 330 meters tall including the antenna',
}, 'correction');
// 'correction' and 'contradiction' mark the predecessor as superseded

// Walk evolution: root -> current (via previousFactId)
const chain = await facts.getEvolutionChain(successor.id);
// Find highest-confidence leaf (via getSuccessors)
const latest = await facts.getLatestInChain(fact.id);
// Full tree (BFS with cycle detection)
const tree = await facts.getEvolutionTree(fact.id);

// Per-fact navigation: getPredecessor / getSuccessors / hasPredecessor
const previous = await successor.getPredecessor();
const successors = await fact.getSuccessors();
if (successor.hasPredecessor()) {
  // ...
}

// Entity briefing: all facts for a given entity
const briefing = await facts.getEntityBriefing('Place', placeId);
// { facts, totalCount, byType, byStatus }
```

## API

### Models

| Export | Description |
|--------|------------|
| `Fact` | Knowledge unit with `textRefined`, `type`, `status`, `confidence`, `previousFactId` for evolution chains (predecessor pointer; not a structural hierarchy edge), and auto-generated embeddings |
| `FactSource` | Provenance record with `sourceUrl`, `sourceType`, `credibility` (0-1), `extractedAt` |
| `FactSubject` | Polymorphic entity link (`entityType` + `entityId`), `conflictColumns: ['fact_id', 'entity_type', 'entity_id']` |
| `FactContent` | Join table linking facts to Content, `conflictColumns: ['fact_id', 'content_id', 'relationship']` |
| `FactTag` | Tag association for a fact |

### Collections

| Export | Description |
|--------|------------|
| `FactCollection` | Query by status/type/domain, `reconcile()`, `branch()`, evolution traversal, `recalculateConfidence()`, `getEntityBriefing()`, `findWithGlobals(tenantId)` |
| `FactSourceCollection` | Source management with `getForFact()` |
| `FactSubjectCollection` | Subject links with `getForFact()`, `getForEntity()` |
| `FactContentCollection` | Fact-to-content relationships |
| `FactTagCollection` | Fact tag management |

### Functions

| Export | Description |
|--------|------------|
| `calculateConfidence` | Weighted formula: base 0.5 + source volume (max 0.3) + credibility (0.2) + recency (0.1, decays over 10 days) + corroboration (0.1), clamped to [0, 1] |
| `normalizeText` | Trim, collapse whitespace, lowercase -- used for dedup comparison |

### Key Types

`FactType` (assertion/observation/measurement/definition/relationship/event/opinion/prediction), `FactStatus` (pending/active/disputed/superseded/archived/retracted), `EvolutionType` (original/correction/refinement/contradiction/extension/merge), `SubjectRole`, `ReconcileAction`, `ReconcileOptions`, `ReconcileResult`, `FactContentRelationship`, `EntityBriefing`

## Dependencies

- `@happyvertical/smrt-core` -- ORM, code generation, and semantic search
- `@happyvertical/smrt-tenancy` -- optional multi-tenant scoping with `findWithGlobals()`
- `@happyvertical/ai` -- AI disambiguation in reconciliation

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.

## Catalog pagination

`browseCatalog(query, { limit, offset, latestOnly, tenantId })` defaults to 25
results and resolves evolution chains unless `latestOnly: false` is supplied.
Empty-query browsing and successful semantic search hydrate only the requested
SQL page. Empty-query candidate eligibility remains bounded to
`offset + 2 * limit`; resolving and deduplicating chains can therefore return a
short page. Semantic candidate retrieval remains bounded to `offset + limit`.
These SQL windows use the requested pagination values rather than the collection
`defaultListLimit`. The full tenant-visible successor set is available to chain resolution, even
when a successor lies outside the candidate window or status filter. Implicit-scope
confidence ties retain the newest successor, matching the previous ordered read.

Without an explicit tenant, the default candidate status is `active`; with an
explicit tenant, tenant and global candidates exclude only `superseded`.
`includeSuperseded` removes that status filter. Active tenant context continues
to constrain implicit reads, and requesting another tenant is rejected. STI child
collections constrain both candidates and successors to their discriminator.

Catalog reads apply normal `beforeList` authorization predicates to candidates,
readiness checks, and the complete successor graph, including empty queries.
Explicit tenant/global reads use `withTenantGlobalRead`, which grants the built-in
tenancy list hook that narrow scope while business hooks keep the original user,
permissions, tenant context, and system/non-system identity. Actual system calls
remain system calls. Interceptor rejection and application SQL failures propagate
to the caller.
Only unavailable embedding configuration or query-embedding provider failure
permits text fallback; a semantic authorization failure never does.

When query embeddings are unavailable, text fallback matches the exact JavaScript
expression `` `${textRefined} ${textRaw}`.toLowerCase().includes(query.toLowerCase()) ``.
It uses persisted `catalogSearch` storage and the same bounded SQL page traversal.
The storage encodes lowercased UTF-16 units as aligned ASCII tokens, preserving
Unicode, whitespace, literal wildcard characters, and code-unit boundaries without
SQL collation or case-folding differences. A scalar readiness check precedes text
search; it throws with backfill instructions if any permitted row is unbackfilled.
The database may scan matching rows and evolution edges internally, but only the
requested Fact page crosses the database boundary. Arbitrary substring matching
cannot use a normal B-tree index; no misleading search-column index is added.

### Existing deployment migration

This is an explicit schema and data migration; ordinary reads never create schema.
Stop old application writers, deploy the new manifest/code, and run `smrt db:migrate`
(and `smrt db:status --parity`). This adds nullable `catalog_search`; historical
rows remain NULL. Before enabling catalog text reads, run the following with your
application's database configuration and repeat until `remaining` is zero:

```typescript
import { FactCollection } from '@happyvertical/smrt-facts';
import { withSystemContext } from '@happyvertical/smrt-tenancy';

const facts = await FactCollection.create({ db });
await withSystemContext(async () => {
  while ((await facts.backfillCatalogSearch(100)).remaining > 0) {
    // Each call is independently resumable; record progress in your job runner.
  }
});
```

Backfill requires explicit system context, processes at most 100 rows per call by
default (maximum 1000), and updates only NULL values whose source texts still match
the read snapshot. It changes no source text, timestamps, embeddings, or revisions.
A crash or concurrent write is safe to retry; sustained old writers must be stopped
so the operation can finish. A subtype collection backfills only its discriminator;
use the base collection for the full deployment. Back up before schema changes;
roll forward by rerunning migration/backfill rather than dropping historical data.

`Fact.save()`, collection create/get-or-insert/get-or-upsert, and generated model
updates maintain search storage from the source fields. `catalogSearch` is derived;
callers must not author it, and generated transport surfaces exclude it using
readonly/sensitive field metadata. Derivation uses the final persistence row after
mutable `beforeSave` hooks and the complete subclass `transformJSON` chain,
keeping persisted text and search storage consistent. If a custom transform omits
or returns `undefined` for either source column, the write retains its ordinary
adapter semantics (an existing value, a default, or NULL); search storage is
invalidated to NULL rather than guessed from instance values. Catalog text reads
then fail with the readiness error until privileged bounded backfill reads the
actual persisted columns. Run that backfill after such custom writes before
resuming catalog text reads. Explicit NULL source values remain known values.
Plain/public serialization
retains the saved marker instead of recomputing from pre-transform instance text.
Direct SQL writers must set `catalog_search = NULL` whenever either source text
changes, then run backfill before text reads resume.
If a custom writer or a pre-release implementation produced a known stale
non-NULL search value, explicitly set that affected row's `catalog_search` to
NULL and run the same bounded backfill. Backfill intentionally selects NULL
markers; it does not scan or repair non-NULL values. This is a targeted repair,
not an additional step for a fresh column migration.

Do not keep old application writers active after backfill: they cannot maintain
this new invariant. Future changes to JavaScript lowercasing/encoding require an
explicit new backfill; the format is not locale dependent.

PostgreSQL and SQLite run canonical pagination integration tests. DuckDB query
coverage uses an explicitly identified SQL-only fixture: canonical Fact schema
creation currently rejects its evolution self-reference, tracked in
[#2830](https://github.com/happyvertical/smrt/issues/2830). DuckDB hydration issues
one `DESCRIBE` plus one data query per page; PostgreSQL and SQLite use one data
query after semantic candidate retrieval, if any. Text fallback also performs one
scalar readiness query.
