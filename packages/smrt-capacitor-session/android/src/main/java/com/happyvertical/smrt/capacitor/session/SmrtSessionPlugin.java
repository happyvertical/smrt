package com.happyvertical.smrt.capacitor.session;

import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebView;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps a WebView cookie session durable (happyvertical/smrt#5077).
 *
 * Origins whose cookies are watched, deduplicated: the origin of the current
 * page, the origin of Capacitor's {@code server.url}, and any extra origins
 * listed in this plugin's config ({@code plugins.SmrtSession.origins}). A shell
 * that serves the app from https://localhost but signs in against a remote
 * origin must list that origin or set server.url. Cookies of any other origin
 * are flushed only on pause, stop and destroy.
 *
 * Android's WebView holds new cookies in memory and writes them to disk on its
 * own schedule (about every 30 seconds), so a process killed soon after sign-in
 * loses the session. A sign-in that sets its cookie from a fetch, as a
 * SvelteKit form action does, triggers no page load and no lifecycle callback,
 * and `am force-stop` of a foreground app runs none either. This plugin
 * therefore watches the cookie jar of the current page while the app is
 * resumed, flushes within POLL_MS of any change, and also flushes on pause,
 * stop and destroy. It registers itself when the app runs `cap sync`; the web
 * app needs no call. `flush()` is exposed for a page that wants a deterministic
 * flush right after it sets a cookie.
 */
@CapacitorPlugin(name = "SmrtSession")
public class SmrtSessionPlugin extends Plugin {

    static final long POLL_MS = 500;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final CookieFlushPolicy policy = new CookieFlushPolicy();
    private boolean polling = false;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!polling) {
                return;
            }
            flushIfChanged();
            handler.postDelayed(this, POLL_MS);
        }
    };

    @Override
    public void load() {
        Logger.info(getLogTag(), "session cookie flush active");
        startPolling();
    }

    @Override
    protected void handleOnResume() {
        startPolling();
    }

    @Override
    protected void handleOnPause() {
        stopPolling();
        flushNow();
    }

    @Override
    protected void handleOnStop() {
        flushNow();
    }

    @Override
    protected void handleOnDestroy() {
        stopPolling();
        flushNow();
    }

    @PluginMethod
    public void flush(PluginCall call) {
        flushNow();
        call.resolve();
    }

    private void startPolling() {
        if (polling) {
            return;
        }
        polling = true;
        handler.post(poll);
    }

    private void stopPolling() {
        polling = false;
        handler.removeCallbacks(poll);
    }

    private Set<String> watchedOrigins() {
        List<String> urls = new ArrayList<>();
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView != null) {
            urls.add(webView.getUrl());
        }
        if (getBridge() != null && getBridge().getConfig() != null) {
            urls.add(getBridge().getConfig().getServerUrl());
        }
        String[] extra = getConfig().getArray("origins");
        if (extra != null) {
            for (String o : extra) {
                urls.add(o);
            }
        }
        return CookieFlushPolicy.origins(urls);
    }

    private void flushIfChanged() {
        CookieManager cookies = CookieManager.getInstance();
        String snapshot = CookieFlushPolicy.snapshot(watchedOrigins(), cookies::getCookie);
        if (policy.shouldFlush(snapshot)) {
            cookies.flush();
        }
    }

    private void flushNow() {
        CookieManager.getInstance().flush();
        policy.reset();
    }
}
