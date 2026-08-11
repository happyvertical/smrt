# smrt-core/code generators

Module semantics for `src/generators/` + `src/vite-plugin/`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Code Generators

| Generator | Location | Output |
|-----------|----------|--------|
| REST API | `src/generators/rest.ts` | OpenAPI-compliant CRUD endpoints |
| CLI | `src/generators/cli.ts` | `objectname:action` admin commands — writable allowlist, exhaustive-include, `--from-file`, fail-closed tenant context |
| MCP Server | `src/generators/mcp.ts` | Model Context Protocol tools |
| Web collections | `src/vite-plugin/web-collections.ts` (selectors) + `generateWebModule` | `@happyvertical/smrt-virt-web` — one typed collection definition per API-exposed REST collection (#1761), consumed by `@happyvertical/smrt-web` |

Generated API clients share `selectApiClientEntries()` across the runtime Vite
module, its ambient declaration, and physical prebuild declarations. When a
collection class and its populated model share an endpoint, the model owns the
canonical collection key and row payload schema; the collection class remains
available under a deterministic class-derived secondary key. Selection and
collision suffixes must not depend on manifest insertion order (#2027).
For aggregated manifests, inheritance and item-type references resolve exact
qualified names first, then package-local simple names, then a stable identity
fallback so duplicate class names across packages cannot reintroduce ordering.

The web module also emits a build-time **`manifestHash`** constant (#1764): `computeWebManifestHash(manifest)` is a deterministic, replica-stable digest of the emitted web-collection SHAPE (name/className/endpoint/idField/actions/fields/relationships), canonicalized (recursive key sort) before `sha256 → base64url`, truncated to 16 chars — so the same schema always hashes the same, and a field add/remove/type-change/edge-change changes it. A change means old persisted client rows may mis-hydrate, so smrt-web keys its durable persistence namespace on it and its `updateAvailable` contract signal compares against it. Four co-managed emission sites must not drift: the runtime value (`generateWebModule`), the `@happyvertical/smrt-virt-web` ambient d.ts (`vite-plugin/index.ts`), the physical `@smrt/web` d.ts (`prebuild/index.ts`), and the hand-written type mirror in `@happyvertical/smrt-web` (`packages/smrt-web/src/index.ts` — dependency-free, so textual sync only).

Per-field web emission (#2046): `buildWebFieldDefinitions` carries `description` (from `@field({ description })`) and sanitized `ui` hints (from `@field({ ui: { basic, group, order, locked } })`, read off the manifest `_meta.ui` bag through per-key type guards) into each emitted field definition, and `buildWebToolDescriptors` threads the same `description` into browser MCP tool schemas. `sensitive`/`transient` fields are excluded from emission entirely, so their descriptions never ship. Both keys are conditional, so hint-less schemas emit byte-identical definitions (and hashes) as before; adding a description/ui hint changes the manifest hash — deliberate over-invalidation, harmless per the #1764 contract.

## Generated MCP server output language

`MCPGenerator` builds every file as TypeScript, so the requested `outputPath`
extension decides what is written (#2279). `.ts`/`.mts` targets keep the source
verbatim for `tsx` or Node type stripping — which is why the generated source
must stay erasable-syntax-only (no parameter properties, enums, or namespaces).
Every other target (`.smrt/mcp-server/index.js` by default) is transpiled to
JavaScript with the `typescript` dependency before writing, because the printed
run script and the generated `claude-config.example.json` both invoke it with
plain `node`. A `.cjs`/`.cts` target is rejected outright: generated servers are
ES modules. `src/generators/mcp-emit.ts` owns those decisions — do not
reintroduce a bare `writeFile` of generated source.

Modular output writes `config`, `tools/index`, and `handlers/index` with the
entry point's own extension, and emits the entry's relative import specifiers
with that same extension, so the files it imports both exist and load with the
same module semantics — an `.mjs` entry gets `.mjs` siblings, not `.js` ones a
CommonJS package would then parse as CommonJS. The entry is written at the
requested path rather than a hardcoded `index.js`.
Generated code also has to be valid in an ES module: `arguments` is not a legal
binding name there, however convenient it reads.

## Custom-action contract

`resolveCustomActionMetadata()` is the common discovery and invocation contract
for generated REST routes and API clients, MCP, CLI, WebMCP, and simple
REST-resource discovery. Receiver scope comes from the executable method, never a
configuration-only `api.routes[name].scope` override: instance model methods
are item-scoped and require `id`; static model methods and recognized
`SmrtCollection` methods are collection-scoped and do not accept `id`. Route
configuration may still choose its path and HTTP verb, but it cannot turn an
instance call into `ClassRef.action` or vice versa.

When scanner method metadata exists, discovery projects each named parameter
and its JSON-schema type, and invokers pass the values positionally in declared
order. The legacy single `options` bag remains compatible when metadata is
absent (or the declared method takes `options`). Do not infer this from runtime
function arity. An omitted typed `options` parameter remains `undefined`, so a
method's JavaScript default initializer continues to apply; an explicit `null`
remains `null`. Flat tool and CLI inputs reserve `id` for receiver parsing. If
an action declares an `id` parameter, its flat MCP/WebMCP field is `actionId`
(and CLI uses `--action-id`); REST keeps its independent path/body
namespaces. Typed CLI actions may use standard flag names such as `limit`,
`offset`, `where`, and `format` without those values being stripped as CRUD
flags.

Custom actions may return an explicit, domain-neutral failure object with
`ok: false`, `code`, and `message` plus optional `status`, `details`,
`retryable`, and `correlationId`. `normalizeCustomActionFailure()` redacts it;
generated REST returns `{ error: failure }` with the non-2xx status, while MCP
returns `isError: true` and `_meta['io.happyvertical/smrt']`. Opaque successful
objects (including `{ code, message }`) remain untouched; thrown exceptions are
not reclassified as domain failures.

Generated reads (`list`/`get`) on the REST and SvelteKit generators support conditional GET (helpers in `src/generators/conditional-get.ts`). ETag v2 (#1765): the validator is the table's change-feed version (`getTableVersion`) keyed by the request representation, so a **concrete** `If-None-Match` short-circuits into a 304 with an empty body **before** the collection query runs — an unchanged table revalidates with zero table scan. A wildcard `If-None-Match: *` is deferred until the payload builds (existence confirmed), so a missing item still returns 404, not a false 304. Tenant-scoped reads fold the active tenant into the representation (`resolveTenantEtagDiscriminator`) so one tenant's cached validator never satisfies another's read of the same URL. Routes whose GET renders via a **custom serializer** (which can load related tables the base-table version can't observe) keep the v1 body-hash ETag (`#1757`, query-first but correct); the default `toPublicJSON` path — all REST reads and non-serializer SvelteKit reads — uses v2. v2 is weakly consistent by design (the cost of not reading the data): a revalidation in the sub-statement window between a committed write and its feed append can return a stale 304 that self-heals on the next revalidation. The other v2 window — a deploy that changes the response shape WITHOUT a table write — is closed by the **#1764 ETag salt**: `computeTableVersionEtag(version, representation, manifestHash?)` folds the build's web-collection shape digest into the digest, so a shape-only redeploy busts every read validator (`undefined` reproduces the pre-#1764 unsalted value byte-for-byte for direct helper callers). The generated SvelteKit route bakes the digest in as a `MANIFEST_HASH` constant (via `generateConditionalGetRouteHelper`'s `manifestHash` option, sourced from `computeWebManifestHash(manifest)`) — automatic for the SvelteKit transport. The runtime `APIGenerator` auto-populates the same salt from the runtime registry with `computeRuntimeWebManifestHash()` when `APIConfig.manifestHash` is omitted; explicit `APIConfig.manifestHash` still wins for custom setups. The digest scope is get-OR-list (`selectWebEtagSaltEntries`), so **get-only** routes are salted too. Strong consistency still requires the v1 body-hash path. Cache-Control policy (unchanged from #1757): `private, no-cache` by default; public models may opt into shared caching via `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` → `public, max-age=0, s-maxage=<n>`; non-public models never emit shared-cache headers. Tenant-scoped models (any mode) never emit them either — bodies vary with session-cookie tenant context that URL-keyed shared caches cannot see; `sMaxage` is neutralized to `private, no-cache` with a one-time warning.
