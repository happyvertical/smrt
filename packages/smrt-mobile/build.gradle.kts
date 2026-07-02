plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.androidLibrary)
}

// Maven coordinates locked by the Phase 0 decision record (ADR 0001):
// com.happyvertical.smrt:smrt-mobile. Publishing itself is deferred — all
// consumers are local-filesystem today and use Gradle includeBuild/path.
group = "com.happyvertical.smrt"
version = "0.37.3"

kotlin {
    jvmToolchain(21)

    androidTarget()
    // Pure-JVM target so common logic tests run anywhere (CI machines and dev
    // hosts without an Android SDK): `./gradlew jvmTest`.
    jvm()

    listOf(
        iosX64(),
        iosArm64(),
        iosSimulatorArm64(),
    ).forEach { iosTarget ->
        iosTarget.binaries.framework {
            baseName = "SmrtMobile"
            isStatic = true
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.datetime)
            implementation(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}

android {
    namespace = "com.happyvertical.smrt.mobile"
    compileSdk = libs.versions.android.compile.sdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.android.min.sdk.get().toInt()
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}
