package com.happyvertical.smrt.mobile.i18n

import com.happyvertical.smrt.mobile.contract.PackLanguage
import com.happyvertical.smrt.mobile.contract.PackLanguageBundle
import com.happyvertical.smrt.mobile.contract.PackTextSourceRef
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Result of resolving one localized text key: the text plus enough provenance
 * for the UI to badge fallbacks, unreviewed translations, and safety-critical
 * guidance. Seeded from amaru's pack i18n resolver (ADR 0001).
 */
data class ResolvedPackText(
    val key: String,
    val text: String,
    val requestedLocale: String,
    val locale: String,
    val sourceLocale: String,
    val reviewState: String,
    val fallbackReason: String,
    val usedFallback: Boolean,
    val usesSourceFallback: Boolean,
    val missing: Boolean,
    val safetyCritical: Boolean,
)

/**
 * Resolves localized pack text through the requested → fallback → source
 * locale chain. Bundles come from an offline pack's [PackLanguageBundle]s;
 * the source text passed to [resolve] is the untranslated original embedded
 * in the pack's domain payload.
 */
class PackTextResolver(
    private val language: PackLanguage,
    bundles: List<PackLanguageBundle>,
    requestedLocale: String = language.requestedLocales.firstOrNull()
        ?: language.defaultLocale,
) {
    val locale: String = requestedLocale.ifBlank { language.defaultLocale.ifBlank { "en-US" } }

    private val fallbackLocale: String = language.fallbackLocale.ifBlank {
        language.defaultLocale.ifBlank { "en-US" }
    }
    private val bundlesByLocale = bundles.associateBy { it.locale }

    /** Resolves the conventional `"<entityId>.<field>"` key shape. */
    fun resolveField(entityId: String, field: String, sourceText: String = ""): ResolvedPackText =
        resolve(key = "$entityId.$field", sourceText = sourceText)

    /**
     * Resolves [preferredKey] first and falls back to [fallbackKey] when the
     * preferred key is missing — the alert pattern, where a curated text key
     * may point at richer guidance than the alert's own message.
     */
    fun resolvePreferred(
        preferredKey: String?,
        fallbackKey: String,
        sourceText: String = "",
    ): ResolvedPackText {
        val preferred = preferredKey?.takeIf { it.isNotBlank() } ?: fallbackKey
        val resolved = resolve(key = preferred, sourceText = sourceText)

        if (!resolved.missing || preferred == fallbackKey) {
            return resolved
        }

        return resolve(key = fallbackKey, sourceText = sourceText)
    }

    fun resolve(key: String, sourceText: String = ""): ResolvedPackText {
        lookup(locale, key)?.let { entry ->
            return entry.toResolvedText(key = key, sourceText = sourceText, usedFallback = false)
        }

        if (fallbackLocale != locale) {
            lookup(fallbackLocale, key)?.let { entry ->
                return entry.toResolvedText(key = key, sourceText = sourceText, usedFallback = true)
            }
        }

        val sourceLocale = language.defaultLocale.ifBlank { fallbackLocale }
        return ResolvedPackText(
            key = key,
            text = sourceText,
            requestedLocale = locale,
            locale = sourceLocale,
            sourceLocale = sourceLocale,
            reviewState = "missing",
            fallbackReason = if (sourceText.isBlank()) "missing_text" else "source_text",
            usedFallback = true,
            usesSourceFallback = sourceText.isNotBlank(),
            missing = true,
            safetyCritical = false,
        )
    }

    private fun lookup(locale: String, key: String): BundleEntry? {
        val bundle = bundlesByLocale[locale] ?: return null
        val text = bundle.localizedString(key) ?: return null
        return BundleEntry(
            locale = locale,
            text = text,
            bundle = bundle,
            sourceRef = bundle.sourceRefs[key],
        )
    }

    private fun BundleEntry.toResolvedText(
        key: String,
        sourceText: String,
        usedFallback: Boolean,
    ): ResolvedPackText {
        val reviewState = sourceRef?.reviewState
            ?.ifBlank { bundle.reviewState }
            ?: bundle.reviewState.ifBlank { "approved" }
        val fallbackReason = sourceRef?.fallbackReason ?: ""
        val usesSourceFallback = reviewState == "source_fallback" || fallbackReason.isNotBlank()

        return ResolvedPackText(
            key = key,
            text = text.ifBlank { sourceText },
            requestedLocale = this@PackTextResolver.locale,
            locale = locale,
            sourceLocale = sourceRef?.sourceLocale?.ifBlank { fallbackLocale } ?: fallbackLocale,
            reviewState = reviewState,
            fallbackReason = fallbackReason,
            usedFallback = usedFallback || usesSourceFallback,
            usesSourceFallback = usesSourceFallback,
            missing = false,
            safetyCritical = sourceRef?.safetyCritical ?: false,
        )
    }
}

private data class BundleEntry(
    val locale: String,
    val text: String,
    val bundle: PackLanguageBundle,
    val sourceRef: PackTextSourceRef?,
)

private fun PackLanguageBundle.localizedString(key: String): String? {
    val element = strings[key] ?: return null
    return (element as? JsonPrimitive)?.contentOrNull
}
