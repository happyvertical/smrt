package com.happyvertical.smrt.mobile.shell

import kotlin.test.Test
import kotlin.test.assertEquals

class MobileShellStateTest {
    private val tabs = listOf(
        MobileTab("reference", "Reference"),
        MobileTab("capture", "Capture"),
        MobileTab("settings", "Settings"),
    )

    @Test
    fun defaultsSelectionToFirstTab() {
        val state = MobileShellState(brandName = "Demo", tabs = tabs)

        assertEquals("reference", state.selectedTabId)
    }

    @Test
    fun selectsVisibleTab() {
        val state = MobileShellState(tabs = tabs).select("capture")

        assertEquals("capture", state.selectedTabId)
    }

    @Test
    fun unknownTabFallsBackToFirstTab() {
        val state = MobileShellState(tabs = tabs, selectedTabId = "capture").select("missing")

        assertEquals("reference", state.selectedTabId)
    }

    @Test
    fun emptyTabsSelectToBlank() {
        val state = MobileShellState().select("anything")

        assertEquals("", state.selectedTabId)
    }
}
