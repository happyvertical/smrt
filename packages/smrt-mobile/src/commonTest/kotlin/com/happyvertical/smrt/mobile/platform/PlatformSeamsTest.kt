package com.happyvertical.smrt.mobile.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PlatformSeamsTest {
    @Test
    fun languageModelIsOnDeviceReadyOnlyWhenAvailableFromARealProvider() {
        val ready = LanguageModelAvailability(
            status = LanguageModelAvailabilityStatus.AVAILABLE,
            provider = LanguageModelProvider.ANDROID_ML_KIT_GENAI_PROMPT,
            modelName = "Gemini Nano",
        )
        assertTrue(ready.onDeviceReady)

        val fallbackOnly = ready.copy(provider = LanguageModelProvider.API_FALLBACK)
        assertFalse(fallbackOnly.onDeviceReady)

        val notReady = ready.copy(status = LanguageModelAvailabilityStatus.MODEL_NOT_READY)
        assertFalse(notReady.onDeviceReady)
    }

    @Test
    fun languageModelAvailabilityDefaultsToHidden() {
        val availability = LanguageModelAvailability()
        assertEquals(LanguageModelAvailabilityStatus.HIDDEN_UNAVAILABLE, availability.status)
        assertFalse(availability.onDeviceReady)
    }

    @Test
    fun unknownSpeechErrorCodesCarryTheNativeCode() {
        assertEquals("unknown_error_12", SpeechErrorCode.unknown(12))
    }

    @Test
    fun noopCapabilityAdapterReportsBothSurfacesUnavailable() {
        val capabilities = NoopDeviceCapabilityAdapter.currentCapabilities()
        assertEquals(DeviceCaptureSurface.CAMERA, capabilities.camera.surface)
        assertEquals(DeviceCaptureSurface.MICROPHONE, capabilities.microphone.surface)
        for (capability in listOf(capabilities.camera, capabilities.microphone)) {
            assertFalse(capability.supported)
            assertEquals(DevicePermissionStatus.UNAVAILABLE, capability.permission.status)
            assertFalse(capability.permission.canRequest)
            assertEquals(DeviceInputKind.UNAVAILABLE, capability.preferredInput)
        }
    }

    @Test
    fun barcodeScanRequestDefaultsToAllFormats() {
        assertTrue(BarcodeScanRequest().formats.isEmpty())
        assertEquals(BarcodeFormat.UNKNOWN, BarcodeScan(rawValue = "123").format)
    }
}
