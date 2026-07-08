package com.happyvertical.smrt.android.platform

import com.happyvertical.smrt.mobile.platform.Sha256Hasher
import java.security.MessageDigest

/**
 * [MessageDigest]-backed implementation of smrt-mobile's [Sha256Hasher]
 * seam — pack and evidence integrity pins are sha256 hex digests.
 */
object AndroidSha256Hasher : Sha256Hasher {
    override fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString(separator = "") { byte -> "%02x".format(byte) }
}
