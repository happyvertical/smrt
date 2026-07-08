# @happyvertical/smrt-android

Android Compose foundation for SMRT mobile apps (ADR 0001 Phase 5, issue
#1742): the `MobileTheme` design system, the bottom-tab `MobileShellScaffold`
bound to smrt-mobile's `MobileShellState`, and the native adapters
implementing smrt-mobile's platform seams — ML Kit barcode, speech
transcription, Gemini Nano on-device LLM, device capabilities, the SQLDelight
Android driver, Keystore-backed auth storage, and a Custom Tabs auth
launcher.

## Consuming (local filesystem, per the Phase 0 decision)

Publishing is deferred; consumers use Gradle composite builds:

```kotlin
// settings.gradle.kts
includeBuild("<path-to-smrt>/packages/smrt-mobile")
includeBuild("<path-to-smrt>/packages/smrt-android")

// module build.gradle.kts
dependencies {
    implementation("com.happyvertical.smrt:smrt-android")
}
```

## Development

```bash
pnpm build          # structural validation (no JDK/SDK needed) — CI lane (a)
pnpm build:gradle   # real compile + unit tests (JDK 21 + Android SDK)
./gradlew :sample:installDebug   # run the sample app on a device
```

The sample app is the on-device acceptance surface: Home (theme + live
durable write-queue), Scan (ML Kit barcode over CameraX), Talk (speech +
Gemini Nano when available), Settings (capability/permission probe).

Design record and decisions: see `AGENTS.md` here, ADR 0001 (+ extraction
plan) in `docs/content/adr/`, and the locked Phase 5 design record on issue
#1742.
