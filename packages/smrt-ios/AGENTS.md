# @happyvertical/smrt-ios

SwiftUI design system + native platform adapters for SMRT mobile apps — the iOS
UI/platform half of the KMP mobile foundation. Design: **ADR 0001**
(`docs/content/adr/0001-kmp-mobile-foundation.md`) + extraction plan; epic #1745,
Phase 6 issue #1743 (the locked design record lives as a comment on the issue).

It **consumes the exported `SmrtMobile` KMP framework** (from
`packages/smrt-mobile`) — the piece amaru's iOS never wired up, and the ADR's
riskiest single item. It ships the SwiftUI `MobileTheme` design tokens, the tab
shell scaffold bound to smrt-mobile's `MobileShellState`, and the native adapters
(VisionKit barcode, Speech transcription, Foundation Models on-device LLM, device
capabilities, SQLDelight native driver, Keychain auth storage, ASWebAuthenticationSession
auth launcher). Seed provenance: amaru's SwiftUI shell + `FieldOpsStyle` +
`FieldOpsTalkBridge`, hardened per **productionize, don't lift**.

## Layout

XcodeGen two-target project orchestrated by turbo through `package.json` — no
Gradle (the divergence from `smrt-android`, which is a Compose/Gradle module). The
reusable foundation is a static Swift library; the sample app is the single link
point for the KMP framework, so there are no duplicate static symbols.

- `Sources/SmrtIos/Theme/MobileTheme.swift` — design tokens (`MobileColors`,
  `MobileStatusColors`, `MobileSpacing`, `MobileTypography`, `MobileShapes`),
  delivered via SwiftUI `@Environment` (the analog of Compose CompositionLocals),
  plus `MobileTheme`/`MobileSectionLabel`/`MobileResultCard`/`MobileStatusPill`.
  Values are **identical to smrt-android's `MobileTheme.kt`** — one design system.
- `Sources/SmrtIos/Shell/MobileShellScaffold.swift` — the tab shell bound to
  smrt-mobile's shared `MobileShellState` (not an unbound `TabView`), + `MobileTabHeader`.
- `Sources/SmrtIos/Platform/` — the adapters, each conforming to a smrt-mobile
  exported seam: `CryptoKitSha256Hasher` (`Sha256Hasher`), `KeychainAuthStorage`
  (`AuthStorage`), `WebAuthSessionLauncher` (`ExternalAuthLauncher`),
  `NativeSqlDriverFactory` (over the framework's `SmrtMobileIos`),
  `IOSDeviceCapabilityAdapter` (`DeviceCapabilityAdapter`),
  `DataScannerBarcodeScanner` (`BarcodeScanner`, **net-new** + `BarcodeScannerPreview`),
  `FoundationModelsLanguageModel` (`OnDeviceLanguageModel`), `IOSSpeechTranscriber`
  (`SpeechTranscriber`), and `IOSEvidenceCaptureAdapter`
  (`EvidenceCapturePlatformAdapter`; drive-to-completion `captureOrPickPhoto` —
  presents `UIImagePickerController`/`PHPickerViewController`, bridges the
  delegate into `async`, copies into `Documents/Evidence/` with
  security-scoped-resource handling, CryptoKit sha256 pin, `CLLocationManager`
  geo sidecar; simulator falls back to the photo picker; #1880).
- `Sample/SmrtIosSample/` — the demo app proving real shared logic (durable pack
  store + write-queue, adapters, evidence capture, theme/shell). Never published.
- `Tests/SmrtIosTests/` — XCTest over the pure seam-vocabulary mappings.
- `project.yml` — XcodeGen spec. `Frameworks/SmrtMobile.framework` is staged by
  the validator; both are git-ignored.

## Commands

```bash
pnpm build                 # = validate:ios — structural, SDK-free (CI lane a, every PR)
pnpm validate:ios
pnpm validate:ios:native   # real build: Gradle framework → XcodeGen → xcodebuild + tests (macOS)
```

`validate:ios:native` needs macOS + Xcode + XcodeGen, and `JAVA_HOME` (JDK 21) +
`ANDROID_HOME` for the smrt-mobile Gradle framework build. CI: `validate:ios`
(structural) runs on every PR via turbo build; `.github/workflows/mobile.yml` runs
the native lane on `macos-latest`, path-filtered to `packages/smrt-ios/**`.

## Conventions

- Swift 5 language mode; iOS deployment target 17.0 (Foundation Models is
  weak-linked, `@available(iOS 26)`).
- Adapters conform to smrt-mobile's **exported Obj-C protocols** — Kotlin/Native's
  `swift_name` gives clean Swift names (`Sha256Hasher`, not `SmrtMobileSha256Hasher`).
  `suspend` → Swift `async throws`; `fun interface` → a protocol (implement as a
  class, not a closure); Kotlin listener defaults do not carry over.
- Availability adapters report **on-device truth only** — the Foundation Models
  bridge emits `available` / `model_not_ready` / `hidden_unavailable` and **never**
  `api_fallback_available` (that is app policy; mirrors `GeminiNanoLanguageModel`).
- Design tokens are byte-identical to smrt-android; keep the two in sync.
- The Keychain auth storage matches Android's durability: writes committed before
  return, `kSecAttrAccessibleAfterFirstUnlock` so pending-auth survives process death.

## Gotchas

- **SQLite extension symbols.** SQLDelight's native-driver (SQLiter) references
  `sqlite3_load_extension` / `sqlite3_enable_load_extension`, which Apple's iOS
  `libsqlite3` stub omits. `project.yml`'s `OTHER_LDFLAGS` resolves them at runtime
  with `-Wl,-U,_sqlite3_load_extension -Wl,-U,_sqlite3_enable_load_extension`
  (plus `-lsqlite3`). Without it the app fails to link.
- **`SmrtMobileIos` factories.** Swift cannot instantiate Kotlin/Native types
  (`NativeSqliteDriver`, the Ktor `Darwin` engine), so smrt-mobile's `iosMain`
  hands Swift a wired `SmrtMobileDatabase`/`MobileApiClient`/pack-store/queue via
  the exported `SmrtMobileIos` object. Construct shared services through it.
- **Framework arch.** The validator builds the **simulator** framework
  (`iosSimulatorArm64`); device builds / an XCFramework are distribution follow-ups.

## Standards exemptions (documented per scripts/check-standards.mjs)

This package is in the `NON_TYPESCRIPT_PACKAGES` set (see
`docs/content/standards.md` §1), which exempts it from the TypeScript-shape
requirements: no `vitest.config.ts` and no vitest `test` scripts (tests are Swift
XCTest, run by the `mobile.yml` macOS lane), no `typecheck` script (the Swift
compiler typechecks), and no `dist` in `files` (nothing publishes to npm:
`private: true`; SPM/Maven distribution deferred per the ADR 0001 Phase 0 record).
It stays in the changesets fixed group so its version rides the release train. A
package-level `turbo.json` widens the `build` (= `validate:ios`) inputs.
