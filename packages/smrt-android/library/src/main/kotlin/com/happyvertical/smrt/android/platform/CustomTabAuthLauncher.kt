package com.happyvertical.smrt.android.platform

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import com.happyvertical.smrt.mobile.auth.ExternalAuthLauncher

/**
 * Custom Tabs implementation of smrt-mobile's [ExternalAuthLauncher] seam:
 * opens the PKCE authorization URL in the user's browser; the deep-link
 * redirect back into the app completes the handshake via
 * `MobileSessionManager`. Prefer an [Activity] context; with a plain
 * context the launch intent gains `FLAG_ACTIVITY_NEW_TASK`.
 */
class CustomTabAuthLauncher(private val context: Context) : ExternalAuthLauncher {
    override fun launch(authorizationUrl: String) {
        val customTab = CustomTabsIntent.Builder().build()
        if (context !is Activity) {
            customTab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        customTab.launchUrl(context, Uri.parse(authorizationUrl))
    }
}
