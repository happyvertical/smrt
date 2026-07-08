package com.happyvertical.smrt.android.platform

import com.happyvertical.smrt.mobile.evidence.EvidenceAssetRef
import com.happyvertical.smrt.mobile.evidence.EvidenceAssetStorageState
import com.happyvertical.smrt.mobile.evidence.EvidenceCaptureRequest
import com.happyvertical.smrt.mobile.evidence.EvidenceCaptureSource
import com.happyvertical.smrt.mobile.evidence.EvidencePermissionStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.datetime.Instant

/**
 * The evidence adapter's native-state → shared-DTO projection is a set of pure
 * functions (issue #1880), so they run device-free here. The camera/picker
 * drive itself needs an Activity + on-device UI and is exercised by the sample.
 */
class EvidenceCaptureMappingTest {
    @Test
    fun captureSegmentTakesFirstNonBlankContextIdBySortedKey() {
        assertEquals(
            "checklist-1",
            evidenceCaptureSegment(
                EvidenceCaptureRequest(contextIds = mapOf("checklistItemId" to "checklist-1")),
            ),
        )
        // Sorted by key → "a" wins over "z" (deterministic regardless of map order).
        assertEquals(
            "first",
            evidenceCaptureSegment(
                EvidenceCaptureRequest(contextIds = mapOf("z" to "second", "a" to "first")),
            ),
        )
        assertEquals("evidence", evidenceCaptureSegment(EvidenceCaptureRequest()))
        assertEquals(
            "evidence",
            evidenceCaptureSegment(EvidenceCaptureRequest(contextIds = mapOf("k" to "  "))),
        )
        assertEquals(
            "a_b_c",
            evidenceCaptureSegment(EvidenceCaptureRequest(contextIds = mapOf("k" to "a/b c"))),
        )
    }

    @Test
    fun sanitizeSegmentStripsUnsafeCharacters() {
        assertEquals("a_b", sanitizeEvidenceSegment("a/b"))
        assertEquals("keep-this_1", sanitizeEvidenceSegment("keep-this_1"))
        assertEquals("evidence", sanitizeEvidenceSegment(""))
        // Separators become underscores; only genuinely blank input falls back.
        assertEquals("___", sanitizeEvidenceSegment("///"))
    }

    @Test
    fun assetIdComposesSegmentAndEpochMillis() {
        assertEquals("asset_checklist-1_1700", evidenceAssetId("checklist-1", 1700L))
    }

    @Test
    fun extensionMapsFromContentType() {
        assertEquals("jpg", evidenceExtensionForContentType("image/jpeg"))
        assertEquals("png", evidenceExtensionForContentType("image/png"))
        assertEquals("heic", evidenceExtensionForContentType("image/heic"))
        assertEquals("webp", evidenceExtensionForContentType("image/webp"))
        assertEquals("jpg", evidenceExtensionForContentType("application/octet-stream"))
        // Tolerates a charset parameter + casing.
        assertEquals("png", evidenceExtensionForContentType("IMAGE/PNG; charset=binary"))
    }

    @Test
    fun cameraStatusMapsFeatureAndGrant() {
        assertEquals(
            EvidencePermissionStatus.UNAVAILABLE,
            evidenceCameraStatus(hasCameraFeature = false, granted = true),
        )
        assertEquals(
            EvidencePermissionStatus.GRANTED,
            evidenceCameraStatus(hasCameraFeature = true, granted = true),
        )
        assertEquals(
            EvidencePermissionStatus.DENIED,
            evidenceCameraStatus(hasCameraFeature = true, granted = false),
        )
    }

    @Test
    fun photoLibraryStatusMapsPickerAvailability() {
        assertEquals(EvidencePermissionStatus.GRANTED, evidencePhotoLibraryStatus(true))
        assertEquals(EvidencePermissionStatus.UNAVAILABLE, evidencePhotoLibraryStatus(false))
    }

    @Test
    fun locationMetadataProjectsPermissionAndSnapshot() {
        val denied = evidenceLocationMetadata(permissionGranted = false, providerAvailable = false, snapshot = null)
        assertEquals("unavailable", denied.gpsStatus)
        assertEquals(EvidencePermissionStatus.DENIED, denied.permissionStatus)
        assertEquals("permission_denied", denied.unavailableReason)

        val noProvider = evidenceLocationMetadata(permissionGranted = true, providerAvailable = false, snapshot = null)
        assertEquals(EvidencePermissionStatus.UNAVAILABLE, noProvider.permissionStatus)
        assertEquals("provider_unavailable", noProvider.unavailableReason)

        val noFix = evidenceLocationMetadata(permissionGranted = true, providerAvailable = true, snapshot = null)
        assertEquals(EvidencePermissionStatus.GRANTED, noFix.permissionStatus)
        assertEquals("last_location_unavailable", noFix.unavailableReason)

        val available = evidenceLocationMetadata(
            permissionGranted = true,
            providerAvailable = true,
            snapshot = LocationSnapshot(45.5, -73.6, 8.0f, "gps", 1_700_000_000_000L),
        )
        assertEquals("available", available.gpsStatus)
        assertEquals(EvidencePermissionStatus.GRANTED, available.permissionStatus)
        assertEquals("45.5", available.latitude)
        assertEquals("-73.6", available.longitude)
        assertEquals("8.0", available.accuracyMeters)
        assertEquals("gps", available.provider)
        assertEquals(Instant.fromEpochMilliseconds(1_700_000_000_000L), available.capturedAt)
    }

    @Test
    fun verifiedAssetFlipsStateOnFilePresence() {
        val base = EvidenceAssetRef(
            assetId = "asset_x_1",
            localUri = "file:///x",
            fileName = "asset_x_1.jpg",
            contentType = "image/jpeg",
            captureSource = EvidenceCaptureSource.CAMERA,
            storageRoot = "app_private",
            relativePath = "evidence/asset_x_1.jpg",
            storageState = EvidenceAssetStorageState.PENDING_CAPTURE,
            offlineSafe = false,
        )
        val at = Instant.fromEpochMilliseconds(1L)

        val stored = verifiedEvidenceAsset(base, exists = true, sizeBytes = 2048L, sha256 = "abcd", persistedAt = at)
        assertEquals(EvidenceAssetStorageState.STORED_OFFLINE, stored.storageState)
        assertEquals(2048L, stored.sizeBytes)
        assertEquals("abcd", stored.sha256)
        assertTrue(stored.offlineSafe)
        assertEquals(at, stored.persistedAt)

        val missing = verifiedEvidenceAsset(base, exists = false, sizeBytes = 0L, sha256 = "", persistedAt = at)
        assertEquals(EvidenceAssetStorageState.MISSING_LOCAL_FILE, missing.storageState)
        assertFalse(missing.offlineSafe)
        assertNull(missing.sizeBytes)
        assertNull(missing.persistedAt)

        val emptyFile = verifiedEvidenceAsset(base, exists = true, sizeBytes = 0L, sha256 = "", persistedAt = at)
        assertEquals(EvidenceAssetStorageState.MISSING_LOCAL_FILE, emptyFile.storageState)
        assertEquals(0L, emptyFile.sizeBytes)
    }
}
