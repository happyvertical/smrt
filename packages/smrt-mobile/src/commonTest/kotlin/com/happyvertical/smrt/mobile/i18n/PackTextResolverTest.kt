package com.happyvertical.smrt.mobile.i18n

import com.happyvertical.smrt.mobile.contract.PackLanguage
import com.happyvertical.smrt.mobile.contract.PackLanguageBundle
import com.happyvertical.smrt.mobile.contract.PackTextSourceRef
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PackTextResolverTest {
    private val language = PackLanguage(
        defaultLocale = "en-US",
        requestedLocales = listOf("fr-CA"),
        includedLocales = listOf("fr-CA", "en-US"),
        fallbackLocale = "en-US",
    )

    private val bundles = listOf(
        PackLanguageBundle(
            locale = "fr-CA",
            reviewState = "approved",
            strings = buildJsonObject {
                put("doc-1.title", "Guide d'installation")
                put("alert-1.message", "Vent trop fort")
            },
            sourceRefs = mapOf(
                "alert-1.message" to PackTextSourceRef(
                    sourceLocale = "en-US",
                    reviewState = "approved",
                    safetyCritical = true,
                ),
            ),
        ),
        PackLanguageBundle(
            locale = "en-US",
            reviewState = "approved",
            strings = buildJsonObject {
                put("doc-1.title", "Installation guide")
                put("doc-2.title", "Fastening schedule")
            },
        ),
    )

    @Test
    fun resolvesRequestedLocaleDirectly() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolve("doc-1.title", sourceText = "Installation guide")

        assertEquals("fr-CA", resolver.locale)
        assertEquals("Guide d'installation", resolved.text)
        assertFalse(resolved.usedFallback)
        assertFalse(resolved.missing)
    }

    @Test
    fun fallsBackToFallbackLocaleWhenKeyMissing() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolve("doc-2.title", sourceText = "Fastening schedule")

        assertEquals("Fastening schedule", resolved.text)
        assertEquals("en-US", resolved.locale)
        assertTrue(resolved.usedFallback)
        assertFalse(resolved.missing)
    }

    @Test
    fun missingEverywhereFallsBackToSourceText() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolve("doc-3.title", sourceText = "Original text")

        assertTrue(resolved.missing)
        assertTrue(resolved.usedFallback)
        assertTrue(resolved.usesSourceFallback)
        assertEquals("Original text", resolved.text)
        assertEquals("source_text", resolved.fallbackReason)
    }

    @Test
    fun missingEverywhereWithoutSourceTextReportsMissingText() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolve("doc-3.title")

        assertTrue(resolved.missing)
        assertFalse(resolved.usesSourceFallback)
        assertEquals("missing_text", resolved.fallbackReason)
        assertEquals("", resolved.text)
    }

    @Test
    fun propagatesSafetyCriticalFromSourceRef() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolve("alert-1.message")

        assertTrue(resolved.safetyCritical)
    }

    @Test
    fun resolveFieldBuildsConventionalKey() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolveField("doc-1", "title")

        assertEquals("doc-1.title", resolved.key)
        assertEquals("Guide d'installation", resolved.text)
    }

    @Test
    fun resolvePreferredFallsBackToIdKey() {
        val resolver = PackTextResolver(language, bundles)
        val resolved = resolver.resolvePreferred(
            preferredKey = "guidance.wind.high",
            fallbackKey = "alert-1.message",
            sourceText = "Wind too strong",
        )

        assertEquals("alert-1.message", resolved.key)
        assertEquals("Vent trop fort", resolved.text)
        assertFalse(resolved.missing)
    }

    @Test
    fun blankReviewStatesDefaultToApprovedEvenWithSourceRef() {
        val resolver = PackTextResolver(
            language = PackLanguage(defaultLocale = "en-US"),
            bundles = listOf(
                PackLanguageBundle(
                    locale = "en-US",
                    reviewState = "",
                    strings = buildJsonObject { put("doc-1.title", "Guide") },
                    sourceRefs = mapOf("doc-1.title" to PackTextSourceRef(reviewState = "")),
                ),
            ),
            requestedLocale = "en-US",
        )

        // The sourceRef path and the no-sourceRef path must agree: a fully
        // blank review state resolves to the "approved" default either way.
        assertEquals("approved", resolver.resolve("doc-1.title").reviewState)
    }

    @Test
    fun blankRequestedLocaleDefaultsSanely() {
        val resolver = PackTextResolver(
            language = PackLanguage(defaultLocale = "", fallbackLocale = ""),
            bundles = emptyList(),
            requestedLocale = "",
        )

        assertEquals("en-US", resolver.locale)
    }
}
