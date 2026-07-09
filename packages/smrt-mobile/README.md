# @happyvertical/smrt-mobile

Kotlin Multiplatform shared mobile foundation for SMRT apps: offline pack
model + integrity, pack i18n resolution, durable evidence uploads, shared
presenter state, app-shell state, and platform adapter contracts. Android
consumes the module directly; iOS consumes the exported `SmrtMobile`
framework.

Design and rationale: [ADR 0001](../../docs/content/adr/0001-kmp-mobile-foundation.md)
and its [extraction plan](../../docs/content/adr/0001-kmp-mobile-foundation-extraction-plan.md).
Epic: happyvertical/smrt#1745. Agent/developer guidance: [AGENTS.md](./AGENTS.md).
Codegen companion: [`@happyvertical/smrt-mobile-contract`](../smrt-mobile-contract/README.md).

## Phase 0 decision record (locked with the framework owner, 2026-07-01)

1. **Monorepo placement** — `packages/smrt-mobile` (+ `packages/smrt-mobile-contract`,
   later `smrt-android`/`smrt-ios`) with `package.json` wrappers so
   pnpm/turbo/knowledge tooling see them (amaru precedent).
2. **Distribution** — deferred. All consumers (amaru, anytown, ergot) are on
   local filesystems: v0 consumption is Gradle `includeBuild`/path and, for
   iOS, a local-path `Package.swift` later. Coordinates locked now:
   Maven group `com.happyvertical.smrt`, namespace
   `com.happyvertical.smrt.mobile`. Constraint recorded: remote git-source
   SPM cannot target a monorepo subdirectory — remote iOS distribution later
   means XCFramework releases or a mirror repo.
3. **Durable store** — **SQLDelight** (Phase 2): KMP-common typed store; the
   JVM driver keeps queue tests fast and SDK-free on CI.
4. **CI posture** — three lanes: (a) PR default `validate:shell` (no
   toolchain), (b) path-filtered real `gradle build` + KMP unit tests when
   this package changes, (c) nightly/on-demand full lane incl. macOS for
   iOS-target compilation. Gradle wrapper checked in.
5. **Server contract** — `/api/mobile` (server-brokered PKCE, session
   bootstrap, multipart upload with `clientCaptureId`/`Idempotency-Key`
   dedup) is part of the foundation: SMRT ships reusable handlers in
   `smrt-users` (issue #1748); app-owned bootstrap data is nested under the
   contract's `extras` field.
6. **Toolchain** — Kotlin 2.4.0 / AGP 9.2.1 / Gradle 9.6.1 / compileSdk 36 /
   minSdk 26 / JVM 21 / iOS deployment target 17.0. The Compose package pins
   Compose BOM 2026.06.01 and Activity Compose 1.13.0.

## Building

```bash
pnpm validate:shell     # structure checks (what CI runs on every PR)
./gradlew jvmTest       # common logic tests on the JVM target (no Android SDK)
./gradlew build         # full compile + tests (JDK 21; Android SDK for androidTarget;
                        # iOS targets compile on macOS hosts only)
```

Toolchain requirements: run Gradle on a JDK between 17 and 24 (the module's
language/toolchain level is 21 -- `jvmToolchain(21)`); Gradle 9.6.1 ships via
the checked-in wrapper, so always invoke `./gradlew`. `androidTarget` needs an
Android SDK (`ANDROID_HOME`); the `jvm` target exists precisely so common
logic tests run without one. iOS targets require a macOS host with Xcode.

## Consuming (v0, local filesystem)

Distribution is deferred (decision 2). Android/KMP consumers use a Gradle
composite build. Resolve the SMRT checkout from a Gradle property first, an
environment variable second, and a sibling checkout as the local default:

```kotlin
// settings.gradle.kts of the consuming app
val smrtFoundationDir = providers.gradleProperty("smrtFoundationDir")
    .orElse(providers.environmentVariable("SMRT_FOUNDATION_DIR"))
    .orElse("../smrt")
    .get()
val smrtFoundation = file(smrtFoundationDir)

includeBuild(smrtFoundation.resolve("packages/smrt-mobile"))
// Include this only when consuming the Compose package.
includeBuild(smrtFoundation.resolve("packages/smrt-android"))
```

Then depend on `com.happyvertical.smrt:smrt-mobile` and, when needed,
`com.happyvertical.smrt:smrt-android`. Do not hard-code workstation-absolute
paths in a consuming repository. AGP 9 provides built-in Kotlin, so Android
consumers must not apply `org.jetbrains.kotlin.android`; they must also request
`TargetJvmEnvironment.ANDROID` on resolvable configurations. The complete
snippet is in [`smrt-android`'s README](../smrt-android/README.md).

CI checks out both repositories and points Gradle at the foundation checkout:

```yaml
- uses: actions/checkout@v4
- uses: actions/checkout@v4
  with:
    repository: happyvertical/smrt
    ref: ${{ vars.SMRT_FOUNDATION_REF }} # Set to an immutable release tag.
    path: smrt-foundation
    token: ${{ secrets.FOUNDATION_REPO_TOKEN }}
- run: ./gradlew test
  env:
    SMRT_FOUNDATION_DIR: ${{ github.workspace }}/smrt-foundation
```

For a private cross-organization checkout, `FOUNDATION_REPO_TOKEN` must be a
GitHub App token or fine-grained PAT with read access to `happyvertical/smrt`.
Set the `SMRT_FOUNDATION_REF` repository variable to the exact release tag the
consumer has validated.
iOS apps link the `SmrtMobile` static framework produced by the iOS targets
(wired end-to-end in Phase 6, #1743).

## Shared presenter state

Put cross-platform orchestration in a KMP presenter derived from
`MobileStatePresenter<T>`. Compose collects `presenter.state` as a normal
`StateFlow`; SwiftUI owns a `MobileObservableState(holder:)` from `SmrtIos`
and reads its published `value`. Close presenters when their owning scope is
destroyed, and call `close()` on an adapter when observation must end early.

## Durable evidence multipart

Queue an encoded `EvidenceMultipartUpload`, which stores form fields and
`EvidenceAssetRef` metadata without copying media bytes into the SQLDelight
row. Decode it inside the suspend `HttpQueueSender` mapper and call
`toQueueHttpRequest(EvidenceByteSource { ... })`; the platform byte source
loads each local file when the queue actually flushes. `smrt-android` ships
`AndroidEvidenceByteSource`; `smrt-ios` ships `FoundationEvidenceByteSource`,
whose Kotlin/Native bridge uses one bulk copy rather than per-byte calls.

## Session bootstrap extensions

App-domain bootstrap payloads belong inside `MobileSessionBootstrap.extras`.
Configure them with `createMobileAuthHandlers({ buildExtras })` on the server.
Unknown top-level fields such as `dashboard` are outside the contract and are
ignored by the Kotlin decoder, so they cannot be used as an extension point.

## Layout

- `src/commonMain/kotlin/.../contract/` — generated framework contract
  (support types, pack localization, `/api/mobile` auth/session/device DTOs);
  owned by `@happyvertical/smrt-mobile-contract`, regenerate with
  `pnpm --filter @happyvertical/smrt-mobile-contract generate:framework`.
- `.../i18n/` — `PackTextResolver` (requested → fallback → source locale).
- `.../packs/` — pack snapshot identity + SHA-256 integrity seal.
- `.../evidence/` — evidence asset refs, geo sidecar, capture adapter seam,
  and durable multipart payload/byte-source helpers.
- `.../state/` — shared `StateFlow` holder and presenter base for Compose and
  SwiftUI observation.
- `.../shell/` — `MobileShellState` manual-tab navigation state.
- `.../platform/` — platform seams (`Sha256Hasher`).

## Roadmap (epic #1745)

- Phase 2 (#1739) — **landed**: durable offline write-queue + pack store
  (SQLDelight), carrying reporter's semantics: single-flight coalesced flush,
  attempt cap, `uploading → pending` crash recovery, idempotency keys.
- Phase 3 (#1740) — **landed**: PKCE/OIDC session module (`MobileSessionManager`)
  with platform browser/deep-link/secure-storage seams.
- Phase 3.5 (#1748) — **landed**: `/api/mobile` server handlers in
  `smrt-users`.
- Phase 4 (#1741) — **landed**: shared Ktor client (`MobileApiClient` +
  `HttpQueueSender`): bearer everywhere, multipart with idempotency keys,
  401 hook, queue flush end-to-end.
- Phases 5–6 (#1742/#1743) — **landed**: `smrt-android` (Compose) and
  `smrt-ios` (SwiftUI + real KMP framework wiring).
- Phase 7 (#1744): rebuild amaru FieldOps and anytown reporter on the
  foundation — the trade-neutrality acceptance test.
