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
