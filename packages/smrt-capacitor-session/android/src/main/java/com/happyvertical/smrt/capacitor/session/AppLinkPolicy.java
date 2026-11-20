package com.happyvertical.smrt.capacitor.session;

import java.net.URI;
import java.util.Locale;

/**
 * Decides whether an incoming VIEW link may be loaded into the WebView (#5361).
 * Pure Java so it is tested without Android.
 *
 * A link is accepted only when the host opted in with path prefixes
 * ({@code plugins.SmrtSession.links}), the link is http(s) with no user info,
 * its origin equals the origin of Capacitor's {@code server.url}, and its
 * normalized path is a listed prefix or lies under one at a segment boundary.
 * The activity is exported, so anything else (another origin, another path,
 * a traversal) is refused rather than steering the WebView.
 */
final class AppLinkPolicy {

    private AppLinkPolicy() {}

    /** Lower-cased scheme://host[:port] with the default port dropped, or null. */
    static String origin(URI uri) {
        if (uri == null || uri.getScheme() == null || uri.getHost() == null) {
            return null;
        }
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) {
            return null;
        }
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }

    private static URI parse(String url) {
        if (url == null) {
            return null;
        }
        try {
            return URI.create(url.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** A listed prefix in canonical form ("/a/b", no trailing slash), or null when unusable. */
    static String prefix(String raw) {
        if (raw == null) {
            return null;
        }
        String p = raw.trim();
        if (!p.startsWith("/") || p.contains("?") || p.contains("#")) {
            return null;
        }
        while (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    /**
     * The link to load, unchanged (query and fragment kept), or null when it is
     * not allowed. {@code prefixes} null or empty means the host did not opt in.
     */
    static String accept(String link, String serverUrl, Iterable<String> prefixes) {
        if (prefixes == null) {
            return null;
        }
        URI uri = parse(link);
        URI server = parse(serverUrl);
        String linkOrigin = origin(uri);
        if (linkOrigin == null || uri.getRawUserInfo() != null || !linkOrigin.equals(origin(server))) {
            return null;
        }
        String rawPath = uri.getRawPath();
        if (rawPath == null || rawPath.isEmpty()) {
            rawPath = "/";
        }
        // An encoded slash or dot could hide a traversal from the segment check.
        String lower = rawPath.toLowerCase(Locale.ROOT);
        if (lower.contains("%2f") || lower.contains("%5c") || lower.contains("%2e") || rawPath.contains("\\")) {
            return null;
        }
        // Any "." or ".." segment is refused outright, not resolved.
        String path = rawPath;
        if (!path.equals(uri.normalize().getRawPath()) || path.contains("/../") || path.endsWith("/..")
                || path.contains("/./") || path.endsWith("/.")) {
            return null;
        }
        for (String raw : prefixes) {
            String p = prefix(raw);
            if (p == null) {
                continue;
            }
            if (p.equals("/") || path.equals(p) || path.startsWith(p + "/")) {
                return link.trim();
            }
        }
        return null;
    }
}
