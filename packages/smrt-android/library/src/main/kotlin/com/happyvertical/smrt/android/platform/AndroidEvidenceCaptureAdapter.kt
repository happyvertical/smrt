package com.happyvertical.smrt.android.platform

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import com.happyvertical.smrt.mobile.evidence.EvidenceAssetRef
import com.happyvertical.smrt.mobile.evidence.EvidenceAssetStorageState
import com.happyvertical.smrt.mobile.evidence.EvidenceCapturePlatformAdapter
import com.happyvertical.smrt.mobile.evidence.EvidenceCaptureRequest
import com.happyvertical.smrt.mobile.evidence.EvidenceCaptureResult
import com.happyvertical.smrt.mobile.evidence.EvidenceCaptureSource
import com.happyvertical.smrt.mobile.evidence.EvidenceLocationMetadata
import com.happyvertical.smrt.mobile.evidence.EvidenceNativePermissionState
import com.happyvertical.smrt.mobile.evidence.EvidencePermissionStatus
import com.happyvertical.smrt.mobile.platform.Sha256Hasher
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/**
 * Android implementation of smrt-mobile's [EvidenceCapturePlatformAdapter]
 * (issue #1880; joint iOS+Android design record on that issue).
 *
 * **Drive-to-completion**, unlike amaru's prepare-only seed: [captureOrPickPhoto]
 * requests the permissions it needs, presents the OS camera or system photo
 * picker, awaits the user, copies the result into app-private storage, computes
 * a SHA-256 pin, verifies the file, and returns a `STORED_OFFLINE`
 * [EvidenceAssetRef] (or a null asset on cancel / no-capture-surface). One
 * awaitable call — the `ActivityResult` plumbing lives here, not in every
 * consumer.
 *
 * Full-resolution capture uses [ActivityResultContracts.TakePicture] writing to
 * a **library-shipped FileProvider** content URI (the external camera app fills
 * our app-private file at full res — fixing the reporter's thumbnail-only
 * anti-pattern of `ACTION_IMAGE_CAPTURE` without `EXTRA_OUTPUT`). The provider
 * authority defaults to `${applicationId}.evidence.files` (the merged manifest
 * placeholder); a consumer overriding it via `tools:replace` must pass the
 * matching [fileProviderAuthority].
 *
 * Geo travels as an [EvidenceLocationMetadata] **sidecar** (lat/long/accuracy
 * fields), never EXIF — recompression strips EXIF (ADR Correction 2). Storage
 * root is the platform-neutral `app_private`; the SHA-256 pin is bare lowercase
 * hex from [AndroidSha256Hasher].
 *
 * Needs a [ComponentActivity] (it is both the [Context] and the
 * `ActivityResultRegistryOwner`). The register→launch→resume path does not
 * survive process death of an in-flight capture — acceptable for the
 * foundation + sample; a consumer needing it should re-register on lifecycle.
 */
class AndroidEvidenceCaptureAdapter(
    private val activity: ComponentActivity,
    private val fileProviderAuthority: String = "${activity.packageName}.evidence.files",
    private val hasher: Sha256Hasher = AndroidSha256Hasher,
    private val clock: () -> Instant = { Clock.System.now() },
) : EvidenceCapturePlatformAdapter {

    private val requestCounter = AtomicInteger(0)

    override suspend fun captureOrPickPhoto(request: EvidenceCaptureRequest): EvidenceCaptureResult {
        val hasCameraFeature =
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
        val wantsCamera =
            request.preferredSource == EvidenceCaptureSource.CAMERA && hasCameraFeature

        // Drive-to-completion: request what the flow needs before capturing.
        val toRequest = buildList {
            if (wantsCamera && !hasPermission(Manifest.permission.CAMERA)) {
                add(Manifest.permission.CAMERA)
            }
            if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) &&
                !hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            ) {
                add(Manifest.permission.ACCESS_FINE_LOCATION)
                add(Manifest.permission.ACCESS_COARSE_LOCATION)
            }
        }
        if (toRequest.isNotEmpty()) {
            withContext(Dispatchers.Main.immediate) {
                launchForResult(
                    ActivityResultContracts.RequestMultiplePermissions(),
                    toRequest.toTypedArray(),
                )
            }
        }

        val location = currentLocationMetadata()
        val cameraGranted = hasPermission(Manifest.permission.CAMERA)
        val pickerReady = nativePickerAvailable()
        val permissions = EvidenceNativePermissionState(
            cameraStatus = evidenceCameraStatus(hasCameraFeature, cameraGranted),
            photoLibraryStatus = evidencePhotoLibraryStatus(pickerReady),
            locationStatus = location.permissionStatus,
        )
        val cameraReady = hasCameraFeature && cameraGranted

        return when {
            request.preferredSource == EvidenceCaptureSource.CAMERA && cameraReady ->
                captureFromCamera(request, location, permissions)

            pickerReady -> pickFromLibrary(request, location, permissions)
            cameraReady -> captureFromCamera(request, location, permissions)
            else -> EvidenceCaptureResult(
                localAsset = null,
                location = location,
                permissions = permissions,
                captureAvailable = false,
                userMessage = "No camera or image picker is available on this device.",
            )
        }
    }

    override suspend fun currentLocationMetadata(): EvidenceLocationMetadata =
        withContext(Dispatchers.IO) {
            val granted = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
                hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (!granted) {
                return@withContext evidenceLocationMetadata(false, false, null)
            }
            val manager = activity.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                ?: return@withContext evidenceLocationMetadata(true, false, null)
            val location = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
                .firstNotNullOfOrNull { provider -> lastKnownLocation(manager, provider) }
            evidenceLocationMetadata(true, true, location?.toSnapshot())
        }

    private suspend fun captureFromCamera(
        request: EvidenceCaptureRequest,
        location: EvidenceLocationMetadata,
        permissions: EvidenceNativePermissionState,
    ): EvidenceCaptureResult {
        val assetId = evidenceAssetId(evidenceCaptureSegment(request), clock().toEpochMilliseconds())
        val file = File(evidenceDir(), "$assetId.jpg")
        val outputUri = FileProvider.getUriForFile(activity, fileProviderAuthority, file)
        val base = pendingAsset(assetId, file, "image/jpeg", EvidenceCaptureSource.CAMERA, "")

        val saved = withContext(Dispatchers.Main.immediate) {
            launchForResult(ActivityResultContracts.TakePicture(), outputUri)
        }
        if (!saved) {
            withContext(Dispatchers.IO) { runCatching { if (file.exists()) file.delete() } }
            return cancelled(location, permissions)
        }
        val asset = withContext(Dispatchers.IO) { finalize(base, file) }
        return EvidenceCaptureResult(
            localAsset = asset,
            location = location,
            permissions = permissions,
            captureAvailable = true,
            userMessage = capturedMessage(asset),
        )
    }

    private suspend fun pickFromLibrary(
        request: EvidenceCaptureRequest,
        location: EvidenceLocationMetadata,
        permissions: EvidenceNativePermissionState,
    ): EvidenceCaptureResult {
        val picked: Uri? = withContext(Dispatchers.Main.immediate) {
            launchForResult(
                ActivityResultContracts.PickVisualMedia(),
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
        }
        if (picked == null) return cancelled(location, permissions)

        val asset = withContext(Dispatchers.IO) {
            val contentType = activity.contentResolver.getType(picked) ?: "image/jpeg"
            val extension = evidenceExtensionForContentType(contentType)
            val assetId =
                evidenceAssetId(evidenceCaptureSegment(request), clock().toEpochMilliseconds())
            val file = File(evidenceDir(), "$assetId.$extension")
            activity.contentResolver.openInputStream(picked)?.use { input ->
                FileOutputStream(file).use { output -> input.copyTo(output) }
            } ?: error("Cannot open selected evidence asset")
            finalize(
                pendingAsset(
                    assetId,
                    file,
                    contentType,
                    EvidenceCaptureSource.NATIVE_PICKER,
                    picked.toString(),
                ),
                file,
            )
        }
        return EvidenceCaptureResult(
            localAsset = asset,
            location = location,
            permissions = permissions,
            captureAvailable = true,
            userMessage = capturedMessage(asset),
        )
    }

    /** Reserved asset before the file exists (`pending_capture`, not offline-safe). */
    private fun pendingAsset(
        assetId: String,
        file: File,
        contentType: String,
        source: String,
        originalUri: String,
    ): EvidenceAssetRef = EvidenceAssetRef(
        assetId = assetId,
        localUri = file.toURI().toString(),
        fileName = file.name,
        contentType = contentType,
        sizeBytes = null,
        sha256 = "",
        captureSource = source,
        originalUri = originalUri,
        storageRoot = STORAGE_ROOT,
        relativePath = "evidence/${file.name}",
        storageState = EvidenceAssetStorageState.PENDING_CAPTURE,
        offlineSafe = false,
        persistedAt = null,
    )

    /** Reads the on-disk file and pins it (size + sha256) via the pure verifier. */
    private fun finalize(base: EvidenceAssetRef, file: File): EvidenceAssetRef {
        val exists = file.exists()
        val sizeBytes = if (exists) file.length() else 0L
        val sha256 = if (exists && sizeBytes > 0L) hasher.sha256Hex(file.readBytes()) else ""
        return verifiedEvidenceAsset(base, exists, sizeBytes, sha256, clock())
    }

    private fun cancelled(
        location: EvidenceLocationMetadata,
        permissions: EvidenceNativePermissionState,
    ): EvidenceCaptureResult = EvidenceCaptureResult(
        localAsset = null,
        location = location,
        permissions = permissions,
        captureAvailable = true,
        userMessage = "Capture cancelled.",
    )

    private fun capturedMessage(asset: EvidenceAssetRef): String =
        if (asset.storageState == EvidenceAssetStorageState.STORED_OFFLINE) {
            "Evidence stored offline (${asset.sizeBytes ?: 0L} bytes)."
        } else {
            "Capture could not be verified; the local file is missing."
        }

    private fun evidenceDir(): File = File(activity.filesDir, "evidence").apply { mkdirs() }

    private fun nativePickerAvailable(): Boolean =
        ActivityResultContracts.PickVisualMedia.isPhotoPickerAvailable(activity) ||
            Intent(Intent.ACTION_GET_CONTENT)
                .setType("image/*")
                .addCategory(Intent.CATEGORY_OPENABLE)
                .resolveActivity(activity.packageManager) != null

    private fun hasPermission(permission: String): Boolean =
        activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    // currentLocationMetadata() verifies ACCESS_FINE/COARSE_LOCATION before this
    // is reached; the library declares no location permission (consumer's call).
    @SuppressLint("MissingPermission")
    private fun lastKnownLocation(manager: LocationManager, provider: String): Location? =
        try {
            if (manager.isProviderEnabled(provider)) manager.getLastKnownLocation(provider) else null
        } catch (_: SecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }

    /**
     * Bridges an `ActivityResultContract` into a suspend call via the activity's
     * [androidx.activity.result.ActivityResultRegistry]. Must run on the main
     * thread (registration is `@MainThread`). Registers under a unique key,
     * launches, resumes on the callback, and always unregisters.
     */
    private suspend fun <I, O> launchForResult(
        contract: ActivityResultContract<I, O>,
        input: I,
    ): O = suspendCancellableCoroutine { continuation ->
        val key = "smrt_evidence_${requestCounter.incrementAndGet()}"
        var launcher: ActivityResultLauncher<I>? = null
        launcher = activity.activityResultRegistry.register(key, contract) { result ->
            launcher?.unregister()
            if (continuation.isActive) continuation.resume(result)
        }
        continuation.invokeOnCancellation { launcher?.unregister() }
        try {
            launcher.launch(input)
        } catch (error: Throwable) {
            launcher.unregister()
            if (continuation.isActive) continuation.resumeWithException(error)
        }
    }

    private companion object {
        const val STORAGE_ROOT = "app_private"
    }
}

/**
 * A plain-data snapshot of an `android.location.Location` so the projection onto
 * [EvidenceLocationMetadata] is a pure, device-free function.
 */
internal data class LocationSnapshot(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val provider: String,
    val timeEpochMillis: Long,
)

internal fun Location.toSnapshot(): LocationSnapshot = LocationSnapshot(
    latitude = latitude,
    longitude = longitude,
    accuracyMeters = accuracy,
    provider = provider ?: "android",
    timeEpochMillis = time,
)

/** First non-blank context id (sorted by key for determinism), else `evidence`. */
internal fun evidenceCaptureSegment(request: EvidenceCaptureRequest): String =
    request.contextIds.toSortedMap().values
        .firstOrNull { it.isNotBlank() }
        ?.let(::sanitizeEvidenceSegment)
        ?: "evidence"

internal fun sanitizeEvidenceSegment(value: String): String =
    value.replace(Regex("[^A-Za-z0-9_-]"), "_").ifBlank { "evidence" }

internal fun evidenceAssetId(segment: String, epochMillis: Long): String =
    "asset_${segment}_$epochMillis"

internal fun evidenceExtensionForContentType(contentType: String): String =
    when (contentType.substringBefore(';').trim().lowercase()) {
        "image/png" -> "png"
        "image/webp" -> "webp"
        "image/heic", "image/heif" -> "heic"
        "image/gif" -> "gif"
        else -> "jpg"
    }

internal fun evidenceCameraStatus(hasCameraFeature: Boolean, granted: Boolean): String = when {
    !hasCameraFeature -> EvidencePermissionStatus.UNAVAILABLE
    granted -> EvidencePermissionStatus.GRANTED
    else -> EvidencePermissionStatus.DENIED
}

internal fun evidencePhotoLibraryStatus(pickerAvailable: Boolean): String =
    if (pickerAvailable) EvidencePermissionStatus.GRANTED else EvidencePermissionStatus.UNAVAILABLE

/** Pure projection of last-known location + permission onto the geo sidecar. */
internal fun evidenceLocationMetadata(
    permissionGranted: Boolean,
    providerAvailable: Boolean,
    snapshot: LocationSnapshot?,
): EvidenceLocationMetadata = when {
    !permissionGranted -> EvidenceLocationMetadata.unavailable(
        permissionStatus = EvidencePermissionStatus.DENIED,
        unavailableReason = "permission_denied",
    )

    !providerAvailable -> EvidenceLocationMetadata.unavailable(
        permissionStatus = EvidencePermissionStatus.UNAVAILABLE,
        unavailableReason = "provider_unavailable",
    )

    snapshot == null -> EvidenceLocationMetadata.unavailable(
        permissionStatus = EvidencePermissionStatus.GRANTED,
        unavailableReason = "last_location_unavailable",
    )

    else -> EvidenceLocationMetadata.available(
        latitude = snapshot.latitude.toString(),
        longitude = snapshot.longitude.toString(),
        accuracyMeters = snapshot.accuracyMeters.toString(),
        provider = snapshot.provider,
        capturedAt = Instant.fromEpochMilliseconds(snapshot.timeEpochMillis),
    )
}

/** Pure verifier: a written file → `stored_offline`; a missing one → `missing_local_file`. */
internal fun verifiedEvidenceAsset(
    base: EvidenceAssetRef,
    exists: Boolean,
    sizeBytes: Long,
    sha256: String,
    persistedAt: Instant,
): EvidenceAssetRef = if (exists && sizeBytes > 0L) {
    base.copy(
        sizeBytes = sizeBytes,
        sha256 = sha256,
        storageState = EvidenceAssetStorageState.STORED_OFFLINE,
        offlineSafe = true,
        persistedAt = persistedAt,
    )
} else {
    base.copy(
        sizeBytes = if (exists) sizeBytes else null,
        storageState = EvidenceAssetStorageState.MISSING_LOCAL_FILE,
        offlineSafe = false,
        persistedAt = null,
    )
}
