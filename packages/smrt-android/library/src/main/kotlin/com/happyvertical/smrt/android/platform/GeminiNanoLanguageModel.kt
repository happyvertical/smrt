package com.happyvertical.smrt.android.platform

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.prompt.Generation
import com.happyvertical.smrt.mobile.platform.LanguageModelAvailability
import com.happyvertical.smrt.mobile.platform.LanguageModelAvailabilityStatus
import com.happyvertical.smrt.mobile.platform.LanguageModelGenerationException
import com.happyvertical.smrt.mobile.platform.LanguageModelProvider
import com.happyvertical.smrt.mobile.platform.OnDeviceLanguageModel
import kotlinx.coroutines.CancellationException

/**
 * Gemini Nano (ML Kit GenAI Prompt API via AICore) implementation of the
 * shared [OnDeviceLanguageModel] seam, ported from amaru's
 * `AndroidFieldOpsTalkAdapter` (ADR 0001 Phase 5).
 *
 * Deliberate deviation from the seed: the seed folded the app's API
 * fallback into the adapter's availability answers ("FieldOps API"). This
 * adapter reports on-device truth only — `model_not_ready` while Gemini
 * Nano downloads, `hidden_unavailable` when the device has no model — and
 * apps that carry a server-side fallback map those onto
 * `api_fallback_available` in their own availability policy.
 */
class GeminiNanoLanguageModel : OnDeviceLanguageModel {
    @Volatile
    private var lastAvailability: LanguageModelAvailability = LanguageModelAvailability(
        status = LanguageModelAvailabilityStatus.HIDDEN_UNAVAILABLE,
        reason = "gemini_nano_not_checked",
    )

    override fun currentAvailability(): LanguageModelAvailability = lastAvailability

    override suspend fun checkAvailability(): LanguageModelAvailability {
        val availability = try {
            geminiNanoAvailability(Generation.getClient().checkStatus())
        } catch (error: CancellationException) {
            throw error
        } catch (error: GenAiException) {
            unavailable("gemini_nano_check_failed")
        } catch (error: RuntimeException) {
            unavailable("gemini_nano_check_failed")
        }
        lastAvailability = availability
        return availability
    }

    /**
     * Generates on-device and returns the raw model output. Only call once
     * [checkAvailability] reports `available`; prompt building and output
     * parsing are app policy.
     */
    override suspend fun generate(prompt: String): String {
        val rawOutput = try {
            Generation.getClient().generateContent(prompt)
                .candidates.firstOrNull()?.text?.trim()
        } catch (error: CancellationException) {
            throw error
        } catch (error: GenAiException) {
            throw LanguageModelGenerationException("gemini_nano_generation_failed", error)
        } catch (error: RuntimeException) {
            throw LanguageModelGenerationException("gemini_nano_generation_failed", error)
        }
        if (rawOutput.isNullOrBlank()) {
            throw LanguageModelGenerationException("gemini_nano_returned_no_text")
        }
        return rawOutput
    }
}

/** ML Kit `FeatureStatus` → shared [LanguageModelAvailability]. */
internal fun geminiNanoAvailability(featureStatus: Int): LanguageModelAvailability =
    when (featureStatus) {
        FeatureStatus.AVAILABLE -> LanguageModelAvailability(
            status = LanguageModelAvailabilityStatus.AVAILABLE,
            provider = LanguageModelProvider.ANDROID_ML_KIT_GENAI_PROMPT,
            modelName = "Gemini Nano",
        )
        FeatureStatus.DOWNLOADABLE,
        FeatureStatus.DOWNLOADING,
        -> LanguageModelAvailability(
            status = LanguageModelAvailabilityStatus.MODEL_NOT_READY,
            provider = LanguageModelProvider.ANDROID_ML_KIT_GENAI_PROMPT,
            modelName = "Gemini Nano",
            reason = "gemini_nano_not_ready",
        )
        else -> unavailable("gemini_nano_unavailable")
    }

private fun unavailable(reason: String): LanguageModelAvailability = LanguageModelAvailability(
    status = LanguageModelAvailabilityStatus.HIDDEN_UNAVAILABLE,
    reason = reason,
)
