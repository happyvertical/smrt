package com.happyvertical.smrt.android.platform

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import com.happyvertical.smrt.mobile.contract.MobileDeviceCapabilities
import com.happyvertical.smrt.mobile.contract.MobileDeviceCapability
import com.happyvertical.smrt.mobile.contract.MobileDevicePermissionState
import com.happyvertical.smrt.mobile.platform.DeviceCapabilityAdapter
import com.happyvertical.smrt.mobile.platform.DeviceCaptureSurface
import com.happyvertical.smrt.mobile.platform.DeviceInputKind
import com.happyvertical.smrt.mobile.platform.DevicePermissionStatus

/**
 * Android implementation of the shared [DeviceCapabilityAdapter] seam,
 * ported from the reporter (ADR 0001 Phase 5). The load-bearing part is the
 * tri-state permission model: `not_determined` (never asked — offer a
 * first-time request) is distinct from `denied` (route to settings when
 * rationale is exhausted). That distinction needs the app's request
 * history, injected as [AndroidPermissionRequestHistory]; the default
 * treats every permission as never-requested.
 *
 * Pass the current [Activity] as [context] where possible — rationale
 * checks need one; with a plain context, denied permissions report
 * `permission_denied_blocked_or_unavailable`.
 */
class AndroidDeviceCapabilityAdapter(
    private val context: Context,
    private val permissionRequestHistory: AndroidPermissionRequestHistory =
        UnknownAndroidPermissionRequestHistory,
) : DeviceCapabilityAdapter {
    override fun currentCapabilities(): MobileDeviceCapabilities = MobileDeviceCapabilities(
        camera = capability(
            surface = DeviceCaptureSurface.CAMERA,
            label = "Camera",
            feature = PackageManager.FEATURE_CAMERA_ANY,
            permission = Manifest.permission.CAMERA,
            preferredInput = DeviceInputKind.NATIVE_CAMERA,
        ),
        microphone = capability(
            surface = DeviceCaptureSurface.MICROPHONE,
            label = "Microphone",
            feature = PackageManager.FEATURE_MICROPHONE,
            permission = Manifest.permission.RECORD_AUDIO,
            preferredInput = DeviceInputKind.NATIVE_MICROPHONE,
        ),
        checkedAtEpochMillis = System.currentTimeMillis(),
    )

    private fun capability(
        surface: String,
        label: String,
        feature: String,
        permission: String,
        preferredInput: String,
    ): MobileDeviceCapability {
        val supported = context.packageManager.hasSystemFeature(feature)
        val permissionState = if (supported) {
            permissionState(permission)
        } else {
            MobileDevicePermissionState(
                status = DevicePermissionStatus.UNAVAILABLE,
                canRequest = false,
                reason = "hardware_unavailable",
            )
        }

        return MobileDeviceCapability(
            surface = surface,
            label = label,
            supported = supported,
            permission = permissionState,
            preferredInput = if (supported) preferredInput else DeviceInputKind.UNAVAILABLE,
        )
    }

    private fun permissionState(permission: String): MobileDevicePermissionState {
        if (context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            return MobileDevicePermissionState(
                status = DevicePermissionStatus.GRANTED,
                canRequest = false,
            )
        }

        if (!permissionRequestHistory.hasRequested(permission)) {
            return MobileDevicePermissionState(
                status = DevicePermissionStatus.NOT_DETERMINED,
                canRequest = true,
                reason = "permission_not_requested",
            )
        }

        val canRequestAgain = (context as? Activity)
            ?.shouldShowRequestPermissionRationale(permission)
            ?: false
        return MobileDevicePermissionState(
            status = DevicePermissionStatus.DENIED,
            canRequest = canRequestAgain,
            reason = if (canRequestAgain) {
                "permission_denied"
            } else {
                "permission_denied_blocked_or_unavailable"
            },
        )
    }
}

/** Has the app ever fired a system request dialog for [hasRequested]'s permission? */
fun interface AndroidPermissionRequestHistory {
    fun hasRequested(permission: String): Boolean
}

/** Default history: assume never requested (first ask stays `not_determined`). */
object UnknownAndroidPermissionRequestHistory : AndroidPermissionRequestHistory {
    override fun hasRequested(permission: String): Boolean = false
}
