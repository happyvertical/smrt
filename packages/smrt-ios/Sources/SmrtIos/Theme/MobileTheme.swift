import SwiftUI

// MARK: - Design tokens
//
// The SwiftUI half of the SMRT mobile design system. Token values are the
// SAME as smrt-android's `MobileTheme.kt` (ADR 0001 Phase 5) — porting from the
// already-productionized Android tokens keeps the two platforms token-identical
// rather than drifting. amaru's inline iOS `FieldOpsStyle` had only 4 colors and
// no stop/info/neutral; this is the productionized set.
//
// Delivery mirrors Compose's CompositionLocals with SwiftUI `@Environment`:
// `MobileColors`, `MobileStatusColors`, and `MobileSpacing` are environment
// values apps can override per-subtree, provided by the `MobileTheme` container.

// MARK: Core palette

/// Core surface/text palette. Light is the default (bright-sun, one-handed field
/// posture — the seed's deliberate choice); apps opt into `dark` via `MobileTheme`.
public struct MobileColors: Sendable, Equatable {
    public let ink: Color
    public let inkMuted: Color
    public let surface: Color
    public let cardSurface: Color
    public let cardMuted: Color
    public let line: Color
    public let primary: Color
    public let onPrimary: Color

    public init(
        ink: Color, inkMuted: Color, surface: Color, cardSurface: Color,
        cardMuted: Color, line: Color, primary: Color, onPrimary: Color
    ) {
        self.ink = ink
        self.inkMuted = inkMuted
        self.surface = surface
        self.cardSurface = cardSurface
        self.cardMuted = cardMuted
        self.line = line
        self.primary = primary
        self.onPrimary = onPrimary
    }

    public static let light = MobileColors(
        ink: Color(hex: 0x14181D),
        inkMuted: Color(hex: 0x566069),
        surface: Color(hex: 0xF5F6F8),
        cardSurface: Color(hex: 0xFFFFFF),
        cardMuted: Color(hex: 0xEDEFF2),
        line: Color(hex: 0xCFD5DC),
        primary: Color(hex: 0x1F4E79),
        onPrimary: Color(hex: 0xFFFFFF)
    )

    public static let dark = MobileColors(
        ink: Color(hex: 0xE7EAEE),
        inkMuted: Color(hex: 0xA6AEB6),
        surface: Color(hex: 0x14181D),
        cardSurface: Color(hex: 0x1C2127),
        cardMuted: Color(hex: 0x242A31),
        line: Color(hex: 0x3A424B),
        primary: Color(hex: 0x9CC2EC),
        onPrimary: Color(hex: 0x0F2A47)
    )
}

/// Literal status colors — Stop/Caution/Go/Info/Neutral — not decorative accents.
public struct MobileStatusColors: Sendable, Equatable {
    public let stop: Color
    public let caution: Color
    public let go: Color
    public let info: Color
    public let neutral: Color

    public init(stop: Color, caution: Color, go: Color, info: Color, neutral: Color) {
        self.stop = stop
        self.caution = caution
        self.go = go
        self.info = info
        self.neutral = neutral
    }

    public static let light = MobileStatusColors(
        stop: Color(hex: 0xB3261E),
        caution: Color(hex: 0xA85A00),
        go: Color(hex: 0x1E7D34),
        info: Color(hex: 0x1F4E79),
        neutral: Color(hex: 0x566069)
    )

    public static let dark = MobileStatusColors(
        stop: Color(hex: 0xE07A73),
        caution: Color(hex: 0xE0A050),
        go: Color(hex: 0x66BB6A),
        info: Color(hex: 0x9CC2EC),
        neutral: Color(hex: 0xA6AEB6)
    )
}

/// Glove-use spacing scale (points), matching Android's `MobileSpacing` (dp).
public struct MobileSpacing: Sendable, Equatable {
    public let screenPadding: CGFloat
    public let sectionGap: CGFloat
    public let itemGap: CGFloat
    public let tightGap: CGFloat
    public let minTouchTarget: CGFloat

    public init(
        screenPadding: CGFloat = 20,
        sectionGap: CGFloat = 18,
        itemGap: CGFloat = 12,
        tightGap: CGFloat = 6,
        minTouchTarget: CGFloat = 56
    ) {
        self.screenPadding = screenPadding
        self.sectionGap = sectionGap
        self.itemGap = itemGap
        self.tightGap = tightGap
        self.minTouchTarget = minTouchTarget
    }

    public static let `default` = MobileSpacing()
}

/// Type scale (size / weight), matching Android's `MobileTypography`.
public enum MobileTypography {
    public static let headlineSmall = Font.system(size: 22, weight: .semibold)
    public static let titleLarge = Font.system(size: 19, weight: .semibold)
    public static let titleMedium = Font.system(size: 17, weight: .semibold)
    public static let bodyLarge = Font.system(size: 16, weight: .regular)
    public static let bodyMedium = Font.system(size: 15, weight: .regular)
    public static let bodySmall = Font.system(size: 13, weight: .regular)
    public static let labelLarge = Font.system(size: 15, weight: .semibold)
    public static let labelMedium = Font.system(size: 12, weight: .semibold)
}

/// Corner radii, matching Android's `MobileShapes`.
public enum MobileShapes {
    public static let extraSmall: CGFloat = 6
    public static let small: CGFloat = 8
    public static let medium: CGFloat = 10
    public static let large: CGFloat = 12
}

// MARK: - Environment plumbing (the SwiftUI analog of Compose CompositionLocals)

private struct MobileColorsKey: EnvironmentKey {
    static let defaultValue = MobileColors.light
}
private struct MobileStatusColorsKey: EnvironmentKey {
    static let defaultValue = MobileStatusColors.light
}
private struct MobileSpacingKey: EnvironmentKey {
    static let defaultValue = MobileSpacing.default
}

public extension EnvironmentValues {
    var mobileColors: MobileColors {
        get { self[MobileColorsKey.self] }
        set { self[MobileColorsKey.self] = newValue }
    }
    var mobileStatusColors: MobileStatusColors {
        get { self[MobileStatusColorsKey.self] }
        set { self[MobileStatusColorsKey.self] = newValue }
    }
    var mobileSpacing: MobileSpacing {
        get { self[MobileSpacingKey.self] }
        set { self[MobileSpacingKey.self] = newValue }
    }
}

// MARK: - Theme container

/// Provides the design tokens to a subtree. `darkTheme` defaults to `false`
/// deliberately (bright-sun field posture); apps opt in — e.g.
/// `MobileTheme(darkTheme: colorScheme == .dark) { … }`.
public struct MobileTheme<Content: View>: View {
    private let colors: MobileColors
    private let statusColors: MobileStatusColors
    private let spacing: MobileSpacing
    private let content: Content

    public init(
        darkTheme: Bool = false,
        colors: MobileColors? = nil,
        statusColors: MobileStatusColors? = nil,
        spacing: MobileSpacing = .default,
        @ViewBuilder content: () -> Content
    ) {
        self.colors = colors ?? (darkTheme ? .dark : .light)
        self.statusColors = statusColors ?? (darkTheme ? .dark : .light)
        self.spacing = spacing
        self.content = content()
    }

    public var body: some View {
        content
            .environment(\.mobileColors, colors)
            .environment(\.mobileStatusColors, statusColors)
            .environment(\.mobileSpacing, spacing)
            .tint(colors.primary)
            .background(colors.surface.ignoresSafeArea())
    }
}

// MARK: - Widgets

/// Quiet uppercase group label, optional trailing note. Matches `MobileSectionLabel`.
public struct MobileSectionLabel: View {
    private let text: String
    private let trailing: String?
    @Environment(\.mobileColors) private var colors

    public init(_ text: String, trailing: String? = nil) {
        self.text = text
        self.trailing = trailing
    }

    public var body: some View {
        Text(labelText)
            .font(MobileTypography.labelMedium)
            .foregroundStyle(colors.inkMuted)
    }

    private var labelText: String {
        if let trailing, !trailing.isEmpty {
            return "\(text.uppercased())  •  \(trailing)"
        }
        return text.uppercased()
    }
}

/// Flat, bordered panel — borders read better in sun than shadows; never nested.
/// Matches `MobileResultCard`.
public struct MobileResultCard<Content: View>: View {
    private let content: Content
    @Environment(\.mobileColors) private var colors

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(colors.cardSurface)
            .clipShape(RoundedRectangle(cornerRadius: MobileShapes.medium))
            .overlay(
                RoundedRectangle(cornerRadius: MobileShapes.medium)
                    .stroke(colors.line, lineWidth: 1)
            )
    }
}

/// A 12%-alpha tinted fill with the full-strength color as the label. Matches
/// `MobileStatusPill`. Pass a role from the environment's `MobileStatusColors`.
public struct MobileStatusPill: View {
    private let text: String
    private let color: Color

    public init(_ text: String, color: Color) {
        self.text = text
        self.color = color
    }

    public var body: some View {
        Text(text)
            .font(MobileTypography.labelMedium)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: MobileShapes.extraSmall))
    }
}

// MARK: - Color hex helper

extension Color {
    /// 0xRRGGBB → Color in sRGB, matching Android's `Color(0xFF……)` tokens.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1.0
        )
    }
}
