# @happyvertical/smrt-mobile

Kotlin Multiplatform shared mobile foundation for SMRT apps — the first
non-TypeScript package in the monorepo. Design: **ADR 0001**
(`docs/content/adr/0001-kmp-mobile-foundation.md`) + extraction plan; epic
#1745. Decision record: `README.md` here and issue #1737.

**Status: Phase 1 skeleton.** Present: framework contract types, pack i18n
resolver, pack integrity/snapshot model, evidence-capture model, shell state,
platform seams. NOT here yet (later phases — do not add ad hoc): durable
offline queue (Phase 2, #1739 — SQLDelight), auth/session (Phase 3, #1740),
Ktor networking (Phase 4, #1741). **Productionize, don't lift** governs all
porting from the seed apps.

## Layout

Single-module KMP Gradle project (the package root IS the module — no
`shared/`/`androidApp` split; sample apps live in the seed repos until
Phases 5–6). Namespace `com.happyvertical.smrt.mobile`; Maven coordinates
locked as `com.happyvertical.smrt:smrt-mobile` (publishing deferred — local
consumers use Gradle `includeBuild`).

- `src/commonMain/kotlin/.../contract/` — **generated** framework contract
  (support types, pack localization, `/api/mobile/*` auth+session+device
  DTOs). Owner: `@happyvertical/smrt-mobile-contract`. Regenerate:
  `pnpm --filter @happyvertical/smrt-mobile-contract generate:framework`.
  Never edit by hand; the contract package's build verifies freshness.
- `src/commonMain/kotlin/.../i18n/` — `PackTextResolver`: requested →
  fallback → source locale chain with review-state/safety-critical
  provenance.
- `src/commonMain/kotlin/.../packs/` — pack snapshot identity + integrity
  seal (`PackIntegrityCheck`). Hashing itself is a platform seam.
- `src/commonMain/kotlin/.../evidence/` — evidence asset refs (SHA-256
  pins), geo **sidecar** metadata (never EXIF — recompression strips it),
  permission state, `EvidenceCapturePlatformAdapter` seam. Domain identity
  travels in `contextIds` so the model stays trade-neutral.
- `src/commonMain/kotlin/.../shell/` — `MobileShellState` manual-tab nav
  state (no androidx.navigation); apps provide the tab list.
- `src/commonMain/kotlin/.../platform/` — adapter seams (`Sha256Hasher`).
  Barcode/speech/on-device-LLM interfaces arrive with their first concrete
  implementations (Phases 5–6).

Targets: `androidTarget` + `jvm` + `iosX64`/`iosArm64`/`iosSimulatorArm64`
(static framework `SmrtMobile`). The `jvm` target exists so common tests run
without an Android SDK.

## Commands

```bash
pnpm build              # = validate:shell — structural checks, no toolchain (CI lane a)
pnpm validate:shell
pnpm build:gradle       # real KMP compile (needs JDK 21; Android SDK for androidTarget)
pnpm test:gradle        # ./gradlew allTests
./gradlew jvmTest       # fastest: common tests on the JVM target only
```

CI: every PR runs `validate:shell` via turbo build; `.github/workflows/mobile.yml`
runs the real Gradle build+tests when `packages/smrt-mobile/**` changes
(ubuntu), and iOS-target compilation nightly/on-demand (macOS). Gradle
wrapper (8.14.4) is checked in — always invoke via `./gradlew`.

## Conventions

- Kotlin 2.2.21 / AGP 8.13.1 / compileSdk 36 / minSdk 26 / JVM toolchain 21 /
  iOS deployment 17.0 — reporter-proven set; bump deliberately in
  `gradle/libs.versions.toml`.
- commonMain dependencies stay minimal (kotlinx-serialization, kotlinx-datetime).
  SQLDelight arrives in Phase 2; Ktor in Phase 4. No other deps without an ADR note.
- Adapter seams are plain Kotlin interfaces (amaru precedent), not
  `expect`/`actual`.
- Wire DTO fields default-initialize (safe partial deserialization); decimals
  cross the wire as `DecimalString`.

## Standards exemptions (documented per scripts/check-standards.mjs)

- `noVitestConfig` + `noTypecheckScript` + `noDistInFiles`: this package has
  no TypeScript and no npm dist — tests are Kotlin (`./gradlew allTests`),
  typechecking is the Kotlin compiler, and nothing is published to npm
  (`private: true`; Maven publishing deferred per Phase 0 decision).
