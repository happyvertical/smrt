package com.happyvertical.smrt.android.platform

import android.content.Context
import android.content.pm.PackageManager
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.happyvertical.smrt.mobile.platform.BarcodeFormat
import com.happyvertical.smrt.mobile.platform.BarcodeScan
import com.happyvertical.smrt.mobile.platform.BarcodeScanListener
import com.happyvertical.smrt.mobile.platform.BarcodeScanRequest
import com.happyvertical.smrt.mobile.platform.BarcodeScanner
import kotlinx.datetime.Clock

/**
 * ML Kit implementation of the shared [BarcodeScanner] seam, ported from
 * amaru's `AndroidBarcodeAnalyzer` (ADR 0001 Phase 5). Frames come from
 * CameraX: bind [analyzer] to an `ImageAnalysis` use case — the
 * `BarcodeScannerPreview` composable in `com.happyvertical.smrt.android.ui`
 * does that wiring. Frames analyzed while no session is active are dropped.
 *
 * Listener callbacks arrive on the main thread (ML Kit task listeners).
 * Requires `android.permission.CAMERA` at the camera-binding layer.
 */
class MlKitBarcodeScanner(private val context: Context) : BarcodeScanner {
    private class Session(
        val client: com.google.mlkit.vision.barcode.BarcodeScanner,
        val listener: BarcodeScanListener,
    )

    @Volatile
    private var session: Session? = null

    /** CameraX analyzer feeding the active scan session. */
    val analyzer: ImageAnalysis.Analyzer = ImageAnalysis.Analyzer(::analyze)

    override fun isAvailable(): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    override fun startScanning(request: BarcodeScanRequest, listener: BarcodeScanListener) {
        stopScanning()
        val formats = mlKitBarcodeFormats(request.formats)
        // A filter that matches nothing must not silently widen to
        // scan-everything — that is a caller bug.
        require(request.formats.isEmpty() || formats.isNotEmpty()) {
            "no supported barcode formats in request: ${request.formats}"
        }
        val client = if (formats.isEmpty()) {
            BarcodeScanning.getClient()
        } else {
            BarcodeScanning.getClient(
                BarcodeScannerOptions.Builder()
                    .setBarcodeFormats(formats.first(), *formats.drop(1).toIntArray())
                    .build(),
            )
        }
        session = Session(client, listener)
    }

    override fun stopScanning() {
        val previous = session
        session = null
        previous?.client?.close()
    }

    // ImageProxy.image is CameraX opt-in; ML Kit's InputImage.fromMediaImage
    // is the documented pairing for it (amaru seed did the same).
    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    private fun analyze(imageProxy: ImageProxy) {
        val active = session
        val mediaImage = imageProxy.image
        if (active == null || mediaImage == null) {
            imageProxy.close()
            return
        }

        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        active.client.process(image)
            .addOnSuccessListener { barcodes ->
                barcodes.firstNotNullOfOrNull { barcode ->
                    barcode.rawValue
                        ?.takeIf { rawValue -> rawValue.isNotBlank() }
                        ?.let { rawValue ->
                            BarcodeScan(
                                rawValue = rawValue,
                                format = barcodeFormatLabel(barcode.format),
                                scannedAt = Clock.System.now(),
                            )
                        }
                }?.let(active.listener::onBarcode)
            }
            .addOnFailureListener { active.listener.onError("mlkit_processing_failed") }
            .addOnCompleteListener { imageProxy.close() }
    }
}

/** ML Kit `Barcode.FORMAT_*` → shared [BarcodeFormat] label. */
internal fun barcodeFormatLabel(format: Int): String = when (format) {
    Barcode.FORMAT_AZTEC -> BarcodeFormat.AZTEC
    Barcode.FORMAT_CODABAR -> BarcodeFormat.CODABAR
    Barcode.FORMAT_CODE_39 -> BarcodeFormat.CODE_39
    Barcode.FORMAT_CODE_93 -> BarcodeFormat.CODE_93
    Barcode.FORMAT_CODE_128 -> BarcodeFormat.CODE_128
    Barcode.FORMAT_DATA_MATRIX -> BarcodeFormat.DATA_MATRIX
    Barcode.FORMAT_EAN_8 -> BarcodeFormat.EAN_8
    Barcode.FORMAT_EAN_13 -> BarcodeFormat.EAN_13
    Barcode.FORMAT_ITF -> BarcodeFormat.ITF
    Barcode.FORMAT_PDF417 -> BarcodeFormat.PDF417
    Barcode.FORMAT_QR_CODE -> BarcodeFormat.QR_CODE
    Barcode.FORMAT_UPC_A -> BarcodeFormat.UPC_A
    Barcode.FORMAT_UPC_E -> BarcodeFormat.UPC_E
    else -> BarcodeFormat.UNKNOWN
}

/** Shared [BarcodeFormat] labels → ML Kit ints; unknown labels are dropped. */
internal fun mlKitBarcodeFormats(labels: List<String>): List<Int> = labels.mapNotNull { label ->
    when (label) {
        BarcodeFormat.AZTEC -> Barcode.FORMAT_AZTEC
        BarcodeFormat.CODABAR -> Barcode.FORMAT_CODABAR
        BarcodeFormat.CODE_39 -> Barcode.FORMAT_CODE_39
        BarcodeFormat.CODE_93 -> Barcode.FORMAT_CODE_93
        BarcodeFormat.CODE_128 -> Barcode.FORMAT_CODE_128
        BarcodeFormat.DATA_MATRIX -> Barcode.FORMAT_DATA_MATRIX
        BarcodeFormat.EAN_8 -> Barcode.FORMAT_EAN_8
        BarcodeFormat.EAN_13 -> Barcode.FORMAT_EAN_13
        BarcodeFormat.ITF -> Barcode.FORMAT_ITF
        BarcodeFormat.PDF417 -> Barcode.FORMAT_PDF417
        BarcodeFormat.QR_CODE -> Barcode.FORMAT_QR_CODE
        BarcodeFormat.UPC_A -> Barcode.FORMAT_UPC_A
        BarcodeFormat.UPC_E -> Barcode.FORMAT_UPC_E
        else -> null
    }
}
