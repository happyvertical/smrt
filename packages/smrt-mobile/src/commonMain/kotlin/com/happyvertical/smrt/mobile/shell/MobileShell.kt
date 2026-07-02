package com.happyvertical.smrt.mobile.shell

import kotlinx.serialization.Serializable

/**
 * App-shell navigation state, seeded from amaru's `FieldOpsShellState`
 * (ADR 0001). Navigation is manual bottom tabs — no androidx.navigation.
 * Apps provide their own tab list (amaru's conditional Talk tab becomes the
 * app computing `tabs` before constructing the state).
 */
@Serializable
data class MobileTab(
    val id: String,
    val label: String,
)

@Serializable
data class MobileShellState(
    val brandName: String = "",
    val tabs: List<MobileTab> = emptyList(),
    val selectedTabId: String = tabs.firstOrNull()?.id ?: "",
    val activeContextId: String = "",
) {
    /** Selects [tabId] when visible; falls back to the first tab otherwise. */
    fun select(tabId: String): MobileShellState {
        val nextTabId = if (tabs.any { it.id == tabId }) tabId else tabs.firstOrNull()?.id ?: ""
        return copy(selectedTabId = nextTabId)
    }
}
