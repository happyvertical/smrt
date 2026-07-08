package com.happyvertical.smrt.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * SMRT mobile visual system, ported from amaru's `FieldOpsTheme` (ADR 0001
 * Phase 5) with the seed's intent intact: high-contrast, restrained,
 * durable — built for one-handed use in bright sun. Light surfaces,
 * near-black text, strong borders instead of soft shadows, and a small set
 * of literal status colors. Not a single-hue theme — the slate-blue primary
 * stays out of the way so the status colors carry meaning on their own.
 *
 * Productionized beyond the seed (which was light-only with global token
 * objects): a dark scheme exists but light stays the default (the field-use
 * posture), and status/spacing tokens are provided via CompositionLocals so
 * apps can override them per subtree (`MobileTheme.statusColors`,
 * `MobileTheme.spacing`).
 */

// Core palette (light).
private val Ink = Color(0xFF14181D) // primary text, near-black for contrast
private val InkMuted = Color(0xFF566069) // secondary text
private val Surface = Color(0xFFF5F6F8) // app background
private val CardSurface = Color(0xFFFFFFFF) // result / panel surface
private val CardMuted = Color(0xFFEDEFF2) // quiet fills, segmented controls
private val Line = Color(0xFFCFD5DC) // borders, dividers
private val Primary = Color(0xFF1F4E79) // serious slate-blue, used sparingly
private val OnPrimary = Color(0xFFFFFFFF)

// Core palette (dark) — same hue system, inverted value scale.
private val DarkInk = Color(0xFFE7EAEE)
private val DarkInkMuted = Color(0xFFA6AEB6)
private val DarkSurface = Color(0xFF14181D)
private val DarkCardSurface = Color(0xFF1C2127)
private val DarkCardMuted = Color(0xFF242A31)
private val DarkLine = Color(0xFF3A424B)
private val DarkPrimary = Color(0xFF9CC2EC)
private val DarkOnPrimary = Color(0xFF0F2A47)

/**
 * Literal status colors (alerts, translation state, permission state).
 * The five roles are the seed's `FieldOpsStatus` scale.
 */
@Immutable
data class MobileStatusColors(
    val stop: Color,
    val caution: Color,
    val go: Color,
    val info: Color,
    val neutral: Color,
)

val LightMobileStatusColors = MobileStatusColors(
    stop = Color(0xFFB3261E),
    caution = Color(0xFFA85A00),
    go = Color(0xFF1E7D34),
    info = Color(0xFF1F4E79),
    neutral = Color(0xFF566069),
)

val DarkMobileStatusColors = MobileStatusColors(
    stop = Color(0xFFE07A73),
    caution = Color(0xFFE0A050),
    go = Color(0xFF66BB6A),
    info = Color(0xFF9CC2EC),
    neutral = Color(0xFFA6AEB6),
)

/** Spacing scale. Generous touch targets and gaps for glove use. */
@Immutable
data class MobileSpacing(
    val screenPadding: androidx.compose.ui.unit.Dp = 20.dp,
    val sectionGap: androidx.compose.ui.unit.Dp = 18.dp,
    val itemGap: androidx.compose.ui.unit.Dp = 12.dp,
    val tightGap: androidx.compose.ui.unit.Dp = 6.dp,
    val minTouchTarget: androidx.compose.ui.unit.Dp = 56.dp,
)

val LocalMobileStatusColors = staticCompositionLocalOf { LightMobileStatusColors }
val LocalMobileSpacing = staticCompositionLocalOf { MobileSpacing() }

/** Token accessors, [MaterialTheme]-style: `MobileTheme.statusColors.stop`. */
object MobileTheme {
    val statusColors: MobileStatusColors
        @Composable get() = LocalMobileStatusColors.current

    val spacing: MobileSpacing
        @Composable get() = LocalMobileSpacing.current
}

private val MobileLightColorScheme = lightColorScheme(
    primary = Primary,
    onPrimary = OnPrimary,
    primaryContainer = Color(0xFFDCE6F1),
    onPrimaryContainer = Primary,
    secondary = Primary,
    onSecondary = OnPrimary,
    background = Surface,
    onBackground = Ink,
    surface = CardSurface,
    onSurface = Ink,
    surfaceVariant = CardMuted,
    onSurfaceVariant = InkMuted,
    outline = Line,
    outlineVariant = Line,
    error = LightMobileStatusColors.stop,
    onError = Color(0xFFFFFFFF),
)

private val MobileDarkColorScheme = darkColorScheme(
    primary = DarkPrimary,
    onPrimary = DarkOnPrimary,
    primaryContainer = Primary,
    onPrimaryContainer = Color(0xFFDCE6F1),
    secondary = DarkPrimary,
    onSecondary = DarkOnPrimary,
    background = DarkSurface,
    onBackground = DarkInk,
    surface = DarkCardSurface,
    onSurface = DarkInk,
    surfaceVariant = DarkCardMuted,
    onSurfaceVariant = DarkInkMuted,
    outline = DarkLine,
    outlineVariant = DarkLine,
    error = DarkMobileStatusColors.stop,
    onError = Color(0xFF3A0A07),
)

private val MobileTypography = Typography(
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
)

private val MobileShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(10.dp),
    large = RoundedCornerShape(12.dp),
)

/**
 * The SMRT mobile theme. [darkTheme] defaults to false deliberately — the
 * seed system is tuned for bright-sun outdoor legibility; apps that want to
 * follow the system pass `isSystemInDarkTheme()`.
 */
@Composable
fun MobileTheme(
    darkTheme: Boolean = false,
    statusColors: MobileStatusColors = if (darkTheme) DarkMobileStatusColors else LightMobileStatusColors,
    spacing: MobileSpacing = MobileSpacing(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(
        LocalMobileStatusColors provides statusColors,
        LocalMobileSpacing provides spacing,
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) MobileDarkColorScheme else MobileLightColorScheme,
            typography = MobileTypography,
            shapes = MobileShapes,
            content = content,
        )
    }
}

/**
 * Small section heading used to group scannable results. Quiet by design —
 * it labels a list, it is not an app title.
 */
@Composable
fun MobileSectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    trailing: String? = null,
) {
    val label = if (trailing.isNullOrBlank()) text.uppercase() else "${text.uppercase()}  •  $trailing"
    Box(modifier = modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Flat, bordered result container. Repeated result items are okay as cards;
 * shadows are not — borders read better in sun and keep the surface quiet.
 * Never nest one of these inside another.
 */
@Composable
fun MobileResultCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Card(
        modifier = modifier,
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        content = { content() },
    )
}

/** Compact status chip with a tinted fill and colored label. */
@Composable
fun MobileStatusPill(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = color,
        )
    }
}
