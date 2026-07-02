package com.happyvertical.smrt.mobile.packs

import kotlinx.datetime.Instant
import kotlinx.serialization.Serializable

/**
 * Integrity envelope carried by an offline pack: the algorithm and hash the
 * pack's manifest was sealed with. Hash computation itself happens where the
 * bytes are (platform download layer, via
 * [com.happyvertical.smrt.mobile.platform.Sha256Hasher]); common code only
 * compares sealed values.
 */
@Serializable
data class PackIntegrity(
    val hashAlgorithm: String = "sha256",
    val hash: String = "",
)

/** A file the pack requires offline, with its integrity pin. */
@Serializable
data class RequiredAssetRef(
    val id: String,
    val fileName: String,
    val contentType: String = "",
    val sha256: String = "",
    val sizeBytes: Long = 0,
)

/**
 * The immutable-snapshot identity of a downloaded pack. Domain manifests
 * (per app) embed this next to their own payload; [PackIntegrityCheck]
 * verifies the seal.
 */
@Serializable
data class PackSnapshotInfo(
    val packId: String,
    val version: Int = 1,
    val manifestHash: String = "",
    val publishedAt: Instant? = null,
)

data class PackIntegrityResult(
    val valid: Boolean,
    val expectedHash: String,
    val actualHash: String,
    val message: String,
)

class PackIntegrityCheck {
    fun verifyManifestHash(
        integrity: PackIntegrity,
        expectedHash: String,
    ): PackIntegrityResult {
        val actualHash = integrity.hash
        if (!integrity.hashAlgorithm.equals("sha256", ignoreCase = true)) {
            return PackIntegrityResult(
                valid = false,
                expectedHash = expectedHash,
                actualHash = actualHash,
                message = "Unsupported pack hash algorithm: ${integrity.hashAlgorithm}",
            )
        }
        val valid = actualHash.isNotBlank() && actualHash == expectedHash

        return PackIntegrityResult(
            valid = valid,
            expectedHash = expectedHash,
            actualHash = actualHash,
            message = if (valid) {
                "Pack integrity verified"
            } else {
                "Pack integrity mismatch"
            },
        )
    }

    fun verifySnapshot(
        snapshot: PackSnapshotInfo,
        integrity: PackIntegrity,
    ): PackIntegrityResult = verifyManifestHash(integrity, snapshot.manifestHash)
}
