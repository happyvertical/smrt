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
        System.out.println("CookieFlushPolicyTest: ok");
    }
}
