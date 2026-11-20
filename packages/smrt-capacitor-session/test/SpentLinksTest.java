package com.happyvertical.smrt.capacitor.session;

/** Plain-Java test (no JUnit, no Android): run by scripts/validate-plugin.mjs --test. */
public final class SpentLinksTest {

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }

    public static void main(String[] args) {
        String link = "https://hearthed.org/sign-in/email/complete#proof=abc";
        String d = SpentLinks.digest(link);
        check(d.matches("[0-9a-f]{64}"), "a digest is 64 lower-case hex characters");
        check(!d.contains("abc") && d.equals(SpentLinks.digest(link)), "the digest is stable and holds no proof text");
        check(!d.equals(SpentLinks.digest(link + "x")), "another proof is another digest");

        check(!SpentLinks.seen("", d) && !SpentLinks.seen(null, d), "nothing is spent at first");
        String stored = SpentLinks.remember("", d);
        check(SpentLinks.seen(stored, d), "a remembered link is spent (a rebuilt activity will not reopen it)");
        check(SpentLinks.remember(stored, d).equals(stored), "remembering twice keeps one entry");
        check(!SpentLinks.seen(stored, SpentLinks.digest("https://hearthed.org/sign-in/email/complete#proof=new")), "a new link is not spent");
        check(SpentLinks.seen("garbage," + stored + ",zz", d) && !SpentLinks.remember("garbage", d).contains("garbage"), "malformed entries are ignored and dropped");

        String many = "";
        String first = SpentLinks.digest("link-0");
        for (int i = 0; i <= SpentLinks.MAX; i++) {
            many = SpentLinks.remember(many, SpentLinks.digest("link-" + i));
        }
        check(many.split(",").length == SpentLinks.MAX, "at most MAX digests are kept");
        check(!SpentLinks.seen(many, first), "the oldest is dropped first");
        check(SpentLinks.seen(many, SpentLinks.digest("link-" + SpentLinks.MAX)), "the newest is kept");

        check(SpentLinks.page(link).equals("https://hearthed.org/sign-in/email/complete"), "the page drops the fragment");
        check(SpentLinks.page("https://a.test/p?x=1#y").equals("https://a.test/p"), "the page drops the query");
        check(SpentLinks.page("https://a.test/p").equals("https://a.test/p"), "a plain link is its own page");
        System.out.println("SpentLinksTest: ok");
    }
}
