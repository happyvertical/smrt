import SwiftUI
import SmrtIos
import SmrtMobile
import VisionKit

struct RootView: View {
    @ObservedObject var model: SampleModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        MobileTheme(darkTheme: colorScheme == .dark) {
            MobileShellScaffold(
                state: model.shell,
                onSelectTab: { model.select($0) },
                tabIcon: { tab, selected in
                    Image(systemName: symbol(for: tab.id))
                        .font(.system(size: 20, weight: selected ? .semibold : .regular))
                },
                content: { tab in
                    screen(for: tab.id)
                }
            )
        }
    }

    private func symbol(for id: String) -> String {
        switch id {
        case "packs": return "shippingbox"
        case "scan": return "barcode.viewfinder"
        case "device": return "iphone.gen3"
        default: return "circle"
        }
    }

    @ViewBuilder
    private func screen(for id: String) -> some View {
        switch id {
        case "packs": PacksScreen(model: model)
        case "scan": ScanScreen(model: model)
        case "device": DeviceScreen(model: model)
        default: EmptyView()
        }
    }
}

private struct ScreenScaffold<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content
    @Environment(\.mobileSpacing) private var spacing

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing.sectionGap) {
                MobileTabHeader(title: title, subtitle: subtitle)
                content
            }
            .padding(spacing.screenPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct PacksScreen: View {
    @ObservedObject var model: SampleModel
    @Environment(\.mobileSpacing) private var spacing

    var body: some View {
        ScreenScaffold(title: "Offline Packs", subtitle: "Durable SQLDelight store — real shared logic") {
            VStack(spacing: spacing.itemGap) {
                Button("Download demo pack") { Task { await model.downloadDemoPack() } }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
                Button("Enqueue durable write") { Task { await model.enqueueWrite() } }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
            }

            MobileSectionLabel("Stored packs", trailing: "\(model.packs.count)")
            if model.packs.isEmpty {
                MobileResultCard {
                    Text("No packs stored yet.")
                        .font(MobileTypography.bodyMedium)
                        .padding(14)
                }
            } else {
                ForEach(model.packs, id: \.packId) { pack in
                    MobileResultCard {
                        VStack(alignment: .leading, spacing: spacing.tightGap) {
                            Text(pack.packId).font(MobileTypography.titleMedium)
                            Text("v\(pack.version) · \(pack.manifestHash.prefix(16))…")
                                .font(MobileTypography.bodySmall)
                        }
                        .padding(14)
                    }
                }
            }

            MobileSectionLabel("Write queue", trailing: "\(model.pendingCount) pending")
            if !model.status.isEmpty {
                Text(model.status).font(MobileTypography.bodySmall)
            }
        }
    }
}

struct ScanScreen: View {
    @ObservedObject var model: SampleModel
    @Environment(\.mobileSpacing) private var spacing
    @Environment(\.mobileStatusColors) private var status

    var body: some View {
        ScreenScaffold(title: "Barcode Scan", subtitle: "VisionKit DataScanner (net-new on iOS)") {
            if model.barcodeScanner.isAvailable() {
                BarcodeScannerPreview(scanner: model.barcodeScanner)
                    .frame(height: 260)
                    .clipShape(RoundedRectangle(cornerRadius: MobileShapes.medium))
                    .onAppear { model.startScanning() }
                    .onDisappear { model.stopScanning() }
            } else {
                MobileResultCard {
                    Text("Scanner unavailable (no camera — e.g. simulator).")
                        .font(MobileTypography.bodyMedium)
                        .padding(14)
                }
            }
            MobileSectionLabel("Last scan")
            MobileStatusPill(model.lastBarcode, color: status.info)
        }
    }
}

struct DeviceScreen: View {
    @ObservedObject var model: SampleModel
    @Environment(\.mobileSpacing) private var spacing
    @Environment(\.mobileStatusColors) private var status

    var body: some View {
        ScreenScaffold(title: "Device", subtitle: "Capabilities, on-device LLM, hashing") {
            MobileSectionLabel("Capture permissions")
            if let caps = model.capabilities {
                capabilityRow(caps.camera)
                capabilityRow(caps.microphone)
            }

            MobileSectionLabel("On-device language model")
            MobileResultCard {
                VStack(alignment: .leading, spacing: spacing.tightGap) {
                    let ready = model.llm?.onDeviceReady ?? false
                    MobileStatusPill(model.llm?.status ?? "unknown", color: ready ? status.go : status.neutral)
                    Text("provider: \(model.llm?.provider.isEmpty == false ? model.llm!.provider : "—")")
                        .font(MobileTypography.bodySmall)
                }
                .padding(14)
            }

            MobileSectionLabel("SHA-256 (CryptoKit)")
            MobileResultCard {
                Text(CryptoKitSha256Hasher.shared.sha256Hex(bytes: "abc".toKotlinByteArray()))
                    .font(MobileTypography.bodySmall.monospaced())
                    .padding(14)
            }
        }
    }

    @ViewBuilder
    private func capabilityRow(_ capability: MobileDeviceCapability) -> some View {
        MobileResultCard {
            HStack {
                Text(capability.label).font(MobileTypography.bodyLarge)
                Spacer()
                MobileStatusPill(capability.permission.status, color: color(for: capability.permission.status))
            }
            .padding(14)
        }
    }

    private func color(for permissionStatus: String) -> Color {
        switch permissionStatus {
        case DevicePermissionStatus.shared.GRANTED: return status.go
        case DevicePermissionStatus.shared.DENIED: return status.stop
        case DevicePermissionStatus.shared.NOT_DETERMINED: return status.caution
        default: return status.neutral
        }
    }
}
