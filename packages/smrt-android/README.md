# @happyvertical/smrt-android

Android Compose foundation for s-m-r-t mobile apps (ADR 0001 Phase 5, issue
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
val smrtFoundationDir = providers.gradleProperty("smrtFoundationDir")
    .orElse(providers.environmentVariable("SMRT_FOUNDATION_DIR"))
    .orElse("../smrt")
    .get()
val smrtFoundation = file(smrtFoundationDir)

includeBuild(smrtFoundation.resolve("packages/smrt-mobile"))
includeBuild(smrtFoundation.resolve("packages/smrt-android"))

// module build.gradle.kts
dependencies {
    implementation("com.happyvertical.smrt:smrt-android")
}
```

CI should check out `happyvertical/smrt` at a pinned release tag and set
`SMRT_FOUNDATION_DIR` to that checkout. Private cross-organization checkouts
need a GitHub App token or fine-grained PAT with repository read access; see
the complete workflow in [`smrt-mobile`'s README](../smrt-mobile/README.md).

AGP 9 provides built-in Kotlin, so consumers must not apply
`org.jetbrains.kotlin.android`. AGP 9 may otherwise select standard JVM
variants for transitive KMP dependencies; Android modules consuming this
foundation should explicitly request the Android JVM environment:

```kotlin
import org.gradle.api.attributes.java.TargetJvmEnvironment

configurations.configureEach {
    if (isCanBeResolved) {
        attributes.attribute(
            TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE,
            objects.named(TargetJvmEnvironment.ANDROID),
        )
    }
}
```

For durable media queues, pass `AndroidEvidenceByteSource(context)` to
`EvidenceMultipartUpload.toQueueHttpRequest(...)`; it reads file and content
URIs on `Dispatchers.IO` when the queue flushes.

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
