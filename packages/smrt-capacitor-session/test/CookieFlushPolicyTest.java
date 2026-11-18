package com.happyvertical.smrt.capacitor.session;

/** Plain-Java test (no JUnit, no Android): run by scripts/validate-plugin.mjs --test. */
public final class CookieFlushPolicyTest {

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    public static void main(String[] args) {
        CookieFlushPolicy p = new CookieFlushPolicy();
        check(!p.shouldFlush(null), "no cookies yet: nothing to flush");
        check(p.shouldFlush("session=abc"), "first cookie flushes");
        check(!p.shouldFlush("session=abc"), "unchanged jar does not flush again");
        check(p.shouldFlush("session=abc; theme=dark"), "added cookie flushes");
        check(p.shouldFlush("theme=dark"), "removed cookie (sign-out) flushes");
        check(p.shouldFlush(null), "emptied jar flushes");
        check(!p.shouldFlush(null), "still empty does not flush");
        p.shouldFlush("session=abc");
        p.reset();
        check(p.shouldFlush("session=abc"), "after a forced flush the next snapshot flushes");
        check("https://a.test:8443".equals(CookieFlushPolicy.origin("https://a.test:8443/x?y=1")), "origin keeps scheme, host and port");
        check(CookieFlushPolicy.origin("not a url") == null && CookieFlushPolicy.origin(null) == null, "non-URLs have no origin");
        java.util.Set<String> o = CookieFlushPolicy.origins(java.util.Arrays.asList("https://localhost/", "https://app.test/a", null, "https://app.test/b", "https://localhost"));
        check(o.size() == 2, "origins are deduplicated and nulls skipped");
        java.util.Map<String, String> jar = new java.util.HashMap<>();
        CookieFlushPolicy q = new CookieFlushPolicy();
        check(!q.shouldFlush(CookieFlushPolicy.snapshot(o, jar::get)), "no cookies on any origin");
        jar.put("https://app.test", "session=abc");
        check(q.shouldFlush(CookieFlushPolicy.snapshot(o, jar::get)), "a cookie on the remote origin alone flushes though the page is on localhost");
        check(!q.shouldFlush(CookieFlushPolicy.snapshot(o, jar::get)), "unchanged multi-origin jar does not flush");
        jar.put("https://localhost", "theme=dark");
        check(q.shouldFlush(CookieFlushPolicy.snapshot(o, jar::get)), "a change on the other origin flushes");
        System.out.println("CookieFlushPolicyTest: ok");
    }
}
