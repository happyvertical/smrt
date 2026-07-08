import AVFoundation
import Foundation
import SmrtMobile
import SwiftUI
import Vision
import VisionKit

/// **Net-new** iOS implementation of the shared `BarcodeScanner` seam (amaru's iOS
/// had no scanner). Uses VisionKit's `DataScannerViewController`; the SwiftUI
/// `BarcodeScannerPreview` hosts the live camera and forwards decoded barcodes to
/// the seam's `BarcodeScanListener`.
///
/// Format labels are the shared `BarcodeFormat` vocabulary (owned by smrt-mobile),
/// mapped from `VNBarcodeSymbology` by the pure, unit-tested `barcodeFormatLabel`.
/// Requires `NSCameraUsageDescription`; camera-binding lives in the preview.
public final class DataScannerBarcodeScanner: NSObject, BarcodeScanner {
    private var listener: BarcodeScanListener?
    private(set) var requestedFormats: [String] = []
    private(set) var isScanning = false

    public override init() { super.init() }

    public func isAvailable() -> Bool {
        // Camera presence is the reliable nonisolated signal; `DataScannerViewController`'s
        // support/availability flags are `@MainActor` and are checked when the preview
        // presents (no camera — e.g. the simulator — means no scanner).
        AVCaptureDevice.default(for: .video) != nil
    }

    public func startScanning(request: BarcodeScanRequest, listener: BarcodeScanListener) {
        stopScanning()
        self.listener = listener
        self.requestedFormats = request.formats
        self.isScanning = true
    }

    public func stopScanning() {
        isScanning = false
        listener = nil
    }

    // MARK: Preview wiring (called by BarcodeScannerPreview)

    /// Symbologies for this scan session. Empty request → all supported; a
    /// non-empty request that maps to nothing is a caller bug (reports an error
    /// rather than silently widening to scan-everything, matching the Android seam).
    func resolvedSymbologies() -> [VNBarcodeSymbology] {
        if requestedFormats.isEmpty { return Self.defaultSymbologies }
        let symbologies = Self.visionSymbologies(for: requestedFormats)
        if symbologies.isEmpty {
            listener?.onError(code: "unsupported_formats")
        }
        return symbologies
    }

    func handleRecognized(_ items: [RecognizedItem]) {
        guard isScanning else { return }
        for item in items {
            guard case let .barcode(barcode) = item,
                  let raw = barcode.payloadStringValue, !raw.isEmpty else { continue }
            let label = Self.barcodeFormatLabel(for: barcode.observation.symbology)
            listener?.onBarcode(scan: BarcodeScan(rawValue: raw, format: label, scannedAt: nil))
        }
    }

    func reportError(_ code: String) {
        listener?.onError(code: code)
    }

    // MARK: - Pure, testable format mapping (shared BarcodeFormat vocabulary)

    static func barcodeFormatLabel(for symbology: VNBarcodeSymbology) -> String {
        let f = BarcodeFormat.shared
        switch symbology {
        case .qr: return f.QR_CODE
        case .aztec: return f.AZTEC
        case .code39, .code39Checksum, .code39FullASCII, .code39FullASCIIChecksum: return f.CODE_39
        case .code93, .code93i: return f.CODE_93
        case .code128: return f.CODE_128
        case .dataMatrix: return f.DATA_MATRIX
        case .ean8: return f.EAN_8
        case .ean13: return f.EAN_13
        case .i2of5, .i2of5Checksum, .itf14: return f.ITF
        case .pdf417: return f.PDF417
        case .upce: return f.UPC_E
        case .codabar: return f.CODABAR
        default: return f.UNKNOWN
        }
    }

    static let defaultSymbologies: [VNBarcodeSymbology] = [
        .qr, .aztec, .code39, .code93, .code128, .dataMatrix,
        .ean8, .ean13, .i2of5, .itf14, .pdf417, .upce, .codabar,
    ]

    /// Inverse of `barcodeFormatLabel`: shared labels → symbologies, dropping
    /// labels VisionKit cannot express (e.g. `upc_a`, reported as `ean_13`).
    static func visionSymbologies(for formats: [String]) -> [VNBarcodeSymbology] {
        let f = BarcodeFormat.shared
        var result: [VNBarcodeSymbology] = []
        for format in formats {
            switch format {
            case f.QR_CODE: result.append(.qr)
            case f.AZTEC: result.append(.aztec)
            case f.CODE_39: result.append(.code39)
            case f.CODE_93: result.append(.code93)
            case f.CODE_128: result.append(.code128)
            case f.DATA_MATRIX: result.append(.dataMatrix)
            case f.EAN_8: result.append(.ean8)
            case f.EAN_13: result.append(.ean13)
            case f.ITF: result.append(contentsOf: [.i2of5, .itf14])
            case f.PDF417: result.append(.pdf417)
            case f.UPC_E: result.append(.upce)
            case f.CODABAR: result.append(.codabar)
            default: break
            }
        }
        return result
    }
}

/// SwiftUI host for the live barcode camera — the iOS analog of Android's
/// `BarcodeScannerPreview`. Drive it with a `DataScannerBarcodeScanner` whose
/// `startScanning(request:listener:)` was already called.
public struct BarcodeScannerPreview: UIViewControllerRepresentable {
    private let scanner: DataScannerBarcodeScanner

    public init(scanner: DataScannerBarcodeScanner) {
        self.scanner = scanner
    }

    public func makeCoordinator() -> Coordinator { Coordinator(scanner: scanner) }

    public func makeUIViewController(context: Context) -> DataScannerViewController {
        let symbologies = scanner.resolvedSymbologies()
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: symbologies)],
            qualityLevel: .balanced,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        return controller
    }

    public func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        if scanner.isScanning {
            try? controller.startScanning()
        } else {
            controller.stopScanning()
        }
    }

    public static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    public final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let scanner: DataScannerBarcodeScanner

        init(scanner: DataScannerBarcodeScanner) {
            self.scanner = scanner
        }

        public func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            scanner.handleRecognized(addedItems)
        }

        public func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            scanner.reportError("scanner_unavailable")
        }
    }
}
