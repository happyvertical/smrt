package com.happyvertical.smrt.mobile.platform

import com.happyvertical.smrt.mobile.contract.MobileDeviceCapabilities
import com.happyvertical.smrt.mobile.contract.MobileDeviceCapability
import com.happyvertical.smrt.mobile.contract.MobileDevicePermissionState

/**
 * Shared device-capability seam, seeded from the reporter's
 * `DeviceCapabilityAdapter` (ADR 0001). The wire DTOs
 * ([MobileDeviceCapabilities] and friends) are owned by the generated
 * contract; this file adds the probe seam plus the string vocabularies the
 * platform adapters emit. The reporter's tri-state permission model is the
 * load-bearing part: `not_determined` (never asked) is distinct from
 * `denied`, so UI can offer a first-time request instead of a settings
 * deep-link.
 */

/** Platform seam: probes current capture-surface capabilities/permissions. */
fun interface DeviceCapabilityAdapter {
    fun currentCapabilities(): MobileDeviceCapabilities
}

/** For tests/previews and platforms without a probe wired yet. */
object NoopDeviceCapabilityAdapter : DeviceCapabilityAdapter {
    override fun currentCapabilities(): MobileDeviceCapabilities = MobileDeviceCapabilities(
        camera = unavailableSurface(DeviceCaptureSurface.CAMERA),
        microphone = unavailableSurface(DeviceCaptureSurface.MICROPHONE),
    )

    private fun unavailableSurface(surface: String): MobileDeviceCapability = MobileDeviceCapability(
        surface = surface,
        supported = false,
        permission = MobileDevicePermissionState(
            status = DevicePermissionStatus.UNAVAILABLE,
            canRequest = false,
            reason = "no_capability_probe",
        ),
        preferredInput = DeviceInputKind.UNAVAILABLE,
    )
}

object DeviceCaptureSurface {
    const val CAMERA = "camera"
    const val MICROPHONE = "microphone"
}

object DevicePermissionStatus {
    const val GRANTED = "granted"
    const val DENIED = "denied"
    const val NOT_DETERMINED = "not_determined"
    const val UNAVAILABLE = "unavailable"
}

object DeviceInputKind {
    const val NATIVE_CAMERA = "native_camera"
    const val NATIVE_MICROPHONE = "native_microphone"
    const val NATIVE_PICKER = "native_picker"
    const val UNAVAILABLE = "unavailable"
}
