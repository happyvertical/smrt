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

The web module also emits a build-time **`manifestHash`** constant (#1764): `computeWebManifestHash(manifest)` is a deterministic, replica-stable digest of the emitted web-collection SHAPE (name/className/endpoint/idField/actions/fields/relationships), canonicalized (recursive key sort) before `sha256 → base64url`, truncated to 16 chars — so the same schema always hashes the same, and a field add/remove/type-change/edge-change changes it. A change means old persisted client rows may mis-hydrate, so smrt-web keys its durable persistence namespace on it and its `updateAvailable` contract signal compares against it. Three emission sites must not drift: the runtime value (`generateWebModule`), the `@happyvertical/smrt-virt-web` ambient d.ts (`vite-plugin/index.ts`), and the physical `@smrt/web` d.ts (`prebuild/index.ts`).

Generated reads (`list`/`get`) on the REST and SvelteKit generators support conditional GET (helpers in `src/generators/conditional-get.ts`). ETag v2 (#1765): the validator is the table's change-feed version (`getTableVersion`) keyed by the request representation, so a **concrete** `If-None-Match` short-circuits into a 304 with an empty body **before** the collection query runs — an unchanged table revalidates with zero table scan. A wildcard `If-None-Match: *` is deferred until the payload builds (existence confirmed), so a missing item still returns 404, not a false 304. Tenant-scoped reads fold the active tenant into the representation (`resolveTenantEtagDiscriminator`) so one tenant's cached validator never satisfies another's read of the same URL. Routes whose GET renders via a **custom serializer** (which can load related tables the base-table version can't observe) keep the v1 body-hash ETag (`#1757`, query-first but correct); the default `toPublicJSON` path — all REST reads and non-serializer SvelteKit reads — uses v2. v2 is weakly consistent by design (the cost of not reading the data): a revalidation in the sub-statement window between a committed write and its feed append can return a stale 304 that self-heals on the next revalidation. The other v2 window — a deploy that changes the response shape WITHOUT a table write — is closed by the **#1764 ETag salt**: `computeTableVersionEtag(version, representation, manifestHash?)` folds the build's web-collection shape digest into the digest, so a shape-only redeploy busts every read validator (`undefined` reproduces the pre-#1764 unsalted value byte-for-byte for direct helper callers). The generated SvelteKit route bakes the digest in as a `MANIFEST_HASH` constant (via `generateConditionalGetRouteHelper`'s `manifestHash` option, sourced from `computeWebManifestHash(manifest)`) — automatic for the SvelteKit transport. The runtime `APIGenerator` auto-populates the same salt from the runtime registry with `computeRuntimeWebManifestHash()` when `APIConfig.manifestHash` is omitted; explicit `APIConfig.manifestHash` still wins for custom setups. The digest scope is get-OR-list (`selectWebEtagSaltEntries`), so **get-only** routes are salted too. Strong consistency still requires the v1 body-hash path. Cache-Control policy (unchanged from #1757): `private, no-cache` by default; public models may opt into shared caching via `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` → `public, max-age=0, s-maxage=<n>`; non-public models never emit shared-cache headers. Tenant-scoped models (any mode) never emit them either — bodies vary with session-cookie tenant context that URL-keyed shared caches cannot see; `sMaxage` is neutralized to `private, no-cache` with a one-time warning.
