package com.happyvertical.smrt.capacitor.session;

/**
 * Decides when the WebView cookie jar needs flushing. Pure Java so it is tested
 * without Android: the plugin feeds it a snapshot of the cookies and flushes
 * when this says the jar changed since the last flush.
 */
final class CookieFlushPolicy {

    private String lastFlushed;

    /** True when {@code snapshot} differs from the last one flushed; records it. */
    synchronized boolean shouldFlush(String snapshot) {
        if (snapshot == null ? lastFlushed == null : snapshot.equals(lastFlushed)) {
            return false;
        }
        lastFlushed = snapshot;
        return true;
    }

    /** Forget the last snapshot so the next one flushes (after an explicit flush or lifecycle flush). */
    synchronized void reset() {
        lastFlushed = null;
    }
}
