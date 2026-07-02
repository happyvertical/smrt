package com.happyvertical.smrt.mobile.evidence

import kotlinx.datetime.Instant
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EvidenceCaptureTest {
    @Test
    fun availableLocationEmitsGpsJson() {
        val location = EvidenceLocationMetadata.available(
            latitude = "50.4452",
            longitude = "-104.6189",
            accuracyMeters = "8.5",
            provider = "fused",
            capturedAt = Instant.parse("2026-07-01T12:00:00Z"),
        )

        val gps = location.toGpsJson()
        assertEquals("50.4452", gps["latitude"]?.jsonPrimitive?.content)
        assertEquals("-104.6189", gps["longitude"]?.jsonPrimitive?.content)
        assertEquals("fused", gps["provider"]?.jsonPrimitive?.content)
    }

    @Test
    fun unavailableLocationEmitsEmptyGpsJson() {
        val location = EvidenceLocationMetadata.unavailable(
            permissionStatus = EvidencePermissionStatus.DENIED,
            unavailableReason = "permission_denied",
        )

        assertTrue(location.toGpsJson().isEmpty())
        assertEquals(
            "permission_denied",
            location.toMetadataJson()["unavailableReason"]?.jsonPrimitive?.content,
        )
    }

    @Test
    fun assetRefMetadataJsonCarriesIntegrityFields() {
        val asset = EvidenceAssetRef(
            assetId = "asset-1",
            localUri = "file:///data/evidence/asset-1.jpg",
            fileName = "asset-1.jpg",
            sha256 = "deadbeef",
            sizeBytes = 1024,
            relativePath = "evidence/asset-1.jpg",
        )

        val json = asset.toMetadataJson()
        assertEquals("deadbeef", json["sha256"]?.jsonPrimitive?.content)
        assertEquals("1024", json["sizeBytes"]?.jsonPrimitive?.content)
        assertEquals("app_private", json["storageRoot"]?.jsonPrimitive?.content)
    }

    @Test
    fun captureRequestCarriesDomainContextIds() {
        val request = EvidenceCaptureRequest(
            tenantId = "tenant-1",
            contextIds = mapOf("projectId" to "p-1", "checklistItemId" to "c-9"),
        )

        assertEquals("p-1", request.contextIds["projectId"])
        assertEquals(EvidenceCaptureSource.CAMERA, request.preferredSource)
    }
}
