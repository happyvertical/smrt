<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Transport kernel (#5158)

Generated REST routes, MCP tools, the sync/apply contract, CLI commands and the
chat tool loop all answer the same questions for every request: which model is
this, who is asking, may they, what may they send, which rows may they see, and
what do they get back. `src/transport/` is the one place those questions are
answered. `src/error-contract.ts` is the one table that says what a failure
looks like to a caller.

**Status: scaffold.** The types, the legacy profiles and the error contract are
real. Every kernel function exists with its final signature and throws
`TransportNotImplementedError`. No transport calls the kernel and no transport
consults the error contract; `transport/__tests__/scaffold.test.ts` fails if
any package imports the kernel before it is implemented.

## Entry points

| Subpath | Source | Audience |
|---|---|---|
| `@happyvertical/smrt-core/transport` | `src/transport.ts` | Server only. Not exported from the root or the browser entry. |
| `@happyvertical/smrt-core/error-contract` | `src/error-contract.ts` | Everyone. Imports nothing; also re-exported from the root and browser entries. |

`error-contract.ts` must stay import-free, like `smrt-error.ts`: browser code
and sibling packages read it without loading the registry.

## Files

One file per concern, so two changes to different behaviours never edit the
same file. The owner column names the step of the migration plan that fills the
file in.

| File | Concern | Owner |
|---|---|---|
| `types.ts` | Vocabulary: `Surface`, `CrudOperation`, `Principal`, `OperationDescriptor`, `TransportModel`, `TransportBinding`, `TransportProfile`, inputs and results | K0, then K7 |
| `profile.ts` | Legacy profiles: how each transport behaves today, as data | K0 |
| `not-implemented.ts` | The placeholder failure | K0 |
| `errors.ts` | `toTransportError` | K1 |
| `model.ts` | `resolveTransportModel`, `resolveCollectionSegment` | K2 |
| `principal.ts` | `principalFromLocals`, `principalFromContext`, `principalFromEnv` | K2 |
| `authorize.ts` | `describeOperation`, `authorizeOperation` | K2 |
| `input.ts` | `resolveWritableFields`, `filterWriteInput`, `applyWriteInput` | K3 |
| `query.ts` | `parseListQuery` | K4 |
| `tenant.ts` | `runInTenantGate` | K5 |
| `project.ts` | `toPublic` | K6 |
| `operations.ts` | `executeOperation`, the pipeline | K7 |
| `http.ts` | `createHttpHandlers`, `readJsonBody` | K7 |
| `mcp.ts` | `createMcpToolRuntime`, `validateToolArguments` | K7 |
| `sync.ts` | `createSyncApplyHost` | K7 |

Each stub's doc comment is the contract its owner has to meet. Change a
signature in the stub's own pull request only when the code it has to replace
cannot be expressed otherwise, and say so there.

## Pipeline order

`executeOperation()` runs these steps in this order on every surface. The order
is part of the contract: nothing is read from storage before step 3 passes and
nothing is written before step 4 passes.

1. Resolve the model.
2. Check that the model is exposed on the surface and the operation is enabled.
3. Authorise the caller for the operation.
4. Validate the input: the write filter, or the list query.
5. Enter the tenant gate. Everything below runs inside it.
6. For a create, resolve the STI target and authorise again against it.
7. Call the collection, obtained from the binding at this point and not before.
8. Project the result for the caller, custom serialisers included.

Errors leave as thrown values. The adapter (`http.ts`, `mcp.ts`, `sync.ts`)
renders them through `toTransportError`, and renders the neutral
`OperationResult` into its own envelope. Adapters decide envelopes and nothing
else.

## Principal

A `Principal` is built once per request from state the host controls: SvelteKit
`locals`, a generator's construction context, or the environment of an emitted
stdio server. Bodies, query strings and tool arguments are never an identity
source.

`permissions` (operation slugs, or `'all'` when the host has already authorised
the call) and `fieldPermissions` (slugs for `@field({ readPermission })`) are
separate on purpose. No transport derives them from the same source today, and
`'all'` never implies a field grant.

## Legacy profiles

A `TransportProfile` records how one transport behaves today for each of the
eleven behaviours the kernel takes over: write filter and serialisation, create
semantics, filter/sort/count, tenant context, errors, authorisation, lookup, the
STI create target, argument validation, result shapes and the request body.
`profile.ts` holds one table per behaviour with a row per transport
(`rest-runtime`, `sveltekit-emitted`, `mcp-inprocess`, `mcp-emitted-single`,
`mcp-emitted-modular`, `sync-runtime`, `sync-emitted`, `cli`,
`chat-tool-loop`), assembled into `LEGACY_PROFILES` and the named exports
(`LEGACY_REST`, `LEGACY_SVELTEKIT`, `LEGACY_MCP`, ...).

How a profile is used:

- A transport moves onto the kernel by passing its profile in
  `TransportBinding.profile`. `resolveTransportModel()` carries it on
  `TransportModel.profile`, so every kernel function that takes the model sees
  it. The two that take no model (`toTransportError`, and `toPublic` without
  one) accept it through their options.
- **A section that is present selects the legacy behaviour its data describes.
  A section that is absent selects the kernel contract.** A kernel module that
  does not implement the selected behaviour throws; it never guesses.
- A move onto the kernel therefore changes nothing a caller can observe. The
  contract-test harness that arrives with the pipeline pins each transport's
  wire output while it moves.
- Every cell was read off the transport's source.
  `transport/__tests__/profile-source-pins.test.ts` names the lines each group
  of cells rests on and fails when they change. If a transport is edited before
  it has moved, re-read it, correct the profile, then update the pin.

## The rule for contract changes

**A change to what a generated transport accepts, refuses or returns is made in
`src/transport/` (or `src/error-contract.ts`) and nowhere else.**

- To change one behaviour, delete its table from `profile.ts`, its section from
  `TransportProfile`, and the branch in the owning kernel file that read it.
  That is the whole change: every transport gets the new behaviour at once.
- Do not add a rule to `generators/rest.ts`, `generators/mcp.ts`,
  `vite-plugin/sveltekit-generator.ts`, `sync/apply.ts`, the CLI generator or
  the chat tool loop. Those keep routing, schemas, catalogues and wire
  envelopes; they do not decide access, input or output.
- Do not add a profile section to preserve a new difference between
  transports. Profiles only shrink.
- A new operation or surface is added to `TRANSPORT_OPERATIONS` or
  `TRANSPORT_SURFACES`. The contract matrix enumerates both, so every cell then
  has to be decided before the suite passes.

## Error contract

`ERROR_CONTRACT` maps every error code this package can raise, and the kernel's
own codes (`TRANSPORT_ERROR_CODES`), to an HTTP status and a public text. Each
entry says how the text is chosen: `fixed`, the error's `own` public message,
the offending `field` name when the caller may read that field, or `opaque`
(generic text plus a server-created reference).

- Matching is by the string `code`, never `instanceof`, so a second copy of the
  package and plain errors that carry a `code` get the same answer.
- There are no prefix rules. `src/__tests__/error-contract.test.ts` scans the
  sources and fails when a code has no entry, and when an entry names a code
  nothing raises. Adding a code means deciding here what a caller is told.
- Sibling packages add their codes with `registerErrorCodes()`. The registry
  lives on `globalThis[Symbol.for('smrt.errorContract')]`. Repeating an
  identical entry is accepted; a conflicting one, or one that redefines a code
  of this package, is refused.
- `publicError(status, code, message)` builds an error that is safe to return.
  It carries `status`, `code` and `publicMessage`, which the current HTTP and
  MCP renderers already understand, and a brand (`isPublicError`) that works
  across copies of the package.
- The table adds nothing to existing errors. `RuntimeError` with
  `RUNTIME_REVISION_CONFLICT` is unchanged, and `isUniqueViolationError` still
  reads the cause chain.

Codes for AI runs, usage and inference (`AI_RUN_*`, `AI_UNAVAILABLE`,
`AI_CALL_LIMIT`, `INFERENCE_TARGET_UNBOUND` and their neighbours) are `opaque`
500 until their owners choose a public answer.

## Settled before the modules exist

`transport/__tests__/input-and-where-shapes.test.ts` holds both.

**Transient fields and the create path.** A field declared
`@field({ transient: true })` is in `ObjectRegistry.getAllFields()`, so
`collection.create()` assigns a value passed for it to the new instance. It has
no column, and `toJSON()`, `toPublicJSON()` and `JSON.stringify()` omit it on a
new instance, after `get()`, after `list()` and after an update. A declared
input field therefore needs nothing new below the transport. A relationship
accessor (`@oneToMany`, `@manyToMany`) is transient too and takes create input
the same way, which is why the writable set is declared per field and is never
"every transient field". Two paths can still add keys to serialised output:
a `transformJSON()` override and write-through reads.

**The shape of a list `where`.** `list()`, `count()` and facets accept
`SmrtListWhereClause`: one record, whose keys are ANDed, or a DNF array
`Record[][]` whose outer array is ORed and whose inner arrays are ANDed.
`get()` accepts a record only. The collection validates the keys of every
branch and refuses an empty outer array or an empty branch. `parseListQuery()`
has to walk every branch for the same reason. Today MCP tools and the CLI pass
a DNF array through; REST query strings and the chat tool loop can only produce
a record.

## Validation

```bash
pnpm --filter @happyvertical/smrt-core test
pnpm --filter @happyvertical/smrt-core typecheck
pnpm --filter @happyvertical/smrt-core build
node scripts/check-new-surface.mjs
pnpm check:node-roots
node scripts/verify-packed-vite-peer.mjs
```

`transport/__tests__/transport-packed-consumer.test.ts` installs the packed
package in a clean consumer and checks that both subpaths resolve inside one
copy of it, that the built error contract still imports nothing, and that the
declarations compile under `--strict`.
