import SwiftUI
import SmrtIos
import SmrtMobile

/// Demo app proving the SwiftUI foundation drives **real shared logic** — no
/// `.sample` stubs. The pack tab persists through smrt-mobile's durable
/// `DurableOfflinePackStore` (replacing amaru's stubbed `PackDownloaderBridge`),
/// the queue through `DurableWriteQueue`, and the Device tab reads the real
/// capability/LLM/hash adapters.
@main
struct SmrtIosSampleApp: App {
    @StateObject private var model = SampleModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task { await model.refresh() }
        }
    }
}

@MainActor
final class SampleModel: ObservableObject {
    let database: SmrtMobileDatabase
    let packStore: DurableOfflinePackStore
    let writeQueue: DurableWriteQueue

    let barcodeScanner = DataScannerBarcodeScanner()
    let deviceAdapter = IOSDeviceCapabilityAdapter()
    let languageModel = FoundationModelsLanguageModel()
    private let hasher = CryptoKitSha256Hasher.shared

    @Published var shell: MobileShellState
    @Published var packs: [OfflinePackRecord] = []
    @Published var pendingCount: Int = 0
    @Published var lastBarcode: String = "—"
    @Published var capabilities: MobileDeviceCapabilities?
    @Published var llm: LanguageModelAvailability?
    @Published var status: String = ""

    init() {
        database = SmrtMobileIos.shared.createDatabase(name: "smrt_ios_sample.db")
        packStore = SmrtMobileIos.shared.createOfflinePackStore(database: database)
        writeQueue = SmrtMobileIos.shared.createWriteQueue(database: database)
        shell = MobileShellState(
            brandName: "SMRT iOS",
            tabs: [
                MobileTab(id: "packs", label: "Packs"),
                MobileTab(id: "scan", label: "Scan"),
                MobileTab(id: "device", label: "Device"),
            ],
            selectedTabId: "packs",
            activeContextId: ""
        )
    }

    func select(_ tabId: String) {
        shell = shell.select(tabId: tabId)
    }

    func refresh() async {
        do {
            try await writeQueue.recoverInterrupted()
            packs = try await packStore.list()
            pendingCount = try await writeQueue.pending().count
            capabilities = deviceAdapter.currentCapabilities()
            llm = try await languageModel.checkAvailability()
        } catch {
            status = "refresh failed: \(error.localizedDescription)"
        }
    }

    /// Real shared logic: persist a pack record and read it back.
    func downloadDemoPack() async {
        let payload = "{\"project\":\"West Annex Roof Recover\",\"version\":1}"
        let record = OfflinePackRecord(
            packId: "demo-pack",
            version: 1,
            manifestHash: hasher.sha256Hex(bytes: payload.toKotlinByteArray()),
            payload: payload,
            storedAtEpochMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        do {
            try await packStore.save(record: record)
            packs = try await packStore.list()
            status = "saved \(packs.count) pack(s)"
        } catch {
            status = "save failed: \(error.localizedDescription)"
        }
    }

    /// Real shared logic: enqueue a durable write and re-read the pending count.
    func enqueueWrite() async {
        let entry = NewQueueEntry(
            id: UUID().uuidString,
            kind: "demo.write",
            payload: "{\"note\":\"hello\"}",
            tenantId: ""
        )
        do {
            _ = try await writeQueue.enqueue(entry: entry)
            pendingCount = try await writeQueue.pending().count
            status = "queued; \(pendingCount) pending"
        } catch {
            status = "enqueue failed: \(error.localizedDescription)"
        }
    }

    func startScanning() {
        let listener = ClosureBarcodeListener(
            onScan: { [weak self] value in
                Task { @MainActor in self?.lastBarcode = value }
            },
            onError: { [weak self] code in
                Task { @MainActor in self?.status = "scan error: \(code)" }
            }
        )
        barcodeScanner.startScanning(request: BarcodeScanRequest(formats: []), listener: listener)
    }

    func stopScanning() {
        barcodeScanner.stopScanning()
    }
}

/// Bridges the seam's `BarcodeScanListener` to Swift closures.
final class ClosureBarcodeListener: NSObject, BarcodeScanListener {
    private let onScan: (String) -> Void
    private let onErrorCode: (String) -> Void

    init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
        self.onScan = onScan
        self.onErrorCode = onError
    }

    func onBarcode(scan: BarcodeScan) { onScan(scan.rawValue) }
    func onError(code: String) { onErrorCode(code) }
}

extension String {
    /// Copies UTF-8 bytes into a Kotlin `ByteArray` for the hasher seam.
    func toKotlinByteArray() -> KotlinByteArray {
        let bytes = Array(utf8)
        let array = KotlinByteArray(size: Int32(bytes.count))
        for (index, byte) in bytes.enumerated() {
            array.set(index: Int32(index), value: Int8(bitPattern: byte))
        }
        return array
    }
}
