import AVFoundation
import CoreLocation
import Foundation
import Photos
import PhotosUI
import SmrtMobile
import UIKit
import UniformTypeIdentifiers

/// iOS implementation of smrt-mobile's `EvidenceCapturePlatformAdapter`
/// (issue #1880; joint iOS+Android design record on that issue). The real
/// KMP-backed conformance amaru never wired up — its `EvidenceCaptureBridge`
/// was a flat 18-field struct that implemented no interface and was dead code.
///
/// **Drive-to-completion**: `captureOrPickPhoto` presents the OS camera
/// (`UIImagePickerController`) or the system photo picker
/// (`PHPickerViewController`), bridges the delegate callback into `async` via a
/// checked continuation, copies the result into `Documents/Evidence/`, computes
/// a SHA-256 pin, verifies the file, and returns a `stored_offline`
/// `EvidenceAssetRef` (or a nil asset on cancel). One awaitable call.
///
/// Simulator has no camera (`isSourceTypeAvailable(.camera) == false`), so it
/// falls back to the photo picker (which works with the simulator's sample
/// photos) — the path the CI native lane exercises. Picker URLs are copied with
/// `startAccessingSecurityScopedResource()` / `defer stop`. Geo travels as an
/// `EvidenceLocationMetadata` **sidecar** (never EXIF, ADR Correction 2); the
/// SHA-256 pin reuses `CryptoKitSha256Hasher`; storage root is the
/// platform-neutral `app_private`.
public final class IOSEvidenceCaptureAdapter: NSObject, EvidenceCapturePlatformAdapter,
    UIImagePickerControllerDelegate, UINavigationControllerDelegate,
    PHPickerViewControllerDelegate, CLLocationManagerDelegate {

    /// Resolves the view controller to present from; defaults to the key
    /// window's top-most controller. Injectable for hosts that manage their own
    /// presentation.
    private let presenter: () -> UIViewController?
    private let locationManager = CLLocationManager()

    // Touched only on the main thread (present setup + UIKit/CoreLocation callbacks).
    private var pendingContinuation: CheckedContinuation<URL?, Error>?
    private var pendingSegment: String = "evidence"
    private var authContinuation: CheckedContinuation<Void, Never>?
    private var fixContinuation: CheckedContinuation<CLLocation?, Never>?

    public init(presenter: (() -> UIViewController?)? = nil) {
        self.presenter = presenter ?? { IOSEvidenceCaptureAdapter.topViewController() }
        super.init()
        locationManager.delegate = self
    }

    // MARK: - EvidenceCapturePlatformAdapter

    public func captureOrPickPhoto(request: EvidenceCaptureRequest) async throws -> EvidenceCaptureResult {
        let segment = Self.evidenceCaptureSegment(request: request)
        let location = try await currentLocationMetadata()

        // Camera hardware presence is not permission: isSourceTypeAvailable(.camera)
        // stays true even when the user denied access, so gate the camera path on
        // authorization (requesting it if undetermined) and fall back to the photo
        // picker on denial — otherwise the camera UI cannot complete a capture.
        let cameraHardware = UIImagePickerController.isSourceTypeAvailable(.camera)
        let wantsCameraSource =
            request.preferredSource == EvidenceCaptureSource.shared.CAMERA && cameraHardware
        let cameraAuthorized = wantsCameraSource ? await resolveCameraAuthorization() : false

        let permissions = EvidenceNativePermissionState(
            cameraStatus: Self.evidenceCameraStatus(
                AVCaptureDevice.authorizationStatus(for: .video),
                cameraAvailable: cameraHardware
            ),
            photoLibraryStatus: Self.evidencePhotoStatus(
                PHPhotoLibrary.authorizationStatus(for: .readWrite)
            ),
            locationStatus: location.permissionStatus
        )

        let source = cameraAuthorized
            ? EvidenceCaptureSource.shared.CAMERA
            : EvidenceCaptureSource.shared.NATIVE_PICKER

        let capturedURL = cameraAuthorized
            ? try await presentCamera(segment: segment)
            : try await presentPhotoPicker(segment: segment)

        guard let url = capturedURL else {
            return EvidenceCaptureResult(
                localAsset: nil,
                location: location,
                permissions: permissions,
                captureAvailable: true,
                userMessage: "Capture cancelled."
            )
        }
        let asset = finalize(url: url, source: source)
        return EvidenceCaptureResult(
            localAsset: asset,
            location: location,
            permissions: permissions,
            captureAvailable: true,
            userMessage: Self.capturedMessage(asset)
        )
    }

    public func currentLocationMetadata() async throws -> EvidenceLocationMetadata {
        var status = locationManager.authorizationStatus
        // Await the user's decision so the sidecar reflects the resolved status,
        // not the stale `notDetermined` — otherwise a first-use grant is missed.
        if status == .notDetermined {
            await awaitAuthorizationDecision()
            status = locationManager.authorizationStatus
        }
        let mapping = Self.mapLocationAuthorization(status)
        var location = locationManager.location
        // No cached fix yet (common right after a first-use grant): request one.
        if mapping == .granted, location == nil {
            location = await requestOneShotFix()
        }
        return Self.evidenceLocationMetadata(
            authorization: mapping,
            snapshot: location.map(Self.snapshot(from:))
        )
    }

    // MARK: - Permission + location resolution

    /// Camera authorization → whether the camera path can proceed. Requests
    /// access when undetermined; denied/restricted routes to the photo picker.
    private func resolveCameraAuthorization() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    /// Awaits the location authorization prompt's resolution (or a safety-net
    /// timeout if the app is backgrounded mid-prompt).
    private func awaitAuthorizationDecision() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            Task { @MainActor in
                self.authContinuation = continuation
                self.locationManager.requestWhenInUseAuthorization()
            }
            Task {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                await MainActor.run { self.resumeAuth() }
            }
        }
    }

    /// Requests a single live fix (bounded), for the common first-use case where
    /// no cached last-known location exists yet.
    private func requestOneShotFix() async -> CLLocation? {
        await withCheckedContinuation { (continuation: CheckedContinuation<CLLocation?, Never>) in
            Task { @MainActor in
                self.fixContinuation = continuation
                self.locationManager.requestLocation()
            }
            Task {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                await MainActor.run { self.resumeFix(nil) }
            }
        }
    }

    private func resumeAuth() {
        let continuation = authContinuation
        authContinuation = nil
        continuation?.resume()
    }

    private func resumeFix(_ location: CLLocation?) {
        let continuation = fixContinuation
        fixContinuation = nil
        continuation?.resume(returning: location)
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // Ignore the initial/undetermined callback; resume only on a real decision.
        guard manager.authorizationStatus != .notDetermined else { return }
        resumeAuth()
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        resumeFix(locations.last)
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        resumeFix(nil)
    }

    // MARK: - Presentation (delegate → async bridge)

    private func presentCamera(segment: String) async throws -> URL? {
        try await withCheckedThrowingContinuation { continuation in
            Task { @MainActor in
                guard self.pendingContinuation == nil else {
                    continuation.resume(throwing: EvidenceCaptureError.captureInProgress)
                    return
                }
                guard let host = self.presenter() else {
                    continuation.resume(throwing: EvidenceCaptureError.noPresenter)
                    return
                }
                self.pendingContinuation = continuation
                self.pendingSegment = segment
                let picker = UIImagePickerController()
                picker.sourceType = .camera
                picker.delegate = self
                host.present(picker, animated: true)
            }
        }
    }

    private func presentPhotoPicker(segment: String) async throws -> URL? {
        try await withCheckedThrowingContinuation { continuation in
            Task { @MainActor in
                guard self.pendingContinuation == nil else {
                    continuation.resume(throwing: EvidenceCaptureError.captureInProgress)
                    return
                }
                guard let host = self.presenter() else {
                    continuation.resume(throwing: EvidenceCaptureError.noPresenter)
                    return
                }
                self.pendingContinuation = continuation
                self.pendingSegment = segment
                var config = PHPickerConfiguration()
                config.filter = .images
                config.selectionLimit = 1
                let picker = PHPickerViewController(configuration: config)
                picker.delegate = self
                host.present(picker, animated: true)
            }
        }
    }

    /// Returns and clears the pending continuation (main-thread only).
    private func takePending() -> CheckedContinuation<URL?, Error>? {
        let continuation = pendingContinuation
        pendingContinuation = nil
        return continuation
    }

    // MARK: - UIImagePickerControllerDelegate (camera)

    public func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        guard let continuation = takePending() else { return }
        guard let image = info[.originalImage] as? UIImage,
              let data = image.jpegData(compressionQuality: 0.95) else {
            continuation.resume(throwing: EvidenceCaptureError.imageEncodingFailed)
            return
        }
        do {
            let url = try writeIntoEvidence(data: data, segment: pendingSegment, ext: "jpg")
            continuation.resume(returning: url)
        } catch {
            continuation.resume(throwing: error)
        }
    }

    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        takePending()?.resume(returning: nil)
    }

    // MARK: - PHPickerViewControllerDelegate (photo library)

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let continuation = takePending() else { return }
        let segment = pendingSegment
        guard let provider = results.first?.itemProvider else {
            continuation.resume(returning: nil)
            return
        }
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] tempURL, error in
            if let error {
                continuation.resume(throwing: error)
                return
            }
            guard let self, let tempURL else {
                continuation.resume(returning: nil)
                return
            }
            // Picker URLs may be security-scoped (e.g. iCloud Drive); harmless no-op otherwise.
            let scoped = tempURL.startAccessingSecurityScopedResource()
            defer { if scoped { tempURL.stopAccessingSecurityScopedResource() } }
            let ext = tempURL.pathExtension.isEmpty ? "jpg" : tempURL.pathExtension.lowercased()
            do {
                let url = try self.copyIntoEvidence(from: tempURL, segment: segment, ext: ext)
                continuation.resume(returning: url)
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    // MARK: - Storage

    private func evidenceDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("Evidence", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func evidenceFileURL(segment: String, ext: String) throws -> URL {
        let assetId = Self.evidenceAssetId(
            segment: segment,
            epochMillis: Int64(Date().timeIntervalSince1970 * 1000)
        )
        return try evidenceDirectory().appendingPathComponent("\(assetId).\(ext)")
    }

    private func writeIntoEvidence(data: Data, segment: String, ext: String) throws -> URL {
        let url = try evidenceFileURL(segment: segment, ext: ext)
        try data.write(to: url, options: .atomic)
        return url
    }

    private func copyIntoEvidence(from source: URL, segment: String, ext: String) throws -> URL {
        let url = try evidenceFileURL(segment: segment, ext: ext)
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        try FileManager.default.copyItem(at: source, to: url)
        return url
    }

    /// Reads the stored file and pins it (size + sha256), mapping to a
    /// `stored_offline` or `missing_local_file` asset.
    private func finalize(url: URL, source: String) -> EvidenceAssetRef {
        let attributeSize = (try? FileManager.default.attributesOfItem(atPath: url.path))
            .flatMap { ($0[.size] as? NSNumber)?.int64Value }
        // Verify by reading the bytes we hash: a read failure must NOT mark the
        // asset stored with the sha256 of empty data (a false-positive pin). Carry
        // the on-disk size (if any) for telemetry, but stay `missing_local_file`.
        let data = try? Data(contentsOf: url)
        let verified = data.map { !$0.isEmpty } ?? false
        let sizeBytes: Int64? = verified ? Int64(data?.count ?? 0) : attributeSize
        let sha = verified ? CryptoKitSha256Hasher.sha256Hex(data: data ?? Data()) : ""
        let nowMillis = Int64(Date().timeIntervalSince1970 * 1000)
        return EvidenceAssetRef(
            assetId: url.deletingPathExtension().lastPathComponent,
            localUri: url.absoluteString,
            fileName: url.lastPathComponent,
            contentType: Self.contentType(forExtension: url.pathExtension),
            sizeBytes: sizeBytes.map { KotlinLong(longLong: $0) },
            sha256: sha,
            captureSource: source,
            originalUri: "",
            storageRoot: "app_private",
            relativePath: "Evidence/\(url.lastPathComponent)",
            storageState: verified
                ? EvidenceAssetStorageState.shared.STORED_OFFLINE
                : EvidenceAssetStorageState.shared.MISSING_LOCAL_FILE,
            offlineSafe: verified,
            persistedAt: verified ? SmrtMobileIos.shared.instantFromEpochMillis(epochMillis: nowMillis) : nil
        )
    }

    // MARK: - Top view controller

    static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
            ?? scenes.compactMap { $0 as? UIWindowScene }.first
        let keyWindow = windowScene?.windows.first { $0.isKeyWindow } ?? windowScene?.windows.first
        var top = keyWindow?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }

    // MARK: - Pure mappings (unit-tested, device-free)

    enum EvidenceLocationAuthorization {
        case granted, denied, notDetermined, unavailable
    }

    struct EvidenceLocationSnapshot {
        let latitude: Double
        let longitude: Double
        let accuracyMeters: Double
        let timestampMillis: Int64
    }

    /// First non-blank context id (sorted by key for determinism), else `evidence`.
    static func evidenceCaptureSegment(request: EvidenceCaptureRequest) -> String {
        let ids = request.contextIds
        let firstValue = ids.keys.sorted()
            .compactMap { key -> String? in
                let value = ids[key] ?? ""
                return value.trimmingCharacters(in: .whitespaces).isEmpty ? nil : value
            }
            .first
        guard let firstValue else { return "evidence" }
        return sanitizeSegment(firstValue)
    }

    static func sanitizeSegment(_ value: String) -> String {
        let sanitized = value.replacingOccurrences(
            of: "[^A-Za-z0-9_-]",
            with: "_",
            options: .regularExpression
        )
        return sanitized.isEmpty ? "evidence" : sanitized
    }

    static func evidenceAssetId(segment: String, epochMillis: Int64) -> String {
        "asset_\(segment)_\(epochMillis)"
    }

    static func contentType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "heic", "heif": return "image/heic"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        default: return "image/jpeg"
        }
    }

    static func evidenceCameraStatus(_ status: AVAuthorizationStatus, cameraAvailable: Bool) -> String {
        guard cameraAvailable else { return EvidencePermissionStatus.shared.UNAVAILABLE }
        switch status {
        case .authorized: return EvidencePermissionStatus.shared.GRANTED
        case .denied, .restricted: return EvidencePermissionStatus.shared.DENIED
        case .notDetermined: return EvidencePermissionStatus.shared.NOT_DETERMINED
        @unknown default: return EvidencePermissionStatus.shared.UNAVAILABLE
        }
    }

    static func evidencePhotoStatus(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized, .limited: return EvidencePermissionStatus.shared.GRANTED
        case .denied, .restricted: return EvidencePermissionStatus.shared.DENIED
        case .notDetermined: return EvidencePermissionStatus.shared.NOT_DETERMINED
        @unknown default: return EvidencePermissionStatus.shared.UNAVAILABLE
        }
    }

    static func mapLocationAuthorization(_ status: CLAuthorizationStatus) -> EvidenceLocationAuthorization {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: return .granted
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unavailable
        }
    }

    static func snapshot(from location: CLLocation) -> EvidenceLocationSnapshot {
        EvidenceLocationSnapshot(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            timestampMillis: Int64(location.timestamp.timeIntervalSince1970 * 1000)
        )
    }

    /// Pure projection of location authorization + last-known fix onto the sidecar.
    static func evidenceLocationMetadata(
        authorization: EvidenceLocationAuthorization,
        snapshot: EvidenceLocationSnapshot?
    ) -> EvidenceLocationMetadata {
        switch authorization {
        case .denied:
            return unavailableLocation(EvidencePermissionStatus.shared.DENIED, "permission_denied")
        case .notDetermined:
            return unavailableLocation(EvidencePermissionStatus.shared.NOT_DETERMINED, "permission_not_requested")
        case .unavailable:
            return unavailableLocation(EvidencePermissionStatus.shared.UNAVAILABLE, "authorization_unknown")
        case .granted:
            guard let snapshot else {
                return unavailableLocation(EvidencePermissionStatus.shared.GRANTED, "last_location_unavailable")
            }
            return EvidenceLocationMetadata(
                permissionStatus: EvidencePermissionStatus.shared.GRANTED,
                gpsStatus: "available",
                latitude: String(snapshot.latitude),
                longitude: String(snapshot.longitude),
                accuracyMeters: String(snapshot.accuracyMeters),
                provider: "core_location",
                capturedAt: SmrtMobileIos.shared.instantFromEpochMillis(epochMillis: snapshot.timestampMillis),
                unavailableReason: ""
            )
        }
    }

    private static func unavailableLocation(_ permissionStatus: String, _ reason: String) -> EvidenceLocationMetadata {
        EvidenceLocationMetadata(
            permissionStatus: permissionStatus,
            gpsStatus: "unavailable",
            latitude: "",
            longitude: "",
            accuracyMeters: "",
            provider: "",
            capturedAt: nil,
            unavailableReason: reason
        )
    }

    static func capturedMessage(_ asset: EvidenceAssetRef) -> String {
        if asset.storageState == EvidenceAssetStorageState.shared.STORED_OFFLINE {
            return "Evidence stored offline (\(asset.sizeBytes?.int64Value ?? 0) bytes)."
        }
        return "Capture could not be verified; the local file is missing."
    }
}

enum EvidenceCaptureError: Error {
    case noPresenter
    case imageEncodingFailed
    case captureInProgress
}
