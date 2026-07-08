import org.gradle.api.attributes.java.TargetJvmEnvironment

plugins {
    // AGP 9 ships built-in Kotlin — no org.jetbrains.kotlin.android here.
    alias(libs.plugins.androidLibrary)
    alias(libs.plugins.composeCompiler)
}

// AGP 9 built-in Kotlin does not request KMP variant attributes the way
// the Kotlin Android plugin did, so multiplatform dependencies reaching
// this build through smrt-mobile (ktor, kotlinx) resolve to their
// standard-jvm variants — which the app half then fails to dex. Requesting
// the android environment restores the androidJvm variant selection.
configurations.configureEach {
    if (isCanBeResolved) {
        attributes.attribute(
            TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE,
            objects.named(TargetJvmEnvironment.ANDROID),
        )
    }
}

// Maven coordinates locked by the Phase 0 decision record (ADR 0001):
// com.happyvertical.smrt:smrt-android. Publishing itself is deferred — all
// consumers are local-filesystem today and use Gradle includeBuild.
group = "com.happyvertical.smrt"
version = "0.38.14"

android {
    namespace = "com.happyvertical.smrt.android"
    compileSdk = libs.versions.android.compile.sdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.android.min.sdk.get().toInt()
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // api: consumers program against smrt-mobile's shared types
    // (MobileShellState, the platform seams) through this library.
    api(libs.smrt.mobile)

    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.datetime)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.androidx.core.ktx)
    // ComponentActivity + ActivityResultContracts/Registry drive the evidence
    // camera/picker capture; only activity-compose (sample) had this before.
    implementation(libs.androidx.activity)
    implementation(libs.androidx.browser)
    // Directly imported (LocalLifecycleOwner) — declared, not left to a
    // compose-ui transitive.
    implementation(libs.androidx.lifecycle.runtime.compose)

    // api: these types appear in the library's public signatures
    // (ImageCapture/ImageAnalysis.Analyzer on the barcode surface, SqlDriver
    // from the driver factory) — consumers must compile against them.
    api(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.mlkit.genai.prompt)

    api(libs.sqldelight.android.driver)

    testImplementation(libs.kotlin.test.junit)
    testImplementation(libs.junit)
}
