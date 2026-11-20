package com.happyvertical.smrt.capacitor.session;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Plain-Java test (no JUnit, no Android): run by scripts/validate-plugin.mjs --test. */
public final class AppLinkPolicyTest {

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    public static void main(String[] args) {
        String server = "https://hearthed.org";
        List<String> links = Arrays.asList("/sign-in/email/complete", "/invite/accept/");
        String link = "https://hearthed.org/sign-in/email/complete#proof=abc.def";

        check(link.equals(AppLinkPolicy.accept(link, server, links)), "an allowed link loads unchanged, fragment kept");
        check(AppLinkPolicy.accept(link, server, null) == null, "no opt-in: nothing loads");
        check(AppLinkPolicy.accept(link, server, Collections.emptyList()) == null, "empty list: nothing loads");
        check(AppLinkPolicy.accept("https://hearthed.org/invite/accept?x=1#t=2", server, links) != null, "a trailing slash on a prefix is ignored; query kept");
        check(AppLinkPolicy.accept("https://hearthed.org/invite/accept/abc", server, links) != null, "a path under a prefix loads");
        check(AppLinkPolicy.accept("https://hearthed.org/sign-in/email/completed", server, links) == null, "a prefix matches at a segment boundary only");
        check(AppLinkPolicy.accept("https://hearthed.org/download/android", server, links) == null, "an unlisted path is refused");
        check(AppLinkPolicy.accept("https://hearthed.org/", server, links) == null, "the root is refused unless listed");
        check(AppLinkPolicy.accept("https://evil.test/sign-in/email/complete#proof=x", server, links) == null, "another host is refused");
        check(AppLinkPolicy.accept("https://hearthed.org.evil.test/sign-in/email/complete", server, links) == null, "a look-alike host is refused");
        check(AppLinkPolicy.accept("http://hearthed.org/sign-in/email/complete", server, links) == null, "another scheme is refused");
        check(AppLinkPolicy.accept("https://hearthed.org:8443/sign-in/email/complete", server, links) == null, "another port is refused");
        check(AppLinkPolicy.accept("https://HEARTHED.org:443/sign-in/email/complete", server, links) != null, "host case and the default port do not matter");
        check(AppLinkPolicy.accept("https://user@hearthed.org/sign-in/email/complete", server, links) == null, "user info is refused");
        check(AppLinkPolicy.accept("javascript:alert(1)", server, links) == null, "a non-http link is refused");
        check(AppLinkPolicy.accept("intent://hearthed.org/sign-in/email/complete", server, links) == null, "an intent: link is refused");
        check(AppLinkPolicy.accept("https://hearthed.org/sign-in/email/complete/../../download", server, links) == null, "a traversal is refused");
        check(AppLinkPolicy.accept("https://hearthed.org/sign-in/email/complete/./x", server, links) == null, "a dot segment is refused");
        check(AppLinkPolicy.accept("https://hearthed.org/sign-in/email/complete/%2e%2e/x", server, links) == null, "an encoded dot is refused");
        check(AppLinkPolicy.accept("https://hearthed.org/sign-in/email/complete%2f..%2fx", server, links) == null, "an encoded slash is refused");
        check(AppLinkPolicy.accept("not a url", server, links) == null && AppLinkPolicy.accept(null, server, links) == null, "garbage is refused");
        check(AppLinkPolicy.accept(link, null, links) == null, "no server.url: nothing loads");
        check(AppLinkPolicy.accept("http://localhost:5173/sign-in/email/complete#proof=x", "http://localhost:5173", links) != null, "a local http server.url works the same way");
        check(AppLinkPolicy.accept(link, server, Arrays.asList("sign-in", "/a?b", null)) == null, "unusable prefixes are skipped");
        List<String> root = Collections.singletonList("/");
        check(AppLinkPolicy.accept("https://hearthed.org#proof=abc", server, root) != null, "a root link with an empty path is the root path");
        check(AppLinkPolicy.accept("https://hearthed.org/#proof=abc", server, root) != null, "a root link with a slash is the root path");
        check(AppLinkPolicy.accept("https://hearthed.org/a/../b", server, root) == null, "a traversal is refused under a root prefix too");
        System.out.println("AppLinkPolicyTest: ok");
    }
}
