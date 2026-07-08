# @happyvertical/smrt-android

Android Compose foundation for SMRT mobile apps — the UI/platform half of
the KMP mobile foundation (design: **ADR 0001**, epic #1745, Phase 5 issue
#1742 — the locked design record is a comment on that issue). Consumes
`@happyvertical/smrt-mobile` (shared logic) and ships what is inherently
per-platform: the Compose design system, the bottom-tab shell, and the
native adapters implementing smrt-mobile's platform seams. Seeded from
amaru's FieldOps app (theme/shell/adapters) and the reporter (device
capability model); **productionize, don't lift** governs all porting.

## Layout

Two-module Gradle build orchestrated by turbo through the `package.json`
wrapper. `library/` is the published module (kept named `:smrt-android` so
composite-build substitution matches `com.happyvertical.smrt:smrt-android`);
`sample/` is the never-published demo app proving the Phase 5 acceptance
criteria. The smrt-mobile dependency resolves via
`includeBuild("../smrt-mobile")` — no Maven repository involved (Phase 0:
publishing deferred, consumers are local-fs).

- `library/src/main/kotlin/.../ui/` — `MobileTheme` (amaru's token system:
  status colors Stop/Caution/Go/Info/Neutral, glove-friendly spacing scale,
  type/shape scales; productionized with an opt-in dark scheme — light stays
  the default for the bright-sun field posture — and CompositionLocal token
  provision: `MobileTheme.statusColors` / `MobileTheme.spacing`), widgets
  (`MobileSectionLabel`, `MobileResultCard`, `MobileStatusPill`),
  `MobileShellScaffold` (icon-only bottom `NavigationBar` bound to
  smrt-mobile's hoisted `MobileShellState`; no androidx.navigation;
  `MobileTabHeader` is the quiet per-tab heading), and
  `BarcodeScannerPreview` (CameraX preview + analysis wiring for the
  barcode scanner).
- `library/src/main/kotlin/.../platform/` — concrete impls of smrt-mobile's
  seams: `MlKitBarcodeScanner` (`BarcodeScanner`; ML Kit + CameraX analyzer),
  `AndroidSpeechTranscriber` (`SpeechTranscriber`; wraps
  `android.speech.SpeechRecognizer`, main-thread), `GeminiNanoLanguageModel`
  (`OnDeviceLanguageModel`; ML Kit GenAI Prompt via AICore — reports
  on-device truth only, app maps to its API-fallback policy),
  `AndroidDeviceCapabilityAdapter` (`DeviceCapabilityAdapter`; reporter's
  tri-state permission model with injectable request history),
  `AndroidSha256Hasher` (`Sha256Hasher`), `AndroidSqlDriverFactory`
  (SQLDelight android-driver for `SmrtMobileDatabase`),
  `KeystoreAuthStorage` (`AuthStorage`; AES/GCM via Android Keystore — the
  named upgrade over the reporter's plain SharedPreferences),
  `CustomTabAuthLauncher` (`ExternalAuthLauncher`), and
  `AndroidEvidenceCaptureAdapter` (`EvidenceCapturePlatformAdapter`;
  drive-to-completion `captureOrPickPhoto` — full-res `TakePicture` into a
  library-shipped `FileProvider` URI, or the system photo picker — app-private
  storage, sha256 pin, `LocationManager` geo sidecar; #1880). The evidence
  FileProvider (`SmrtEvidenceFileProvider`) ships in the library manifest with a
  `${applicationId}.evidence.files` authority (per-consumer via manifest merge,
  overridable via the constructor + `tools:replace`).
- `library/src/test/` — local JVM unit tests for the pure
  platform-to-shared mappings (barcode formats, speech error codes,
  FeatureStatus→availability, sha256 vector, evidence
  segment/content-type/permission/location/verify projections).
  Camera/recognizer/AICore/capture behavior needs a device: the sample app is
  the manual acceptance surface.
- `sample/` — five tabs exercising shell+theme (Home, incl. a live
  `DurableWriteQueue` on the Android driver), barcode preview (Scan), evidence
  capture (Capture), speech + Gemini Nano round-trip (Talk), and the capability
  probe (Settings).

## Commands

```bash
pnpm build              # = validate:android — structural checks, no toolchain (CI lane a)
pnpm validate:android
pnpm build:gradle       # real compile: library + sample + unit tests (JDK 21 + Android SDK)
pnpm test:gradle        # ./gradlew test
```

Local Gradle on this repo's dev machines typically needs
`JAVA_HOME=<jdk21>` and `ANDROID_HOME` set. CI: every PR runs
`validate:android` via turbo build; `.github/workflows/mobile.yml` runs the
real Gradle build when `packages/smrt-android/**` or
`packages/smrt-mobile/**` change (the composite build recompiles
smrt-mobile). The Gradle wrapper is checked in — always invoke `./gradlew`.

## Conventions

- Toolchain pinned to smrt-mobile's set: Kotlin 2.4.0 / AGP 9.2.1 /
  Gradle 9.6.1 / compileSdk 36 / minSdk 26 / JVM 21 — renovate keeps both
  catalogs current; bump deliberately in `gradle/libs.versions.toml`.
- **AGP 9 built-in Kotlin**: do NOT apply `org.jetbrains.kotlin.android` —
  AGP owns Kotlin compilation; only the compose compiler plugin
  (`org.jetbrains.kotlin.plugin.compose`) is applied on top.
- Icons are app policy: the shell's tab bar takes a `tabIcon` slot;
  `material-icons-extended` stays out of the library (the sample carries
  its own icon dependency).
- Shared vocabulary (barcode format labels, speech error codes,
  availability statuses) is owned by smrt-mobile's `platform/` seams —
  adapters map platform constants onto it with pure, unit-tested functions.
- Sample-only concerns (runtime permission flows, demo wiring) never leak
  into `library/`.

## Standards exemptions

In the `NON_TYPESCRIPT_PACKAGES` set (`scripts/check-standards.mjs`,
`docs/content/standards.md` §1) like smrt-mobile: no vitest/typecheck
scripts (Kotlin toolchain), no `dist` (`private: true`; Maven publishing
deferred). Stays in the changesets fixed group so its version rides the
release train. The package-level `turbo.json` widens `build` inputs to the
Gradle files and sources the validator reads.
