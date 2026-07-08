import AVFoundation
import Foundation
import SmrtMobile

/// iOS implementation of smrt-mobile's `DeviceCapabilityAdapter` seam. The
/// load-bearing part is the **tri-state permission model** — `not_determined`
/// (never asked; offer a first-time request) is distinct from `denied` (route to
/// Settings). iOS reports this tri-state natively through `AVAuthorizationStatus`,
/// so — unlike Android — no request-history injection is needed.
///
/// Status/reason strings and capture surfaces are byte-identical to the Android
/// adapter so the shared consumers (e.g. a Settings pill) render the same.
public final class IOSDeviceCapabilityAdapter: NSObject, DeviceCapabilityAdapter {
    public override init() { super.init() }

    public func currentCapabilities() -> MobileDeviceCapabilities {
        MobileDeviceCapabilities(
            camera: cameraCapability(),
            microphone: microphoneCapability(),
            checkedAtEpochMillis: KotlinLong(longLong: Int64(Date().timeIntervalSince1970 * 1000))
        )
    }

    private func cameraCapability() -> MobileDeviceCapability {
        let supported = AVCaptureDevice.default(for: .video) != nil
        return capability(
            surface: DeviceCaptureSurface.shared.CAMERA,
            label: "Camera",
            supported: supported,
            authorization: AVCaptureDevice.authorizationStatus(for: .video),
            preferredInput: DeviceInputKind.shared.NATIVE_CAMERA
        )
    }

    private func microphoneCapability() -> MobileDeviceCapability {
        let supported = AVAudioSession.sharedInstance().isInputAvailable
        return capability(
            surface: DeviceCaptureSurface.shared.MICROPHONE,
            label: "Microphone",
            supported: supported,
            authorization: AVCaptureDevice.authorizationStatus(for: .audio),
            preferredInput: DeviceInputKind.shared.NATIVE_MICROPHONE
        )
    }

    private func capability(
        surface: String,
        label: String,
        supported: Bool,
        authorization: AVAuthorizationStatus,
        preferredInput: String
    ) -> MobileDeviceCapability {
        let permission: MobileDevicePermissionState = supported
            ? Self.permissionState(for: Self.mapAuthorization(authorization))
            : MobileDevicePermissionState(
                status: DevicePermissionStatus.shared.UNAVAILABLE,
                canRequest: false,
                reason: "hardware_unavailable"
            )

        return MobileDeviceCapability(
            surface: surface,
            label: label,
            supported: supported,
            permission: permission,
            preferredInput: supported ? preferredInput : DeviceInputKind.shared.UNAVAILABLE
        )
    }

    // MARK: - Pure, testable mapping (the tri-state core)

    /// The load-bearing tri-state distinction: `.notDetermined` ≠ `.denied`.
    enum PermissionMapping {
        case granted, denied, notDetermined
    }

    static func mapAuthorization(_ status: AVAuthorizationStatus) -> PermissionMapping {
        switch status {
        case .authorized: return .granted
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        @unknown default: return .denied
        }
    }

    static func permissionState(for mapping: PermissionMapping) -> MobileDevicePermissionState {
        switch mapping {
        case .granted:
            return MobileDevicePermissionState(
                status: DevicePermissionStatus.shared.GRANTED,
                canRequest: false,
                reason: nil
            )
        case .notDetermined:
            return MobileDevicePermissionState(
                status: DevicePermissionStatus.shared.NOT_DETERMINED,
                canRequest: true,
                reason: "permission_not_requested"
            )
        case .denied:
            return MobileDevicePermissionState(
                status: DevicePermissionStatus.shared.DENIED,
                canRequest: false,
                reason: "permission_denied"
            )
        }
    }
}
