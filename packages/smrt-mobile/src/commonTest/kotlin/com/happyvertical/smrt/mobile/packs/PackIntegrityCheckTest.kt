package com.happyvertical.smrt.mobile.packs

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PackIntegrityCheckTest {
    private val check = PackIntegrityCheck()

    @Test
    fun verifiesMatchingHash() {
        val result = check.verifyManifestHash(
            integrity = PackIntegrity(hashAlgorithm = "sha256", hash = "abc123"),
            expectedHash = "abc123",
        )

        assertTrue(result.valid)
        assertEquals("Pack integrity verified", result.message)
    }

    @Test
    fun rejectsMismatchedHash() {
        val result = check.verifyManifestHash(
            integrity = PackIntegrity(hash = "abc123"),
            expectedHash = "def456",
        )

        assertFalse(result.valid)
        assertEquals("abc123", result.actualHash)
        assertEquals("def456", result.expectedHash)
    }

    @Test
    fun rejectsBlankActualHashEvenWhenExpectedBlank() {
        val result = check.verifyManifestHash(
            integrity = PackIntegrity(hash = ""),
            expectedHash = "",
        )

        assertFalse(result.valid)
    }

    @Test
    fun verifySnapshotUsesSnapshotManifestHash() {
        val snapshot = PackSnapshotInfo(packId = "pack-1", version = 3, manifestHash = "abc123")
        val result = check.verifySnapshot(snapshot, PackIntegrity(hash = "abc123"))

        assertTrue(result.valid)
    }
}
