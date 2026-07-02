# @happyvertical/smrt-mobile-contract

Codegen for the SMRT mobile foundation: projects a SMRT `manifest.json`
through a mobile allowlist into typed Kotlin (`@Serializable` DTOs for the
KMP module) and Swift (plain structs) — plus the generated framework
contract files checked into
[`@happyvertical/smrt-mobile`](../smrt-mobile/).

Design: [ADR 0001](../../docs/content/adr/0001-kmp-mobile-foundation.md);
epic happyvertical/smrt#1745.

## Usage

```ts
import {
  buildMobileContract,
  generateKotlinDtoFiles,
  generateSwiftDtoFile,
  writeFileSet,
} from '@happyvertical/smrt-mobile-contract';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('packages/my-objects/src/manifest/manifest.json', 'utf8'));

const contract = buildMobileContract({
  manifests: [manifest],
  allowlist: ['FieldReport', 'Attachment'],
  kotlinPackage: 'com.example.mobile.generated',
  sourceLabel: 'packages/my-objects/src/manifest/manifest.json',
});

writeFileSet('apps/mobile/shared/src/commonMain/kotlin/generated', generateKotlinDtoFiles(contract));
```

Framework contract regeneration (files checked into smrt-mobile):

```bash
pnpm --filter @happyvertical/smrt-mobile-contract generate:framework
```
