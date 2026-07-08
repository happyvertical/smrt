package com.happyvertical.smrt.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.happyvertical.smrt.mobile.shell.MobileShellState
import com.happyvertical.smrt.mobile.shell.MobileTab

/**
 * The bottom-tab app shell, ported from amaru's `FieldOpsShellScreen`
 * chrome (ADR 0001 Phase 5) and bound to smrt-mobile's [MobileShellState].
 * Navigation is manual tabs — no androidx.navigation: the app owns the
 * state (hoisted), selects with [MobileShellState.select], and renders the
 * active tab in [content]. Conditional tabs (amaru's Talk) are the app
 * recomputing [MobileShellState.tabs] before copying the state.
 *
 * The tab bar is icon-only (labels stay in [MobileTab.label] as content
 * descriptions); icons are app policy, supplied through [tabIcon].
 */
@Composable
fun MobileShellScaffold(
    state: MobileShellState,
    onSelectTab: (String) -> Unit,
    modifier: Modifier = Modifier,
    tabIcon: @Composable (tab: MobileTab, selected: Boolean) -> Unit,
    content: @Composable (selected: MobileTab, padding: PaddingValues) -> Unit,
) {
    Scaffold(
        modifier = modifier,
        bottomBar = {
            Column {
                HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outline)
                NavigationBar(
                    containerColor = MaterialTheme.colorScheme.surface,
                ) {
                    state.tabs.forEach { tab ->
                        val selected = state.selectedTabId == tab.id
                        NavigationBarItem(
                            selected = selected,
                            onClick = { onSelectTab(tab.id) },
                            icon = { tabIcon(tab, selected) },
                            label = null,
                            alwaysShowLabel = false,
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary,
                                unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                            ),
                        )
                    }
                }
            }
        },
    ) { padding ->
        val selected = state.tabs.firstOrNull { it.id == state.selectedTabId }
            ?: state.tabs.firstOrNull()
        if (selected != null) {
            content(selected, padding)
        }
    }
}

/** Quiet per-tab heading. Orients the user without acting as a brand banner. */
@Composable
fun MobileTabHeader(
    title: String,
    subtitle: String = "",
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        if (subtitle.isNotBlank()) {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
