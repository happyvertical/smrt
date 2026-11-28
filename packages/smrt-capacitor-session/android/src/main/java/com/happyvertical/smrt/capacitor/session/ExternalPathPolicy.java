package com.happyvertical.smrt.capacitor.session;

/**
 * Decides whether a navigation leaves the WebView for the system (#5703). Pure
 * Java so it is tested without Android.
 *
 * Capacitor keeps every URL of the app's own origin in the WebView, which has no
 * download handling, so a same-origin file link does nothing there. A shell
 * opts in with path prefixes ({@code plugins.SmrtSession.external}); origin and
 * path rules are {@link AppLinkPolicy}'s. A URL that {@code links} also covers
 * stays in the WebView: sent out, a verified App Link would come straight back.
 */
final class ExternalPathPolicy {

    private ExternalPathPolicy() {}

    static boolean opensOutside(String url, String serverUrl, Iterable<String> external, Iterable<String> links) {
        return AppLinkPolicy.accept(url, serverUrl, external) != null
                && AppLinkPolicy.accept(url, serverUrl, links) == null;
    }
}
