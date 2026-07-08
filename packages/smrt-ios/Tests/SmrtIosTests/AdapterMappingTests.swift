import AVFoundation
import Foundation
import Vision
import XCTest

@testable import SmrtIos
import SmrtMobile

/// Pure-mapping tests — the iOS analog of Android's `AdapterMappingTest`. These
/// exercise the deterministic seam-vocabulary mappings without a device.
final class AdapterMappingTests: XCTestCase {

    // MARK: SHA-256

    func testSha256KnownAnswerVector() {
        XCTAssertEqual(
            CryptoKitSha256Hasher.sha256Hex(data: Data("abc".utf8)),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
    }

    // MARK: Device-capability tri-state (not_determined ≠ denied)

    func testAuthorizationMapsToTriState() {
        XCTAssertEqual(IOSDeviceCapabilityAdapter.mapAuthorization(.authorized), .granted)
        XCTAssertEqual(IOSDeviceCapabilityAdapter.mapAuthorization(.notDetermined), .notDetermined)
        XCTAssertEqual(IOSDeviceCapabilityAdapter.mapAuthorization(.denied), .denied)
        XCTAssertEqual(IOSDeviceCapabilityAdapter.mapAuthorization(.restricted), .denied)
    }

    func testNotDeterminedIsDistinctFromDenied() {
        // The load-bearing distinction: never-asked offers a first request;
        // denied routes to Settings.
        XCTAssertNotEqual(
            IOSDeviceCapabilityAdapter.mapAuthorization(.notDetermined),
            IOSDeviceCapabilityAdapter.mapAuthorization(.denied)
        )
    }

    func testPermissionStateStringsMatchSharedVocabulary() {
        XCTAssertEqual(
            IOSDeviceCapabilityAdapter.permissionState(for: .granted).status,
            DevicePermissionStatus.shared.GRANTED
        )
        let notDetermined = IOSDeviceCapabilityAdapter.permissionState(for: .notDetermined)
        XCTAssertEqual(notDetermined.status, DevicePermissionStatus.shared.NOT_DETERMINED)
        XCTAssertTrue(notDetermined.canRequest)
        XCTAssertEqual(notDetermined.reason, "permission_not_requested")

        let denied = IOSDeviceCapabilityAdapter.permissionState(for: .denied)
        XCTAssertEqual(denied.status, DevicePermissionStatus.shared.DENIED)
        XCTAssertFalse(denied.canRequest)
    }

    // MARK: Foundation Models availability — on-device truth only

    func testFoundationModelsReportsOnDeviceTruthOnly() {
        let available = FoundationModelsLanguageModel.availability(for: .available)
        XCTAssertEqual(available.status, LanguageModelAvailabilityStatus.shared.AVAILABLE)
        XCTAssertEqual(available.provider, LanguageModelProvider.shared.IOS_FOUNDATION_MODELS)
        XCTAssertTrue(available.onDeviceReady)

        XCTAssertEqual(
            FoundationModelsLanguageModel.availability(for: .modelNotReady).status,
            LanguageModelAvailabilityStatus.shared.MODEL_NOT_READY
        )

        // deviceNotEligible / not-enabled / unsupported-OS → hidden, NEVER
        // api_fallback_available (that is app policy, per the GeminiNano rationale).
        for kind in [
            FoundationModelsLanguageModel.AvailabilityKind.deviceNotEligible,
            .appleIntelligenceNotEnabled,
            .unsupportedOS,
        ] {
            let availability = FoundationModelsLanguageModel.availability(for: kind)
            XCTAssertEqual(availability.status, LanguageModelAvailabilityStatus.shared.HIDDEN_UNAVAILABLE)
            XCTAssertNotEqual(availability.status, LanguageModelAvailabilityStatus.shared.API_FALLBACK_AVAILABLE)
            XCTAssertFalse(availability.onDeviceReady)
        }
    }

    // MARK: Barcode format labels ↔ symbologies

    func testBarcodeFormatLabels() {
        let f = BarcodeFormat.shared
        XCTAssertEqual(DataScannerBarcodeScanner.barcodeFormatLabel(for: .qr), f.QR_CODE)
        XCTAssertEqual(DataScannerBarcodeScanner.barcodeFormatLabel(for: .ean13), f.EAN_13)
        XCTAssertEqual(DataScannerBarcodeScanner.barcodeFormatLabel(for: .code128), f.CODE_128)
        XCTAssertEqual(DataScannerBarcodeScanner.barcodeFormatLabel(for: .pdf417), f.PDF417)
    }

    func testVisionSymbologiesInverse() {
        XCTAssertTrue(DataScannerBarcodeScanner.visionSymbologies(for: [BarcodeFormat.shared.QR_CODE]).contains(.qr))
        // Unknown labels drop out; an all-unknown request yields nothing.
        XCTAssertTrue(DataScannerBarcodeScanner.visionSymbologies(for: ["not_a_format"]).isEmpty)
    }

    // MARK: Speech error codes

    func testSpeechErrorCodesMatchSharedVocabulary() {
        let c = SpeechErrorCode.shared
        XCTAssertEqual(IOSSpeechTranscriber.speechErrorCode(for: .permissionDenied), c.PERMISSION_DENIED)
        XCTAssertEqual(IOSSpeechTranscriber.speechErrorCode(for: .noMatch), c.NO_MATCH)
        XCTAssertEqual(IOSSpeechTranscriber.speechErrorCode(for: .audio), c.AUDIO_ERROR)
        XCTAssertEqual(IOSSpeechTranscriber.speechErrorCode(for: .other(99)), c.unknown(nativeCode: 99))
    }
}
