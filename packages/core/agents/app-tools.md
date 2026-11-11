# Tools for a person's fields and lists (C6)

The existing `@happyvertical/smrt-core/cookbook/tools` entry owns these tools.
`createCookbookToolService({modelEditorFor, ...})` opts into customization;
there is no second tool registry, assistant executor or approval authority.
`modelEditorFor(context)` returns the authenticated tenant's awaited
`createAppModelEditor()` result, or null when unavailable. Never reuse one
editor across unrelated tenants/app registries. Install once with
`setCookbookToolService(service)` as for recipe tools.

| Tool | Input and effect |
| --- | --- |
| `app.describe({})` | Current enabled lists with cookbook labels/icons, human field labels, `origin: yours/pre-built`, hidden flags, choices/targets, and editor `revision`. |
| `app.addField({list,label,kind,expectedRevision,...})` | Derive a safe internal name from the label. Kinds: `text`, `long text`, `number` (finite decimal), `money`, `date`, `date-time`, `yes/no`, `choice`, `link`. Money needs `currency`; choice needs `options`; link needs `linkTo` (a live list label). |
| `app.renameField({list,field,label,expectedRevision})` | Relabel through cookbook policies; storage name/data stay stable. |
| `app.hideField` / `app.showField` | `{list,field,expectedRevision}` changes existing policy visibility. |
| `app.removeField` | Same input, plus optional approval id; hide and retain data, including money companions. Always requires durable approval. |
| `app.addList({label,fields,nameField,iconMeaning?,expectedRevision})` | `fields` are `{label,kind,options?,currency?,linkTo?}`. `nameField` is a human field label. One atomic editor revision includes field labels and display-field metadata. |
| `app.renameList({list,label,iconMeaning?,expectedRevision})` | Rename a pre-built or custom list through the cookbook; refresh all its keyed navigation entries and published presentation metadata. |
| `app.removeList({list,expectedRevision,approvalId?})` | Remove a custom list's feature, retaining its table/data; always requires approval. Pre-built lists retain their recipe ownership: use `recipes.disable` for those. |
| `app.undo({expectedRevision,approvalId?})` | Compensate the latest not-yet-undone edit; always requires approval because undo can hide a list/field. Return its persisted human caption and structured change/revision. |
| `app.history({})` | Durable journal changes, actor, revision, status, caption and undo provenance. |

Writes accept `approvalId?`. Re-invoke the exact arguments after the owner's
existing approval UI decides the hold. Destructive approval cannot be waived
by `requiresApproval`; that hook can require approval for additional writes.
Holds bind actor, tenant, arguments, exact editor revision/cookbook and resolved
edit, are consumed once, and record completion. Revoked authority and stale
approvals refuse. `expectedRevision` is the app revision from `app.describe`,
read the recipe revision from recipe results when using recipe tools.

Results contain one short `summary` plus structured data. A list reference
matches its current cookbook/navigation label, normalized singular/plural and
optional “the … list”, then installed recipe synonyms. Class names are not a
fallback. Qualified ids from a structured candidate can disambiguate; people
are never asked to supply identifiers. Ambiguity/missing matches return
`status: clarification_required` with up to eight labeled candidates; duplicate
field/list names return `status: collision`. Both leave history unchanged.
Missing money currency/choice options also return structured clarification.
Internal identifiers use bounded ASCII camel/Pascal names, accent normalization,
a stable hash for non-ASCII-only labels, and safe prefixes for reserved/numeric
names. The editor remains authoritative for inherited methods, physical storage
and model collisions; such validation failures refuse before journal mutation.

Icons are chosen deterministically from the existing shell section picker
names by `iconMeaning` or the list label (people → users, payments → receipt,
appointments → calendar, inventory → package, repair → wrench, etc.; fallback
folder). Core owns no icon paths and imports no UI package.

## One durable cookbook and live publication

When `modelEditorFor` returns an editor, recipe writes also use that editor's
`import` operation. Its journal becomes the sole durable cookbook authority;
`options.commit` remains the legacy recipe-only storage path and is not called
in this mode. The editor's awaited `publish(snapshot)` must replace the host's
engine pointer and manifest/web-definition store before returning. Restore the
engine with a monotonic revision (normally `snapshot.revision`); do not reset
it to zero on each publication. For example:

```ts
engine = createCookbookEngine({catalog, state: {
  version: 1, revision: snapshot.revision, applied: null,
  cookbook: snapshot.cookbook, journal: [],
}});
```

The durable editor history replaces the in-memory engine journal in this mode;
`applied` is optional presentation metadata, not a second durable cookbook. Checkpoint
publication is part of the editor's pending/recovery protocol, not a second
commit. Do not independently mutate the engine or journal. A stale/mismatched
host publication refuses rather than overwriting another cookbook.

The editor exposes its read-only `database` binding so generated transports
reuse the same connection, including in-memory SQLite. Its web definitions now
include cookbook `label`, `icon`, app `fieldPolicies` and `customFields` provenance
(including archived fields retained after undo); feed those into the
host's existing screen policy rail. They supplement the existing field and
relationship definitions. Publish the cookbook as well so recipe screens and
navigation see the same labels. Stable class/route/tool identifiers remain
internal; presentation labels change without breaking stored references.

MCP and assistant schemas/execution still come from this one service:

- In-process `MCPGenerator` lists and dispatches all registered server tools.
- Emitted single-file and modular servers call `service.modelTools(context)`
  when an editor is installed. It creates the normal live `MCPGenerator` scoped
  to the app's enabled lists, using the editor database and trusted environment
  identity/permissions. New lists and refreshed field schemas need no rebuild;
  built-in task actions keep their existing generated task handler.
- Assistant hosts keep `extraTools: context => service.assistantTools(...)`
  and their normal persona allow-list. Execution rechecks the principal's
  allow-list and operation, then uses the principal's actual tenant/user.
- The existing editor/exposure notifications produce `tools/list_changed`.
  Each request regenerates its own tenant catalog; notifications contain no
  tenant data. Generated host caches remain private with zero TTL.

All `app.*` tools, including reads/history, require live owner membership,
operation permission, a tenant/user, an available engine and an editor.
They are independent of the pre-built preference. Keep general host predicates
on the runtime exposure gate authoritative: a preference-only predicate should
allow exact cookbook custom-list identities and gate pre-built models, e.g.
`prebuilt.isEnabled(tenantId) || currentCustomLists(tenantId).has(model.qualifiedName)`.
Never bypass an unrelated authorization predicate to implement this preference.

The editor journal is the durable actor/change audit. The required host audit
sink records `requested` before editor writes (and must succeed), reads,
clarifications/collisions, holds and refusals with transport identity. Applied
versus pending comes from the durable journal; a failed publication can leave
additive DDL with a pending revision and closed models. It does not claim
rollback of committed schema changes. Reopening the editor recovers through
its existing protocol. Owner/permission checks run again after audit/approval
awaits, and journal CAS serializes competing revisions.

## Test design and evidence

Executor: the real editor/migration tracker and approval authority on in-process
SQLite, with an upstream provider and its effective app subclass. Every row is
an integration test unless identified as a generated-boundary test. Commands:
core `pnpm test` / `pnpm typecheck`; focused development uses
`pnpm exec vitest run src/cookbook/app-tools.test.ts src/cookbook/tools.test.ts
src/generators/mcp-emit.test.ts src/schema/schema-path-parity.test.ts
src/__tests__/app-model-editor.test.ts src/__tests__/runtime-model.test.ts`.

| Behavior / reachable trigger | Positive | Failure control | Actor / external edge |
| --- | --- | --- | --- |
| Every app tool / invoke or generated call | Labels, each kind, create/rename/hide/show/remove/history/undo | Unknown kind, extra tenant argument, missing choice/currency, stale revision | Owner; shared JSON schemas and sentence/structured result |
| Human resolution / customer-list utterance | Cookbook label, synonym, singular/plural, safe numeric/reserved names | Two list/field labels; existing/storage-name collision; no partial list | Owner; candidate arrays, no person-authored identifier |
| Live publication / field or list edit | Warm MCP catalog updates; REST create; web field/policy/list labels; cookbook navigation | Removed REST route denied, data retained; approval holds leave revisions unchanged | Owner; normal REST/MCP/web projection, SQLite journal |
| Money and links / normal record creation | SQLite integer minor units, currency defaults after metadata refresh; reference resolves named row with declared display field | Fractional money refused; existing editor tests cover cross-tenant links | Tenant owner; owning collection and tenancy interceptor |
| Durable approvals / remove or undo | Reopen authority over SQLite, approve, apply; persisted caption identifies undone change | Pending, tampered args, revoked owner, stale revision refused | Owner × action × tenant; single-use authority binding |
| Authority / list and retained call | Owner allowed, app tools remain with pre-built parts off | Non-owner, wrong tenant/user, missing identity, permission denial; revocation during audit | MCP identity and structural assistant PrincipalTool contract |
| Concurrency / two writes at same revision | Exactly one applied revision | Other request refuses without duplicate effect; audit failure prevents writes | Same owner/tenant; editor queue and journal CAS |
| Generated servers / tools/list and call | Single-file/modular entries delegate live schema and CRUD execution | Legacy no-editor path remains covered by existing emit tests | Plain Node; boundary stubs + real shared-generator SQLite test |

SQLite is the supported editor backend. This slice does not validate desktop
screens, live LLM conversations, network MCP transport, or PostgreSQL/DuckDB
editor activation. Static SvelteKit hosts still need the documented dynamic
REST catch-all and publication binding; tools do not rewrite route source.

## Reuse check and shared files

Before implementation: smrt-dev-mcp `review-smrt-project` on core and
`build-context` architecture query for “app model editor, cookbook tool service,
human label/synonym list resolution, identifier derivation and semantic icon
selection”; read `docs/knowledge/intents/index.md`. The available server has no
component/model/recipe search-list endpoints; `rg` searched core, chat, smrt-ui
and smrt-svelte by those names and by purpose (customization, human labels,
identifiers, synonyms, icon selection, display labels). Reused editor/history,
cookbook nav/model catalog/policies/naming validation, normal MCP/REST
projections, structural assistant PrincipalTool seam and durable owner approvals.

New implementation file `src/cookbook/app-tool-edits.ts` only adapts human input
and live descriptions to existing editor commands. No existing resolver derived
safe editable names from human labels or returned structured list ambiguity.
It uses the existing shell picker names rather than another icon set.
`src/cookbook/app-tools.test.ts` introduces test fixtures only, no application
model/component/helper API. No new UI components or product models.

Shared files: `cookbook/{tools,model-editor}.ts`, `generators/{mcp,mcp-runtime-template}.ts`,
`registry/class-registration.ts`, and `schema/generator.ts`. Changes stay in core.
The small schema-requiredness fix is a separate drive-by commit: the registry
schema path ignored top-level `required`, producing a nullable tenant column
that normal migration parity refused. C6 also fixes provider-qualified MCP
scope selection after app replacement and synthesized runtime field defaults,
including money currency after additive refresh.

## Integration rebase interactions

Tool names and their types now live in the browser-safe `cookbook/index.ts`;
`cookbook/tools` only re-exports that metadata and adds the server executor.
The app edit adapter imports its name type only. Preferences can register all
app permissions without reaching crypto, the model editor or MCP generation.
The existing published-dist preference/browser boundary test covers this edge.

Runtime edit and transport lookup deliberately use `getClass`/effective
identity resolution. Exact inspection through `getClassByQualifiedName` or
`getClassInPackage` must still report the replaced provider absent; retained
provider declarations supply ancestry, not another public registration.
C6's interaction fixture tests both contracts, STI base versus explicit Bot
creation after adding a field, and the actual recipe picker source/record-label
projection. A composed activation/cookbook gate admits a newly edited custom
list only after publication, closes it on removal and reopens it on undo,
including when the preference hides pre-built models.

Chat's generic approval bridge also recognizes destructive extra-tool names.
For service-owned cookbook tools, configure the host's
`approvalPolicy.tools[slug] = false` to avoid an outer generic hold; this does
not waive the app service's required approval. The host owner-approval UI must
decide the service's returned id and re-invoke the exact original arguments
with `approvalId`. Generic chat decision routes require their own thread/driver
execution envelope and cannot resume a service-owned id. Conversely, the app
service refuses a generic chat id because its action/state binding differs.
The interaction test uses the real chat policy/bridge and the same SQLite
owner authority, verifies this refusal, then applies the correct single-use
service approval. Automatic adoption of these holds into chat's generic
thread-decision endpoint is not implemented here; host UI wiring remains the
existing service integration contract rather than an approval bypass.

Prerequisite-only recipe models remain in `coveredModels` for activation, schema and
framework tools. `app.describe` and list-name resolution require an explicit recipe
navigation entry or cookbook feature placement; they never invent a user-facing
list from a raw class name. Hiding a layout entry does not revoke framework access.
The app-tool regression covers implicit identity and explicit placement separately.
