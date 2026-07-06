# @happyvertical/smrt-mobile

Kotlin Multiplatform shared mobile foundation for SMRT apps: offline pack
model + integrity, pack i18n resolution, evidence-capture model, app-shell
state, and platform adapter contracts. Android consumes the module directly;
iOS consumes the exported `SmrtMobile` framework.

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
   `smrt-users` (issue #1748); anytown's dashboard is the reference
   implementation until then.
6. **Toolchain** — Kotlin 2.2.21 / AGP 8.13.1 / compileSdk 36 / minSdk 26 /
   JVM 21 / iOS deployment target 17.0 (reporter-proven set, amaru catalog
   structure).

## Building

```bash
pnpm validate:shell     # structure checks (what CI runs on every PR)
./gradlew jvmTest       # common logic tests on the JVM target (no Android SDK)
./gradlew build         # full compile + tests (JDK 21; Android SDK for androidTarget;
                        # iOS targets compile on macOS hosts only)
```

Toolchain requirements: run Gradle on a JDK between 17 and 24 (the module's
language/toolchain level is 21 — `jvmToolchain(21)`); Gradle 8.14.4 ships via
the checked-in wrapper, so always invoke `./gradlew`. `androidTarget` needs an
Android SDK (`ANDROID_HOME`); the `jvm` target exists precisely so common
logic tests run without one. iOS targets require a macOS host with Xcode.

## Consuming (v0, local filesystem)

Distribution is deferred (decision 2). Android/KMP consumers use a Gradle
composite build from a sibling checkout:

```kotlin
// settings.gradle.kts of the consuming app
includeBuild("../smrt/packages/smrt-mobile")
```

then depend on `com.happyvertical.smrt:smrt-mobile`. iOS apps link the
`SmrtMobile` static framework produced by the iOS targets (wired end-to-end
in Phase 6, #1743).

## Layout

- `src/commonMain/kotlin/.../contract/` — generated framework contract
  (support types, pack localization, `/api/mobile` auth/session/device DTOs);
  owned by `@happyvertical/smrt-mobile-contract`, regenerate with
  `pnpm --filter @happyvertical/smrt-mobile-contract generate:framework`.
- `.../i18n/` — `PackTextResolver` (requested → fallback → source locale).
- `.../packs/` — pack snapshot identity + SHA-256 integrity seal.
- `.../evidence/` — evidence asset refs, geo sidecar, capture adapter seam.
- `.../shell/` — `MobileShellState` manual-tab navigation state.
- `.../platform/` — platform seams (`Sha256Hasher`).

## Roadmap (epic #1745)

- Phase 2 (#1739) — **landed**: durable offline write-queue + pack store
  (SQLDelight), carrying reporter's semantics: single-flight coalesced flush,
  attempt cap, `uploading → pending` crash recovery, idempotency keys.
- Phase 3 (#1740) — **landed**: PKCE/OIDC session module (`MobileSessionManager`)
  with platform browser/deep-link/secure-storage seams.
- Phase 3.5 (#1748): `/api/mobile` server handlers in `smrt-users`.
- Phase 4 (#1741): shared Ktor client (bearer + multipart + retry).
- Phases 5–6 (#1742/#1743): `smrt-android` (Compose) and `smrt-ios` (SwiftUI +
  real KMP framework wiring).
- Phase 7 (#1744): rebuild amaru FieldOps and anytown reporter on the
  foundation — the trade-neutrality acceptance test.
