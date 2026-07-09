import AVFoundation
import CoreLocation
import Foundation
import Photos
import XCTest

@testable import SmrtIos
import SmrtMobile

/// Pure-mapping tests for the evidence adapter (issue #1880) — the native
/// state → shared-DTO projection, exercised device-free. The camera/picker
/// drive itself needs an on-device UI and is verified by the sample app.
final class EvidenceCaptureMappingTests: XCTestCase {

    func testFoundationEvidenceByteSourceBulkLoadsLocalFile() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let file = directory.appendingPathComponent("asset.jpg")
        let expected = Data("bulk-evidence-bytes".utf8)
        try expected.write(to: file)
        let asset = EvidenceAssetRef(
            assetId: "asset-1",
            localUri: file.absoluteString,
            fileName: file.lastPathComponent,
            contentType: "image/jpeg",
            sizeBytes: KotlinLong(longLong: Int64(expected.count)),
            sha256: "",
            captureSource: EvidenceCaptureSource.shared.NATIVE_PICKER,
            originalUri: "",
            storageRoot: "app_private",
            relativePath: file.lastPathComponent,
            storageState: EvidenceAssetStorageState.shared.STORED_OFFLINE,
            offlineSafe: true,
            persistedAt: nil
        )

        let bytes = try await FoundationEvidenceByteSource(baseDirectory: directory)
            .readBytes(asset: asset)

        XCTAssertEqual(bytes.size, Int32(expected.count))
        XCTAssertEqual(
            Data((0..<bytes.size).map { UInt8(bitPattern: bytes.get(index: $0)) }),
            expected
        )
    }

    func testFoundationEvidenceByteSourceRejectsRelativePathOutsideBaseDirectory() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let directory = root.appendingPathComponent("evidence", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let asset = EvidenceAssetRef(
            assetId: "asset-outside",
            localUri: "",
            fileName: "outside.jpg",
            contentType: "image/jpeg",
            sizeBytes: nil,
            sha256: "",
            captureSource: EvidenceCaptureSource.shared.NATIVE_PICKER,
            originalUri: "",
            storageRoot: "app_private",
            relativePath: "../outside.jpg",
            storageState: EvidenceAssetStorageState.shared.STORED_OFFLINE,
            offlineSafe: true,
            persistedAt: nil
        )

        do {
            _ = try await FoundationEvidenceByteSource(baseDirectory: directory)
                .readBytes(asset: asset)
            XCTFail("Expected traversal outside the base directory to be rejected")
        } catch let error as FoundationEvidenceByteSourceError {
            guard case let .pathOutsideBaseDirectory(assetId) = error else {
                return XCTFail("Unexpected evidence byte-source error: \(error)")
            }
            XCTAssertEqual(assetId, "asset-outside")
        }
    }

    func testCaptureSegmentPicksFirstNonBlankBySortedKey() {
        XCTAssertEqual(
            IOSEvidenceCaptureAdapter.evidenceCaptureSegment(
                request: EvidenceCaptureRequest(
                    tenantId: "",
                    contextIds: ["checklistItemId": "checklist-1"],
                    preferredSource: EvidenceCaptureSource.shared.CAMERA
                )
            ),
            "checklist-1"
        )
        // Sorted by key → "a" wins over "z" (deterministic regardless of order).
        XCTAssertEqual(
            IOSEvidenceCaptureAdapter.evidenceCaptureSegment(
                request: EvidenceCaptureRequest(
                    tenantId: "",
                    contextIds: ["z": "second", "a": "first"],
                    preferredSource: EvidenceCaptureSource.shared.CAMERA
                )
            ),
            "first"
        )
        XCTAssertEqual(
            IOSEvidenceCaptureAdapter.evidenceCaptureSegment(
                request: EvidenceCaptureRequest(
                    tenantId: "",
                    contextIds: [:],
                    preferredSource: EvidenceCaptureSource.shared.CAMERA
                )
            ),
            "evidence"
        )
    }

    func testSanitizeSegmentStripsUnsafeCharacters() {
        XCTAssertEqual(IOSEvidenceCaptureAdapter.sanitizeSegment("a/b c"), "a_b_c")
        XCTAssertEqual(IOSEvidenceCaptureAdapter.sanitizeSegment("keep-this_1"), "keep-this_1")
        XCTAssertEqual(IOSEvidenceCaptureAdapter.sanitizeSegment(""), "evidence")
    }

    func testAssetIdComposesSegmentAndEpochMillis() {
        XCTAssertEqual(
            IOSEvidenceCaptureAdapter.evidenceAssetId(segment: "checklist-1", epochMillis: 1700),
            "asset_checklist-1_1700"
        )
    }

    func testContentTypeFromExtension() {
        XCTAssertEqual(IOSEvidenceCaptureAdapter.contentType(forExtension: "jpg"), "image/jpeg")
        XCTAssertEqual(IOSEvidenceCaptureAdapter.contentType(forExtension: "PNG"), "image/png")
        XCTAssertEqual(IOSEvidenceCaptureAdapter.contentType(forExtension: "heic"), "image/heic")
        XCTAssertEqual(IOSEvidenceCaptureAdapter.contentType(forExtension: "bin"), "image/jpeg")
    }

    func testCameraStatusMapsAuthorizationAndAvailability() {
        let p = EvidencePermissionStatus.shared
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidenceCameraStatus(.authorized, cameraAvailable: true), p.GRANTED)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidenceCameraStatus(.denied, cameraAvailable: true), p.DENIED)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidenceCameraStatus(.notDetermined, cameraAvailable: true), p.NOT_DETERMINED)
        // No camera (e.g. simulator) → unavailable regardless of authorization.
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidenceCameraStatus(.authorized, cameraAvailable: false), p.UNAVAILABLE)
    }

    func testPhotoStatusMapsAuthorization() {
        let p = EvidencePermissionStatus.shared
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidencePhotoStatus(.authorized), p.GRANTED)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidencePhotoStatus(.limited), p.GRANTED)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidencePhotoStatus(.denied), p.DENIED)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.evidencePhotoStatus(.notDetermined), p.NOT_DETERMINED)
    }

    func testLocationAuthorizationMapsToTriState() {
        XCTAssertEqual(IOSEvidenceCaptureAdapter.mapLocationAuthorization(.authorizedWhenInUse), .granted)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.mapLocationAuthorization(.authorizedAlways), .granted)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.mapLocationAuthorization(.denied), .denied)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.mapLocationAuthorization(.restricted), .denied)
        XCTAssertEqual(IOSEvidenceCaptureAdapter.mapLocationAuthorization(.notDetermined), .notDetermined)
    }

    func testLocationMetadataProjection() {
        let p = EvidencePermissionStatus.shared

        let denied = IOSEvidenceCaptureAdapter.evidenceLocationMetadata(authorization: .denied, snapshot: nil)
        XCTAssertEqual(denied.gpsStatus, "unavailable")
        XCTAssertEqual(denied.permissionStatus, p.DENIED)
        XCTAssertEqual(denied.unavailableReason, "permission_denied")

        let notDetermined = IOSEvidenceCaptureAdapter.evidenceLocationMetadata(authorization: .notDetermined, snapshot: nil)
        XCTAssertEqual(notDetermined.permissionStatus, p.NOT_DETERMINED)
        XCTAssertEqual(notDetermined.unavailableReason, "permission_not_requested")

        let noFix = IOSEvidenceCaptureAdapter.evidenceLocationMetadata(authorization: .granted, snapshot: nil)
        XCTAssertEqual(noFix.permissionStatus, p.GRANTED)
        XCTAssertEqual(noFix.unavailableReason, "last_location_unavailable")

        let snapshot = IOSEvidenceCaptureAdapter.EvidenceLocationSnapshot(
            latitude: 45.5,
            longitude: -73.6,
            accuracyMeters: 8,
            timestampMillis: 1_700_000_000_000
        )
        let available = IOSEvidenceCaptureAdapter.evidenceLocationMetadata(authorization: .granted, snapshot: snapshot)
        XCTAssertEqual(available.gpsStatus, "available")
        XCTAssertEqual(available.permissionStatus, p.GRANTED)
        XCTAssertEqual(available.latitude, "45.5")
        XCTAssertEqual(available.longitude, "-73.6")
        XCTAssertEqual(available.accuracyMeters, "8.0")
        XCTAssertEqual(available.provider, "core_location")
    }
}
