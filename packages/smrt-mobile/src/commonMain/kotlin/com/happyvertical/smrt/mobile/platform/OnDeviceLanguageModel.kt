package com.happyvertical.smrt.mobile.platform

import kotlinx.serialization.Serializable

/**
 * Shared on-device-LLM seam (the "on-device-LLM abstraction" from ADR 0001;
 * Correction 4 — net-new). Providers: ML Kit GenAI Prompt / Gemini Nano in
 * smrt-android (Phase 5), Foundation Models in smrt-ios (Phase 6). The
 * availability vocabulary is amaru's, kept verbatim so the Phase 7 rebuild
 * maps one-to-one; prompt building and output parsing stay app-side.
 */

@Serializable
data class LanguageModelAvailability(
    val status: String = LanguageModelAvailabilityStatus.HIDDEN_UNAVAILABLE,
    val provider: String = "",
    val modelName: String = "",
    val reason: String = "",
) {
    /** True when the on-device model itself can serve a generate() call. */
    val onDeviceReady: Boolean
        get() = status == LanguageModelAvailabilityStatus.AVAILABLE &&
            provider != LanguageModelProvider.API_FALLBACK
}

object LanguageModelAvailabilityStatus {
    /** The named provider can serve requests now. */
    const val AVAILABLE = "available"

    /** An on-device model exists but needs a download/preparation pass. */
    const val MODEL_NOT_READY = "model_not_ready"

    /** No on-device model; the app may route to its API fallback. */
    const val API_FALLBACK_AVAILABLE = "api_fallback_available"

    /** No on-device model and no fallback — hide the feature. */
    const val HIDDEN_UNAVAILABLE = "hidden_unavailable"
}

object LanguageModelProvider {
    const val ANDROID_ML_KIT_GENAI_PROMPT = "android_ml_kit_genai_prompt"
    const val IOS_FOUNDATION_MODELS = "ios_foundation_models"
    const val API_FALLBACK = "api_fallback"
}

/** Thrown by [OnDeviceLanguageModel.generate] when the model cannot answer. */
class LanguageModelGenerationException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

/** Platform seam: a local generative model with an availability probe. */
interface OnDeviceLanguageModel {
    /** Last known availability, without touching the platform API. */
    fun currentAvailability(): LanguageModelAvailability

    /** Probes the platform for availability; may trigger model download checks. */
    suspend fun checkAvailability(): LanguageModelAvailability

    /**
     * Generates a completion for [prompt] on-device. Throws
     * [LanguageModelGenerationException] when the model is unavailable or
     * returns an unusable answer — callers route to their app-side fallback.
     */
    suspend fun generate(prompt: String): String
}
