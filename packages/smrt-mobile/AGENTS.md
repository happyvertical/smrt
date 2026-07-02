# @happyvertical/smrt-mobile

Kotlin Multiplatform shared mobile foundation for SMRT apps — the first
non-TypeScript package in the monorepo. Design: **ADR 0001**
(`docs/content/adr/0001-kmp-mobile-foundation.md`) + extraction plan; epic
#1745. Decision record: `README.md` here and issue #1737.

**Status: Phase 2.** Present: framework contract types, pack i18n resolver,
pack integrity/snapshot model, evidence-capture model, shell state, platform
seams, and the **durable SQLDelight-backed offline write-queue + pack store**
(Phase 2, #1739). NOT here yet (later phases — do not add ad hoc):
auth/session (Phase 3, #1740), Ktor networking (Phase 4, #1741).
**Productionize, don't lift** governs all porting from the seed apps.

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
  seal (`PackIntegrityCheck`); `DurableOfflinePackStore` persists pack
  records (framework identity columns + the app's serialized manifest
  payload). Hashing itself is a platform seam.
- `src/commonMain/kotlin/.../sync/` — `DurableWriteQueue`: the reporter-seeded
  crash-safe write-queue on SQLDelight. The full contract (state machine,
  trigger-preserving single-flight flush, attempt cap with 401 refund,
  crash/cancel recovery, guarded transitions, insertion ordering) is
  canonical in the class KDoc — read it there, don't trust prose copies.
  **One queue instance per database**; transport is the `QueueSender` seam
  until Phase 4; flush *triggers* (foreground, connectivity, manual) are
  platform callbacks that just call `flush()`.
- `src/commonMain/sqldelight/.../db/` — `.sq` schema (SmrtMobileDatabase).
  All DB work runs on the injectable `context` (default
  `Dispatchers.Default`) so queue/store calls are main-safe. Queue/store
  tests live in `src/jvmTest/` against real SQLite (JVM driver — fast and
  Android-SDK-free on CI); platform driver factories arrive with
  smrt-android / smrt-ios (Phases 5–6).
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
- commonMain dependencies stay minimal (kotlinx-serialization,
  kotlinx-datetime, kotlinx-coroutines, SQLDelight runtime). Ktor arrives in
  Phase 4. No other deps without an ADR note.
- Adapter seams are plain Kotlin interfaces (amaru precedent), not
  `expect`/`actual`.
- Wire DTO fields default-initialize (safe partial deserialization); decimals
  cross the wire as `DecimalString`.

## Schema changes (SQLDelight)

`src/commonMain/sqldelight/databases/1.db` is the checked-in snapshot of
schema version 1 and `verifyMigrations` is on: once devices hold durable
data, editing a `.sq` file in place is NOT enough. The protocol for any
schema change: bump the schema by adding a numbered `.sqm` migration next to
the `.sq` files, regenerate the snapshot
(`./gradlew generateCommonMainSmrtMobileDatabaseSchema`), and keep
`./gradlew verifySqlDelightMigration` green — it runs as part of `build`.
Fresh installs run the CREATE statements; existing devices run migrations.

## Standards exemptions (documented per scripts/check-standards.mjs)

This package is in the `NON_TYPESCRIPT_PACKAGES` set (see
`docs/content/standards.md` §1 "Non-TypeScript packages"), which exempts it
from the TS-shape requirements: no `vitest.config.ts` and no vitest
`test`/`test:watch`/`dev` scripts (tests are Kotlin — `./gradlew allTests`,
run by the mobile.yml CI lane), no `typecheck` script (the Kotlin compiler
typechecks), and no `dist` in `files` (nothing publishes to npm:
`private: true`; Maven publishing deferred per the Phase 0 decision). It DOES
stay in the changesets fixed group so its version rides the release train
with every other smrt-* package. A package-level `turbo.json` widens the
`build` (= `validate:shell`) inputs to the Gradle files, scripts, and docs
the validator reads — without it, turbo replays stale validation passes.
