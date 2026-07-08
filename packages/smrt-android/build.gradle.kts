// Umbrella build — modules live in library/ (:smrt-android) and sample/.
plugins {
    alias(libs.plugins.androidLibrary) apply false
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.composeCompiler) apply false
}
