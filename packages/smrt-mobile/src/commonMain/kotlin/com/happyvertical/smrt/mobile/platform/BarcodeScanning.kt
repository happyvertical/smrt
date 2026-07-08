package com.happyvertical.smrt.mobile.platform

import kotlinx.datetime.Instant
import kotlinx.serialization.Serializable

/**
 * Shared barcode-scanning seam (ADR 0001 Correction 4: the seed apps had
 * Android impls with no shared contract — this interface is net-new).
 * Concrete implementations live in the platform libraries: ML Kit + CameraX
 * in smrt-android (Phase 5); iOS barcode is net-new in Phase 6.
 *
 * The scanning *surface* (camera preview) is inherently platform UI; this
 * seam covers the session contract (start/stop + decoded emissions) so
 * shared logic can consume scans without touching camera APIs.
 */

/** One decoded barcode, platform-neutral. */
@Serializable
data class BarcodeScan(
    val rawValue: String,
    val format: String = BarcodeFormat.UNKNOWN,
    val scannedAt: Instant? = null,
)

/** Barcode format labels (amaru's ML Kit label set, kept platform-neutral). */
object BarcodeFormat {
    const val AZTEC = "aztec"
    const val CODABAR = "codabar"
    const val CODE_39 = "code_39"
    const val CODE_93 = "code_93"
    const val CODE_128 = "code_128"
    const val DATA_MATRIX = "data_matrix"
    const val EAN_8 = "ean_8"
    const val EAN_13 = "ean_13"
    const val ITF = "itf"
    const val PDF417 = "pdf417"
    const val QR_CODE = "qr_code"
    const val UPC_A = "upc_a"
    const val UPC_E = "upc_e"
    const val UNKNOWN = "unknown"
}

/**
 * A scan session request. [formats] restricts decoding to the listed
 * [BarcodeFormat] labels; empty means all formats the platform supports.
 */
@Serializable
data class BarcodeScanRequest(
    val formats: List<String> = emptyList(),
)

/** Receives decoded barcodes and session errors. */
interface BarcodeScanListener {
    fun onBarcode(scan: BarcodeScan)

    fun onError(code: String) {}
}

/** Platform seam: a barcode scanning session over the device camera. */
interface BarcodeScanner {
    fun isAvailable(): Boolean

    fun startScanning(
        request: BarcodeScanRequest = BarcodeScanRequest(),
        listener: BarcodeScanListener,
    )

    fun stopScanning()
}
