import SwiftUI
import SmrtMobile

/// The tab app shell, bound to smrt-mobile's shared `MobileShellState` (the same
/// binding smrt-android uses) rather than an unbound native `TabView` — the
/// productionize upgrade over amaru's seed. Manual tabs, no navigation framework:
/// the app owns the state (hoisted), selects with `onSelectTab`, and renders the
/// active tab in `content`. Conditional tabs (e.g. amaru's Talk) are the app
/// recomputing `state.tabs`, exactly how `MobileShellState` is designed.
///
/// The bar is icon-only (labels live in `MobileTab.label` as accessibility text);
/// icons are app policy, supplied through `tabIcon`.
public struct MobileShellScaffold<TabIcon: View, Content: View>: View {
    private let state: MobileShellState
    private let onSelectTab: (String) -> Void
    private let tabIcon: (MobileTab, Bool) -> TabIcon
    private let content: (MobileTab) -> Content

    @Environment(\.mobileColors) private var colors

    public init(
        state: MobileShellState,
        onSelectTab: @escaping (String) -> Void,
        @ViewBuilder tabIcon: @escaping (MobileTab, Bool) -> TabIcon,
        @ViewBuilder content: @escaping (MobileTab) -> Content
    ) {
        self.state = state
        self.onSelectTab = onSelectTab
        self.tabIcon = tabIcon
        self.content = content
    }

    private var selectedTab: MobileTab? {
        state.tabs.first { $0.id == state.selectedTabId } ?? state.tabs.first
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let selected = selectedTab {
                content(selected)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spacer()
            }

            Divider().overlay(colors.line)

            HStack(alignment: .center, spacing: 0) {
                ForEach(state.tabs, id: \.id) { tab in
                    let isSelected = tab.id == state.selectedTabId
                    Button {
                        onSelectTab(tab.id)
                    } label: {
                        tabIcon(tab, isSelected)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(isSelected ? colors.primary : colors.inkMuted)
                    .accessibilityLabel(tab.label)
                    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
                }
            }
            .padding(.vertical, 4)
            .background(colors.cardSurface)
        }
        .background(colors.surface)
    }
}

/// Quiet per-tab heading — orients the user without acting as a brand banner.
/// Matches Android's `MobileTabHeader`.
public struct MobileTabHeader: View {
    private let title: String
    private let subtitle: String

    @Environment(\.mobileColors) private var colors

    public init(title: String, subtitle: String = "") {
        self.title = title
        self.subtitle = subtitle
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(MobileTypography.titleLarge)
                .foregroundStyle(colors.ink)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(MobileTypography.bodySmall)
                    .foregroundStyle(colors.inkMuted)
            }
        }
    }
}
