package com.happyvertical.smrt.android.platform

import android.speech.SpeechRecognizer
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.vision.barcode.common.Barcode
import com.happyvertical.smrt.mobile.platform.BarcodeFormat
import com.happyvertical.smrt.mobile.platform.LanguageModelAvailabilityStatus
import com.happyvertical.smrt.mobile.platform.LanguageModelProvider
import com.happyvertical.smrt.mobile.platform.SpeechErrorCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The adapters' platform-to-shared mappings are pure functions over
 * compile-time constants, so they run as plain local unit tests — behavior
 * needing a device (camera frames, recognizer sessions, AICore) is
 * exercised by the sample app instead.
 */
class AdapterMappingTest {
    @Test
    fun mlKitBarcodeFormatsMapToSharedLabels() {
        assertEquals(BarcodeFormat.QR_CODE, barcodeFormatLabel(Barcode.FORMAT_QR_CODE))
        assertEquals(BarcodeFormat.EAN_13, barcodeFormatLabel(Barcode.FORMAT_EAN_13))
        assertEquals(BarcodeFormat.CODE_128, barcodeFormatLabel(Barcode.FORMAT_CODE_128))
        assertEquals(BarcodeFormat.UNKNOWN, barcodeFormatLabel(-42))
    }

    @Test
    fun sharedLabelsMapBackToMlKitFormatsDroppingUnknowns() {
        assertEquals(
            listOf(Barcode.FORMAT_QR_CODE, Barcode.FORMAT_EAN_13),
            mlKitBarcodeFormats(listOf(BarcodeFormat.QR_CODE, "not_a_format", BarcodeFormat.EAN_13)),
        )
        assertTrue(mlKitBarcodeFormats(emptyList()).isEmpty())
    }

    @Test
    fun speechErrorsMapToSharedCodes() {
        assertEquals(SpeechErrorCode.AUDIO_ERROR, speechErrorLabel(SpeechRecognizer.ERROR_AUDIO))
        assertEquals(
            SpeechErrorCode.PERMISSION_DENIED,
            speechErrorLabel(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS),
        )
        assertEquals(SpeechErrorCode.NO_MATCH, speechErrorLabel(SpeechRecognizer.ERROR_NO_MATCH))
        assertEquals("unknown_error_99", speechErrorLabel(99))
    }

    @Test
    fun geminiNanoFeatureStatusMapsToOnDeviceTruth() {
        val available = geminiNanoAvailability(FeatureStatus.AVAILABLE)
        assertEquals(LanguageModelAvailabilityStatus.AVAILABLE, available.status)
        assertEquals(LanguageModelProvider.ANDROID_ML_KIT_GENAI_PROMPT, available.provider)
        assertTrue(available.onDeviceReady)

        val downloading = geminiNanoAvailability(FeatureStatus.DOWNLOADING)
        assertEquals(LanguageModelAvailabilityStatus.MODEL_NOT_READY, downloading.status)
        assertEquals("gemini_nano_not_ready", downloading.reason)

        val unavailable = geminiNanoAvailability(FeatureStatus.UNAVAILABLE)
        assertEquals(LanguageModelAvailabilityStatus.HIDDEN_UNAVAILABLE, unavailable.status)
    }

    @Test
    fun sha256HasherProducesKnownVector() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            AndroidSha256Hasher.sha256Hex("abc".encodeToByteArray()),
        )
    }
}
