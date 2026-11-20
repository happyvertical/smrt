package com.happyvertical.smrt.capacitor.session;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Remembers links already opened in the WebView, as SHA-256 digests, so a
 * one-time link is never opened twice (#5361). Android rebuilds an activity
 * killed in the background from the intent that first started it, and
 * Capacitor passes that intent to plugins again; clearing its data only
 * changes the in-process copy. Only digests are kept (never the link or its
 * proof), newest last, at most {@link #MAX}. Pure Java so it is tested without
 * Android; the plugin stores {@link #remember}'s result in its preferences.
 */
final class SpentLinks {

    static final int MAX = 16;

    private SpentLinks() {}

    /** Lower-case hex SHA-256 of the link as delivered. */
    static String digest(String link) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(link.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> parse(String stored) {
        List<String> out = new ArrayList<>();
        if (stored == null || stored.isEmpty()) {
            return out;
        }
        for (String s : Arrays.asList(stored.split(","))) {
            if (s.matches("[0-9a-f]{64}")) {
                out.add(s);
            }
        }
        return out;
    }

    /** True when {@code digest} was remembered in {@code stored}. */
    static boolean seen(String stored, String digest) {
        return digest != null && parse(stored).contains(digest);
    }

    /** {@code stored} with {@code digest} added as newest, oldest dropped past {@link #MAX}. */
    static String remember(String stored, String digest) {
        List<String> list = parse(stored);
        list.remove(digest);
        list.add(digest);
        while (list.size() > MAX) {
            list.remove(0);
        }
        return String.join(",", list);
    }

    /** The link without query or fragment: the page that loading it shows. */
    static String page(String link) {
        int cut = link.length();
        int q = link.indexOf('?');
        int h = link.indexOf('#');
        if (q >= 0) cut = Math.min(cut, q);
        if (h >= 0) cut = Math.min(cut, h);
        return link.substring(0, cut);
    }
}
