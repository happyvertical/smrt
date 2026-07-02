package com.happyvertical.smrt.mobile.platform

/**
 * Platform seam for SHA-256 hashing of asset/manifest bytes. Pack and
 * evidence integrity pins are sha256 hex digests; concrete implementations
 * arrive with the platform adapters (MessageDigest on Android/JVM,
 * CryptoKit/CommonCrypto on iOS) in later phases.
 */
fun interface Sha256Hasher {
    fun sha256Hex(bytes: ByteArray): String
}
