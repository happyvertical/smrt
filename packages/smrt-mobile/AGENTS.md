# @happyvertical/smrt-mobile

Kotlin Multiplatform shared mobile foundation for SMRT apps — the first
non-TypeScript package in the monorepo. Design: **ADR 0001**
(`docs/content/adr/0001-kmp-mobile-foundation.md`) + extraction plan; epic
#1745. Decision record: `README.md` here and issue #1737.

**Status: Phases 1–5 complete** — the shared-logic core. Present: framework
contract types, pack i18n resolver, pack integrity/snapshot model,
evidence-capture model, shell state, the **durable SQLDelight write-queue +
pack store** (Phase 2, #1739), the **PKCE auth/session module** (Phase 3,
#1740), the **shared Ktor client** (Phase 4, #1741) implementing the
`AuthTransport`/`QueueSender` seams, and the **barcode/speech/LLM/device
seam interfaces** (Phase 5, #1742). NOT here: platform adapters, engines,
and secure-storage impls — the Android halves live in
`packages/smrt-android` (Phase 5); the iOS halves land with smrt-ios
(Phase 6). **Productionize, don't lift** governs all porting from the seed
apps.

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
- `src/commonMain/kotlin/.../auth/` — `MobileSessionManager`: server-brokered
  PKCE (begin → platform launcher opens the authorization URL → deep-link
  redirect → `state` validation → code exchange → persisted session). The
  pending handshake persists so the browser hand-off survives process death.
  Seams: `AuthStorage` (Keystore/Keychain in Phases 5–6 — the reporter's
  SharedPreferences/UserDefaults is explicitly the thing to upgrade),
  `AuthTransport` (Phase 4 Ktor), `ExternalAuthLauncher` (custom tab /
  ASWebAuthenticationSession). `onUnauthorized()` is the networking client's
  401 hook: clears the session; the write-queue keeps its entries.
- `src/commonMain/kotlin/.../network/` — `MobileApiClient`: engine-agnostic
  Ktor client for the `/api/mobile` contract (apps supply okhttp/darwin
  engines; tests use MockEngine). Bearer on every authenticated request;
  multipart evidence upload; `Idempotency-Key` from the queue entry id;
  401 → `UnauthorizedHandler` (wire to `MobileSessionManager.onUnauthorized`)
  then `AuthUnauthorizedException`. `HttpQueueSender` maps HTTP outcomes to
  the queue's `SendOutcome` semantics **for the hand-written `/api/mobile`
  single-item endpoints only** (4xx permanent except 408/429; the handlers
  dedupe on `Idempotency-Key`). Framework-model writes need the planned
  batch `sync/apply` sender instead (per-item statuses inside HTTP 200,
  non-2xx retryable, dedupe by construction — see
  `docs/content/architecture/sync-apply-contract.md`). Request routing per
  entry kind is app policy. No auto-retry — queued writes retry via flush
  triggers (reporter parity).
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
  Framework-model writes ride core's **`sync/apply` batch contract**
  (`docs/content/architecture/sync-apply-contract.md` — it names this queue
  as a consumer): such entry payloads carry the item fields
  (`object`/`op`/entity `id`/`baseUpdatedAt`), `entry.id` is the `itemId`
  analog, and the Phase-4 sender maps its per-item statuses (per-item
  results arrive inside HTTP 200; a non-2xx batch response is retryable).
  The attempt cap (5, reporter seed) is a deliberate divergence from
  smrt-web's uncapped exponential backoff — revisit as a cross-client
  decision.
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
- `src/commonMain/kotlin/.../platform/` — adapter seams: `Sha256Hasher`,
  and the Phase 5 shared contracts (ADR 0001 Correction 4 — net-new, the
  seed apps had none): `BarcodeScanner` (+ `BarcodeScan`/`BarcodeFormat`),
  `SpeechTranscriber` (+ `SpeechErrorCode`), `OnDeviceLanguageModel`
  (+ `LanguageModelAvailability` — amaru's status/provider vocabulary kept
  verbatim; prompt building and output parsing stay app-side), and the
  reporter-seeded `DeviceCapabilityAdapter` (tri-state permission model;
  DTOs live in the generated contract). Concrete implementations are the
  platform libraries' job: smrt-android (Phase 5) ships ML Kit barcode,
  `android.speech`, Gemini Nano, and the capability probe; smrt-ios
  (Phase 6) ships the Foundation Models + net-new barcode counterparts.

Targets: `androidTarget` + `jvm` + `iosX64`/`iosArm64`/`iosSimulatorArm64`
(static framework `SmrtMobile`). The `jvm` target exists so common tests run
without an Android SDK.

- `src/iosMain/kotlin/.../platform/SmrtMobileIos.kt` — the iOS platform
  factories the exported framework hands to Swift (Phase 6, #1743):
  `createDatabase` / `createApiClient` / `createOfflinePackStore` /
  `createWriteQueue`. These build Kotlin/Native types Swift cannot instantiate
  itself (`NativeSqliteDriver`, the Ktor `Darwin` engine); smrt-android, being
  Kotlin, builds its own. This is the only `iosMain` code — everything else is
  `commonMain`.

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
(ubuntu), and iOS-target compilation nightly/on-demand (macOS). The Gradle
wrapper is checked in — always invoke via `./gradlew`.

## Conventions

- Kotlin 2.4.0 / AGP 9.2.1 (androidKmpLibrary DSL) / Gradle 9.6.1 /
  compileSdk 36 / minSdk 26 / JVM toolchain 21 / iOS deployment 17.0 —
  renovate keeps these current; bump deliberately in
  `gradle/libs.versions.toml`.
- commonMain dependencies stay minimal (kotlinx-serialization,
  kotlinx-datetime, kotlinx-coroutines, SQLDelight runtime, ktor-client-core
  as `api`). No engine deps here — consumers pick okhttp/darwin. No other
  deps without an ADR note. `iosMain` is the one exception (Phase 6, #1743):
  it adds `ktor-client-darwin` + `sqldelight:native-driver` so the framework
  hands Swift a wired client/store (Swift can't build those Kotlin/Native
  types) — kept out of commonMain to preserve the engine-free rule.
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
