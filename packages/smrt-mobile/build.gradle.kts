plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
    alias(libs.plugins.androidKmpLibrary)
    alias(libs.plugins.sqldelight)
}

// Maven coordinates locked by the Phase 0 decision record (ADR 0001):
// com.happyvertical.smrt:smrt-mobile. Publishing itself is deferred — all
// consumers are local-filesystem today and use Gradle includeBuild/path.
group = "com.happyvertical.smrt"
version = "0.37.3"

kotlin {
    jvmToolchain(21)

    android {
        namespace = "com.happyvertical.smrt.mobile"
        compileSdk = libs.versions.android.compile.sdk.get().toInt()
        minSdk = libs.versions.android.min.sdk.get().toInt()

        withJava()
    }

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
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.datetime)
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.sqldelight.runtime)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
        jvmTest.dependencies {
            // Queue/store tests run against real SQLite on the JVM target —
            // fast and Android-SDK-free on CI. Platform driver factories
            // arrive with smrt-android / smrt-ios (Phases 5-6).
            implementation(libs.sqldelight.sqlite.driver)
        }
    }
}

sqldelight {
    databases {
        create("SmrtMobileDatabase") {
            packageName.set("com.happyvertical.smrt.mobile.db")
            // Schema-evolution guardrail: the checked-in snapshot under
            // src/commonMain/sqldelight/databases pins the current schema
            // version; once devices hold durable data, any schema change
            // needs a .sqm migration and must keep verifyMigrations green.
            // Protocol: packages/smrt-mobile/AGENTS.md § Schema changes.
            schemaOutputDirectory.set(file("src/commonMain/sqldelight/databases"))
            verifyMigrations.set(true)
        }
    }
}
