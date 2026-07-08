// Sample app proving the Phase 5 acceptance criteria (issue #1742): renders
// the shell via smrt-android + smrt-mobile and exercises the barcode /
// speech / on-device-LLM adapters. Never published.
import org.gradle.api.attributes.java.TargetJvmEnvironment

plugins {
    // AGP 9 ships built-in Kotlin — no org.jetbrains.kotlin.android here.
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
}

// Same KMP variant-selection fix as library/build.gradle.kts (AGP 9
// built-in Kotlin does not request the android JVM environment).
configurations.configureEach {
    if (isCanBeResolved) {
        attributes.attribute(
            TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE,
            objects.named(TargetJvmEnvironment.ANDROID),
        )
    }
}

android {
    namespace = "com.happyvertical.smrt.android.sample"
    compileSdk = libs.versions.android.compile.sdk.get().toInt()

    defaultConfig {
        applicationId = "com.happyvertical.smrt.android.sample"
        minSdk = libs.versions.android.min.sdk.get().toInt()
        targetSdk = libs.versions.android.target.sdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(project(":smrt-android"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)
}
