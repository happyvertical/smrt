package com.happyvertical.smrt.android.ui

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.happyvertical.smrt.android.platform.MlKitBarcodeScanner
import java.util.concurrent.Executors

/**
 * Live camera preview feeding a [MlKitBarcodeScanner], ported from amaru's
 * `BarcodeCameraPreview` (ADR 0001 Phase 5). The caller owns the scan
 * session (`startScanning`/`stopScanning`); this composable owns the
 * CameraX binding: back camera, latency-optimized [ImageCapture] (handed
 * out through [onImageCaptureReady] for photo capture flows), and a
 * KEEP_ONLY_LATEST analysis stream on a single-thread executor.
 *
 * The host app must hold `android.permission.CAMERA` before composing this.
 */
@Composable
fun BarcodeScannerPreview(
    scanner: MlKitBarcodeScanner,
    modifier: Modifier = Modifier,
    onImageCaptureReady: (ImageCapture?) -> Unit = {},
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnImageCaptureReady by rememberUpdatedState(onImageCaptureReady)
    val previewView = remember {
        PreviewView(context).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    Box(modifier = modifier) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxSize(),
        )
    }

    DisposableEffect(context, lifecycleOwner, previewView, scanner) {
        // Set on the main thread in onDispose and read on the main thread in
        // the listener below: a provider future resolving after departure
        // must not bind the camera (nothing would ever unbind it) or touch
        // the shut-down analyzer executor.
        var disposed = false
        val executor = Executors.newSingleThreadExecutor()
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        cameraProviderFuture.addListener(
            {
                if (disposed) {
                    return@addListener
                }
                // runCatching covers the future itself too — provider init
                // can fail (no camera service) and this runs on main.
                runCatching {
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder()
                        .build()
                        .also { cameraPreview ->
                            cameraPreview.setSurfaceProvider(previewView.surfaceProvider)
                        }
                    val imageCapture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .build()
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { imageAnalysis ->
                            imageAnalysis.setAnalyzer(executor, scanner.analyzer)
                        }
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageCapture,
                        analysis,
                    )
                    currentOnImageCaptureReady(imageCapture)
                }.onFailure {
                    currentOnImageCaptureReady(null)
                }
            },
            mainExecutor,
        )

        onDispose {
            disposed = true
            currentOnImageCaptureReady(null)
            runCatching {
                if (cameraProviderFuture.isDone) {
                    cameraProviderFuture.get().unbindAll()
                }
            }
            executor.shutdown()
        }
    }
}
