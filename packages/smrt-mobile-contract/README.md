# @happyvertical/smrt-mobile-contract

Codegen for the SMRT mobile foundation: projects a SMRT `manifest.json`
through a mobile allowlist into typed Kotlin (`@Serializable` DTOs for the
KMP module) and Swift (plain structs) — plus the generated framework
contract files checked into
[`@happyvertical/smrt-mobile`](../smrt-mobile/README.md).

Design: [ADR 0001](../../docs/content/adr/0001-kmp-mobile-foundation.md);
epic happyvertical/smrt#1745. Agent/developer guidance:
[AGENTS.md](./AGENTS.md). Zero runtime dependencies by design — it reads
`manifest.json` files directly and stays out of the smrt package DAG.

## Install

```bash
pnpm add -D @happyvertical/smrt-mobile-contract
```

## Usage — per-app domain DTOs

```ts
import {
  buildMobileContract,
  generateKotlinDtoFiles,
  generateSwiftDtoFile,
  writeFileSet,
} from '@happyvertical/smrt-mobile-contract';
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync('packages/my-objects/src/manifest/manifest.json', 'utf8'),
);

const contract = buildMobileContract({
  manifests: [manifest],                     // one or more SMRT manifests
  allowlist: ['FieldReport', 'Attachment'],  // short or qualified names
  kotlinPackage: 'com.example.mobile.generated',
  sourceLabel: 'packages/my-objects/src/manifest/manifest.json',
});

writeFileSet(
  'apps/mobile/shared/src/commonMain/kotlin/generated',
  generateKotlinDtoFiles(contract),
);
writeFileSync(
  'apps/mobile/iosApp/App/GeneratedMobileDtos.swift',
  generateSwiftDtoFile(contract),
);
```

### Allowlist rules

- Entries may be short names (`FieldReport`) or qualified names
  (`@scope/pkg:FieldReport`). A short name that matches objects in more than
  one manifest is an error — use the qualified name.
- Two allowlisted objects may not share a short name: generated `<Name>Dto`
  files would overwrite each other, so the build throws instead.
- Relationship declarations (`oneToMany`/`manyToMany`/`hasMany`) are excluded
  from DTO projection — they are not scalar columns.

### Type mapping

| Manifest `type` | Kotlin | Swift |
|---|---|---|
| `text` / `status` / `foreignKey` / `crossPackageRef` | `String` | `String` |
| `integer` | `Long` (64-bit — byte sizes/epochs overflow `Int`) | `Int64` |
| `decimal` | `DecimalString?` (string-encoded, no float precision loss) | `String?` |
| `boolean` | `Boolean` | `Bool` |
| `datetime` | `Instant?` | `String?` |
| `json` | `JsonObject` | `String` (raw JSON) |

Field defaults come from `default` (current manifests) with `defaultValue`
(amaru-era) as a fallback; every generated Kotlin field default-initializes
for safe partial deserialization. Field names stay manifest-faithful
(wire-format names, including `created_at`); keyword collisions are
backtick-escaped per language. `sourceHash` (sha256 over allowlist +
projected objects) is stamped into all output so drift is detectable.

## Usage — the framework contract

The stable framework contract (support types, pack localization, and the
`/api/mobile` auth/session/device DTOs) is emitted by this package and
checked into `smrt-mobile`'s `contract/` directory. This package's `build`
byte-verifies those files; regenerate after editing `src/emit-framework.ts`:

```bash
pnpm --filter @happyvertical/smrt-mobile-contract generate:framework
```

The Swift mirror (`frameworkSwiftFiles()`) is emitted on demand for SwiftUI
apps; a parity test keeps it field-for-field in sync with the Kotlin side.

## Development

```bash
pnpm build   # vite build + framework contract freshness verify
pnpm test    # vitest (goldens, mapping rules, parity, file-set round-trip)
```
