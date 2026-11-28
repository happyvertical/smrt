package com.happyvertical.smrt.capacitor.session;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Plain-Java test (no JUnit, no Android): run by scripts/validate-plugin.mjs --test. */
public final class ExternalPathPolicyTest {

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    private static boolean outside(String url, List<String> external, List<String> links) {
        return ExternalPathPolicy.opensOutside(url, "https://hearthed.org", external, links);
    }

    public static void main(String[] args) {
        List<String> external = Collections.singletonList("/download");
        List<String> links = Collections.singletonList("/sign-in/email/complete");
        String apk = "https://hearthed.org/download/android/app-7.apk";

        check(outside(apk, external, links), "a file under a listed path leaves the WebView");
        check(outside("https://hearthed.org/download?x=1#y", external, null), "the listed path itself, query kept, no links");
        check(!outside(apk, null, links), "no opt-in: nothing leaves");
        check(!outside(apk, Collections.emptyList(), links), "empty list: nothing leaves");
        check(!outside("https://hearthed.org/downloads", external, links), "a prefix matches at a segment boundary only");
        check(!outside("https://hearthed.org/lessons", external, links), "other app pages stay");
        check(!outside("https://other.test/download/a.apk", external, links), "another origin is Capacitor's to decide");
        check(!outside("https://hearthed.org/download/../account", external, links), "a traversal is not matched");
        check(!outside("blob:https://hearthed.org/download/a", external, links), "a non-http URL is not matched");
        check(!outside("https://hearthed.org/sign-in/email/complete#proof=x", Collections.singletonList("/"), links),
                "a path the shell also lists in links stays");
        check(!outside(apk, external, Arrays.asList("/download")), "links wins over external");
        check(!ExternalPathPolicy.opensOutside(apk, null, external, links), "no server.url: nothing leaves");
        System.out.println("ExternalPathPolicyTest: ok");
    }
}
