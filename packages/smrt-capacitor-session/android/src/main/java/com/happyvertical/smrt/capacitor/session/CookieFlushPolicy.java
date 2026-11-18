package com.happyvertical.smrt.capacitor.session;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.function.Function;

/**
 * Decides when the WebView cookie jar needs flushing. Pure Java so it is tested
 * without Android: the plugin feeds it a snapshot of the cookies and flushes
 * when this says the jar changed since the last flush.
 */
final class CookieFlushPolicy {

    private String lastFlushed;

    /** Origin (scheme://host[:port]) of a URL, or null when it has none; deduplication key. */
    static String origin(String url) {
        if (url == null) {
            return null;
        }
        try {
            URI uri = URI.create(url.trim());
            if (uri.getScheme() == null || uri.getHost() == null) {
                return null;
            }
            return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** The distinct origins among {@code urls}, in order; nulls and non-URLs are skipped. */
    static Set<String> origins(Iterable<String> urls) {
        Set<String> out = new LinkedHashSet<>();
        for (String url : urls) {
            String o = origin(url);
            if (o != null) {
                out.add(o);
            }
        }
        return out;
    }

    /** One snapshot of the cookie jars of every origin; null when none has a cookie. */
    static String snapshot(Set<String> origins, Function<String, String> cookiesFor) {
        StringBuilder sb = null;
        for (String o : origins) {
            String c = cookiesFor.apply(o);
            if (c != null) {
                sb = (sb == null ? new StringBuilder() : sb.append('\n')).append(o).append('=').append(c);
            }
        }
        return sb == null ? null : sb.toString();
    }

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
