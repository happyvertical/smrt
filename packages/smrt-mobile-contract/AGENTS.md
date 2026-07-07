# @happyvertical/smrt-mobile-contract

TypeScript codegen bridging the SMRT manifest to the KMP mobile foundation
(ADR 0001, epic #1745). Generalizes amaru's `amaru-mobile-contract`
(manifest → allowlist → contract → Kotlin) and reporter's Swift emission.
Zero *external* runtime dependencies by design — it reads `manifest.json`
files directly. It is a leaf that other smrt packages may depend ON (e.g.
`@happyvertical/smrt-users` imports the server wire types below); it never
depends on another smrt package, so the DAG stays acyclic.

## Generation surfaces

1. **Framework contract** (`frameworkKotlinFiles()` / `frameworkSwiftFiles()`)
   — the stable files checked into `@happyvertical/smrt-mobile` under
   `src/commonMain/kotlin/.../contract/` (support types, pack localization,
   `/api/mobile/*` auth/session/device DTOs). This package is their single
   source of truth: `pnpm generate:framework` rewrites them; `pnpm build`
   verifies freshness (`scripts/generate-framework.mjs`). (The script is
   deliberately NOT named `generate` — turbo's `build` task auto-runs a
   `generate` script, which would rewrite the files on every build and
   neutralize the freshness gate.) The Swift mirror
   (`MobileContract.swift`) is emitted on demand for SwiftUI apps and is not
   checked into smrt-mobile (iOS wiring is Phase 6).
2. **Per-app domain DTOs** (`buildMobileContract()` +
   `generateKotlinDtoFiles()` / `generateSwiftDtoFile()`) — consumer apps
   pass their SMRT `manifest.json`(s) plus an object allowlist and a Kotlin
   package; they get `@Serializable` Kotlin DTOs (defaults on every field for
   safe partial deserialization) and plain Swift structs. Type mapping is
   driven by manifest field `type` metadata (`text`/`integer`/`decimal`/
   `boolean`/`datetime`/`foreignKey`/`crossPackageRef`/`json`), with amaru's
   name heuristics only as a fallback for typeless fields. Relationship
   declarations (`oneToMany`/`manyToMany`/`hasMany`) are excluded — they are
   not scalar columns. Field defaults come from `default` (current manifests)
   with `defaultValue` (amaru-era) as fallback. Decimals emit as
   `DecimalString` (string-encoded — no float precision loss); field names
   stay manifest-faithful (wire-format names, including `created_at`).
3. **Server wire types** (`framework-types.ts`) — the TypeScript mirror of
   the `/api/mobile` auth+session DTOs, imported by the SMRT-shipped server
   handlers (`@happyvertical/smrt-users` `MobileAuthService`, #1748) so the
   wire contract has one owning package across Kotlin, Swift, AND TypeScript.
   Each interface has a compile-checked `MobileWireShape<T>` descriptor, and
   `__tests__/framework-auth-types.test.ts` parses the Kotlin literal from
   surface 1 and asserts field-for-field parity — editing either side alone
   fails the suite.

## Conventions

- `DecimalString`/`Measurement` and the auth contract types are imported from
  `com.happyvertical.smrt.mobile.contract`, never re-emitted per app.
- Allowlist entries may be short names or qualified names
  (`@scope/pkg:Object`); ambiguous short names across manifests are an error.
- `sourceHash` (sha256 over allowlist + projected objects) is stamped into
  generated output so drift is detectable.
- `turbo.json` here widens the build inputs to smrt-mobile's checked-in
  contract dir so the freshness verify can't replay stale from cache.

## Commands

```bash
pnpm build                # vite build + verify smrt-mobile framework contract freshness
pnpm generate:framework   # vite build + REWRITE the smrt-mobile framework contract
pnpm test                 # vitest
```
