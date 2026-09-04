# Decorators, build integration, and knowledge

Key options: `tableName`, `tableStrategy` ('cti'|'sti'), `conflictColumns`, `indexes` (declared multi-column indexes; see [schema-paths.md](schema-paths.md)), `api`/`mcp`/`cli` (generation config), `ai` (callable methods), `hooks` (beforeSave/afterSave/beforeDelete/afterDelete), `embeddings` (auto-generate), `tenantScoped`, `agent`, `ui` (`{ icon, label, description }` — nav/help hints round-tripped through the manifest as plain data; `description` is the object-level seed for form-level help, #2046).

Registration sets `SMRT_TABLE_NAME` static property (survives minification).

## @field() UI hints (#2046)

`@field({ ui: { basic, group, order, locked } })` — a static, presentation-only
seed for the field-policy rail (epic #2045). Carried in the manifest under the
field's `_meta.ui` (never a top-level `FieldDefinition` key), readable at
runtime via `getAllFields()` at `field._meta.ui`, and emitted (sanitized) with
`description` into generated web-collection definitions and browser MCP tool
schemas. No schema/persistence/security effect — `sensitive`/`readPermission`
stay the security rail, and `sensitive`/`transient` fields never emit to the
client at all.

## Domain Knowledge Artifacts

`smrtPlugin()` writes runtime manifests and agent/developer knowledge artifacts:

- local dev/build: `.smrt/manifest.json` and `.smrt/smrt-knowledge.json`
- package build: `dist/manifest.json` and `dist/smrt-knowledge.json`

Keep `manifest.json` runtime-focused. `smrt-knowledge.json` is the deterministic
agent contract for downstream review and architecture tools.

The schema-version-1 object projection is additive and high-signal: it retains
normalized tenant mode/field, explicit `cti`/`sti` strategy, conflict columns,
method signatures, and field defaults/constraints/readonly/transient flags.
Sensitive fields are removed before both `fields` and `relationships` are
derived, including legacy flags stored under `_meta`; matching field and
snake-case column names are also removed from projected conflict columns, and a
sensitive custom tenant field is omitted while retaining scope and mode.
Generated artifacts assert this boundary with `sensitiveFieldsExcluded: true`;
the optional marker keeps schema version 1 additive while letting readers
identify older artifacts that require raw-manifest corroboration.

Config precedence for knowledge is defaults → top-level `knowledge` in
`smrt.config.ts` → `packages[packageName].knowledge` → plugin option →
object-level `@smrt({ knowledge })`.

Object-level `knowledge: false` excludes an object from authored context only;
it must not change runtime manifest registration. Use
`knowledge: { tags, summary, risks }` for review-sensitive domain objects.

HTTP knowledge routes are disabled by default. If `knowledge.api.enabled` is
true, generated SvelteKit routes must stay GET-only and guarded by dev mode or
admin auth.


## Vite Plugin

```typescript
// vite.config.ts — required for @smrt() decorators (Vite 8+, oxc transform)
export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
});
```

Under Vite 8 the oxc transform does not honor the pre-Vite-8 `esbuild.tsconfigRaw`
recipe (or tsconfig `experimentalDecorators` reached through SvelteKit's
`extends "./.svelte-kit/tsconfig.json"` chain), so that recipe throws
`SyntaxError: Invalid or unexpected token` on the first SSR request. Configure
decorators through `oxc.decorator` instead. Consumers still pinned on vite<8 need
the legacy `esbuild.tsconfigRaw` form with `experimentalDecorators: true,
emitDecoratorMetadata: true`.

For independent CI invocations, both `smrtPlugin()` and `smrtConsumer()` accept
the same `generationSnapshot: { path, sha256, provenance, sourceRoot }`. The
schema-v1 snapshot produced by `serializeSmrtGenerationSnapshot()` contains the
merged project/dependency manifest, portable source paths, and source-file
digests; each plugin selects its own view. Reuse mode fails closed on
byte/provenance/path/content drift, skips scans and manifest writes, and still
generates routes, types, registration, and virtual modules. Omit it for normal
local development and watch mode.
