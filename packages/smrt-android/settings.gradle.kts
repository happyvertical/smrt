pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "smrt-android"

// Local-filesystem consumption per the ADR 0001 Phase 0 decision: the
// com.happyvertical.smrt:smrt-mobile dependency is satisfied by composite
// build substitution, not a Maven repository.
includeBuild("../smrt-mobile")

// The published module keeps the package name (substitution target
// com.happyvertical.smrt:smrt-android); the sample app is never published.
include(":smrt-android")
project(":smrt-android").projectDir = file("library")
include(":sample")
