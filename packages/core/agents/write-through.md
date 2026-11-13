# Inline linked-record writes

`@smrt({ writeThrough: { profileId: { fields: ['name', 'email'] } } })`
exposes target fields as virtual inputs on the source model. The source must declare
an ordinary `foreignKey`/`crossPackageRef`. Names cannot collide with source fields,
identity/tenant fields or `createType`; targets must be public writable scalars.
Sensitive, transient, read-only and read-permission-gated target fields fail closed.

The declaration travels in the manifest as `writeThroughFields`, generated web
field definitions as `writeThrough: '<link field>'`, and generated MCP/assistant/CLI
input schemas. These inputs never become source-table columns. Existing public
`createType` dispatch is unchanged. `createType` inside a write-through declaration
is an optional server-authored target subtype, validated against the linked root.

Ordinary `SmrtObject.save()` owns the transaction. Source `beforeSave` establishes
tenancy; target collection/model writes, owning virtual-field adapter writes and
source persistence share that transaction's database handle. Failure rolls back
all rows. Target point reads, projection-field checks, beforeList scope and normal
save/write guards still apply. Inline mutation requires the exact same tenant,
including null ownership. An existing selection and inline edits are mutually
exclusive during create/relink, so stale form values cannot rename another person.
Bare legacy links retain their existing contract; these rules protect inline edits.
Blank scalar and virtual inputs preserve the selected target during create or
relink. Clearing an inline field remains intentional when keeping the current link.

The owning source model can implement `writeThroughDefaults()`,
`readWriteThroughVirtual()` and `saveWriteThroughVirtual()` for declared
`virtualFields`. The default virtual writer refuses unsupported input. Commerce
Customer uses ProfileTypeCollection's tenant-owned person classification API and
Profile's existing metafield/metadata API for phone; Profile has no phone column.
No authentication identity is minted or inferred from email.

Web `get` reads hydrate inline values only when the existing `displayLabel` option
is requested. List labels stay a single scoped SQL projection, with no N+1 linked
loads. Plain programmatic reads remain independent of optional target storage.

## Display-only string references and lists

For an existing plain string reference, `display.references: { skuId:
'@happyvertical/smrt-products:Sku' }` may declare the target of a read-only
`display.label` projection. The source must be a public text field; the existing
projection validates the target scalar and applies its beforeList/STI and exact
ownership predicates. The join casts the target id to text, so opaque external
strings safely fall back rather than being cast to UUID. This changes no column,
FK, migration or write validation. StockLevel/StockMovement use this to show SKU
names while preserving their established string-reference storage contract.

`display.list` declares default list fields after the display label. Generated web
definitions carry `listFields`. Shared screens retain policy exclusions, choose
human labels first, and exclude internal hashes, JSON, authority/provenance and
plain id columns. References render through the existing named reference sources.

## Behavior/test matrix

| Behavior / reachable trigger | Positive / failure control | Actor, executor and contract | Evidence |
| --- | --- | --- | --- |
| Customer create / edit | Typed name/email/phone; linked name changes; parent create/edit failure rolls back target and phone | Tenant A; existing collection save transaction; SQLite; REST/MCP/assistant/CLI | commerce customer-write-through; template cookbookHost; CLI writable-policy |
| Existing selection / relink | Existing id creates no extra contact; ambiguous inline edits refuse without changing either contact | Same tenant versus other tenant; server model layer; SQLite | commerce customer-write-through; screen values |
| Declared fields | Public scalar allowed; sensitive/read-only/transient/gated/reserved/colliding names refused | Trusted package metadata, untrusted values; no SQL | core write-through-metadata |
| Read projection | String reference name, missing target fallback, other tenant and hidden target refused; no column type change | Target beforeList + exact ownership; SQLite; existing DuckDB projection suites retained | core display-label-projection; four cookbook default-column canaries |
| Shared forms and vocabulary | Basic required/primary inputs; empty forms become a notice; cookbook singular and reference labels | Browser form and cookbook policy; transport-neutral | smrt-svelte fields, values, EditForm, RecipeScreens, cookbook build |
| Assistant shell | One authenticated dock; recipe cannot mount an unbound second dock | Browser shell; no model writes | CookbookApp test fails before fix; built Playwright reproduction |
| Setup / status | Desktop reopen guidance, real CLI commands with stop-before-recover; unconfigured status is HTTP 200 | Server-selected launch mode; no secret serialized | app-runtime sveltekit; OwnerSetupForm; connect-ai server |

New atomic inline writes are exercised on in-process SQLite and native DuckDB;
the Customer phone adapter is exercised on SQLite. External PostgreSQL
was not started; no containers were used. The SQL projection and existing database
regression suites remain required; do not infer external-dialect coverage from
SQLite results.

## Reuse check

Read `docs/knowledge/intents/index.md`; ran smrt-dev-mcp `review-smrt-project` on
core, commerce, smrt-svelte, chat, types, app-runtime, template-sveltekit, CLI,
inventory, smrt-web and planner, and `build-context` architecture for linked create/edit,
Customer with Profile, list fields, singular labels and unconfigured status.
The configured server offers context/introspection rather than separate component
search APIs. Used `rg` by name and purpose across smrt-ui, smrt-svelte, chat, core,
commerce, profiles and users for `writeThrough`, `inline.*field`,
`createWithProfile`, `create.*Profile`, display/list metadata and singularization.

The sole new production file, `src/write-through.ts`, validates one declarative
contract shared by scanner and registry; no equivalent inline write capability
existed. Persistence extends existing `save`, `withTransaction`, registry target
resolution and collection APIs. Phone reuses Profile metadata; person classification
reuses ProfileTypeCollection. The existing host test that separately creates a
Profile then Customer remains intact alongside the new one-call regression.
No production component, route or tool file was added. New test files contain only
fixtures/assertions and reuse the established scanner, test database and screen
harnesses. Hindsight recall was attempted but the configured service was offline.
