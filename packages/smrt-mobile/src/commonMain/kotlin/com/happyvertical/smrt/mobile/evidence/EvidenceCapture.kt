package com.happyvertical.smrt.mobile.evidence

import kotlinx.datetime.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Evidence capture model, seeded from amaru (ADR 0001). Generic here: asset
 * refs with SHA-256 pins, the geo location *sidecar* (geo travels as fields —
 * recompressed images carry no EXIF, ADR Correction 2), permission state, and
 * the platform adapter seam. Domain payload assembly stays app-side.
 */

object EvidenceCaptureSource {
    const val CAMERA = "camera"
    const val NATIVE_PICKER = "native_picker"
    const val NATIVE_PICKER_STUB = "native_picker_stub"
}

object EvidencePermissionStatus {
    const val GRANTED = "granted"
    const val DENIED = "denied"
    const val NOT_DETERMINED = "not_determined"
    const val UNAVAILABLE = "unavailable"
}

object EvidenceAssetStorageState {
    const val PENDING_CAPTURE = "pending_capture"
    const val STORED_OFFLINE = "stored_offline"
    const val MISSING_LOCAL_FILE = "missing_local_file"
    const val UNAVAILABLE = "unavailable"
}

/** A captured media asset stored app-privately, pinned by SHA-256. */
@Serializable
data class EvidenceAssetRef(
    val assetId: String,
    val localUri: String,
    val fileName: String,
    val contentType: String = "image/jpeg",
    val sizeBytes: Long? = null,
    val sha256: String = "",
    val captureSource: String = EvidenceCaptureSource.CAMERA,
    val originalUri: String = "",
    val storageRoot: String = "app_private",
    val relativePath: String = "",
    val storageState: String = EvidenceAssetStorageState.STORED_OFFLINE,
    val offlineSafe: Boolean = true,
    val persistedAt: Instant? = null,
) {
    fun toMetadataJson(): JsonObject = buildJsonObject {
        put("assetId", assetId)
        put("localUri", localUri)
        put("fileName", fileName)
        put("contentType", contentType)
        put("sizeBytes", sizeBytes ?: 0L)
        put("sha256", sha256)
        put("captureSource", captureSource)
        put("originalUri", originalUri)
        put("storageRoot", storageRoot)
        put("relativePath", relativePath)
        put("storageState", storageState)
        put("offlineSafe", offlineSafe)
        put("persistedAt", persistedAt?.toString() ?: "")
    }
}

/** Durable manifest entry for an offline-stored evidence asset. */
@Serializable
data class EvidenceOfflineAssetManifestEntry(
    val assetId: String,
    val localUri: String,
    val fileName: String,
    val contentType: String,
    val sizeBytes: Long,
    val sha256: String,
    val captureSource: String,
    val originalUri: String = "",
    val storageRoot: String = "app_private",
    val relativePath: String,
    val storageState: String = EvidenceAssetStorageState.STORED_OFFLINE,
    val offlineSafe: Boolean = true,
    val persistedAt: Instant,
)

/**
 * Geo sidecar for a capture. Geo is persisted as explicit fields, never
 * embedded EXIF — recompression strips EXIF on both platforms.
 */
@Serializable
data class EvidenceLocationMetadata(
    val permissionStatus: String,
    val gpsStatus: String,
    val latitude: String = "",
    val longitude: String = "",
    val accuracyMeters: String = "",
    val provider: String = "",
    val capturedAt: Instant? = null,
    val unavailableReason: String = "",
) {
    fun toGpsJson(): JsonObject = buildJsonObject {
        if (gpsStatus == "available") {
            put("latitude", latitude)
            put("longitude", longitude)
            put("accuracyMeters", accuracyMeters)
            put("provider", provider)
            put("capturedAt", capturedAt?.toString() ?: "")
        }
    }

    fun toMetadataJson(): JsonObject = buildJsonObject {
        put("permissionStatus", permissionStatus)
        put("gpsStatus", gpsStatus)
        put("unavailableReason", unavailableReason)
        put("provider", provider)
        put("capturedAt", capturedAt?.toString() ?: "")
    }

    companion object {
        fun available(
            latitude: String,
            longitude: String,
            accuracyMeters: String,
            provider: String,
            capturedAt: Instant,
        ): EvidenceLocationMetadata = EvidenceLocationMetadata(
            permissionStatus = EvidencePermissionStatus.GRANTED,
            gpsStatus = "available",
            latitude = latitude,
            longitude = longitude,
            accuracyMeters = accuracyMeters,
            provider = provider,
            capturedAt = capturedAt,
        )

        fun unavailable(
            permissionStatus: String,
            unavailableReason: String,
        ): EvidenceLocationMetadata = EvidenceLocationMetadata(
            permissionStatus = permissionStatus,
            gpsStatus = "unavailable",
            unavailableReason = unavailableReason,
        )
    }
}

@Serializable
data class EvidenceNativePermissionState(
    val cameraStatus: String,
    val photoLibraryStatus: String,
    val locationStatus: String,
)

/**
 * A capture request handed to the platform adapter. Domain identity travels
 * in [contextIds] (e.g. amaru: projectId/projectPackId/checklistItemId;
 * reporter: eventId) so the seam stays trade-neutral.
 */
@Serializable
data class EvidenceCaptureRequest(
    val tenantId: String = "",
    val contextIds: Map<String, String> = emptyMap(),
    val preferredSource: String = EvidenceCaptureSource.CAMERA,
)

@Serializable
data class EvidenceCaptureResult(
    val localAsset: EvidenceAssetRef?,
    val location: EvidenceLocationMetadata,
    val permissions: EvidenceNativePermissionState,
    val captureAvailable: Boolean,
    val userMessage: String = "",
)

/** Platform seam: camera/picker capture plus a current-location probe. */
interface EvidenceCapturePlatformAdapter {
    suspend fun captureOrPickPhoto(request: EvidenceCaptureRequest): EvidenceCaptureResult

    suspend fun currentLocationMetadata(): EvidenceLocationMetadata
}
