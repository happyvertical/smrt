package com.happyvertical.smrt.capacitor.session;

import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebView;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps a WebView cookie session durable (happyvertical/smrt#5077).
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

    private void flushIfChanged() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        String url = webView == null ? null : webView.getUrl();
        if (url == null) {
            return;
        }
        if (policy.shouldFlush(CookieManager.getInstance().getCookie(url))) {
            CookieManager.getInstance().flush();
        }
    }

    private void flushNow() {
        CookieManager.getInstance().flush();
        policy.reset();
    }
}
