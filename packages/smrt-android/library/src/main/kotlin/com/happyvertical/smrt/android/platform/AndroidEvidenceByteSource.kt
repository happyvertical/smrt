package com.happyvertical.smrt.android.platform

import android.content.Context
import android.net.Uri
import com.happyvertical.smrt.mobile.evidence.EvidenceAssetRef
import com.happyvertical.smrt.mobile.evidence.EvidenceByteSource
import java.io.File
import java.net.URI
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Loads app-private evidence bytes when a durable multipart entry flushes. */
class AndroidEvidenceByteSource(
    context: Context,
    private val baseDirectory: File = context.filesDir,
) : EvidenceByteSource {
    private val contentResolver = context.applicationContext.contentResolver

    override suspend fun readBytes(asset: EvidenceAssetRef): ByteArray =
        withContext(Dispatchers.IO) {
            when (val scheme = runCatching { URI(asset.localUri).scheme?.lowercase() }.getOrNull()) {
                null -> resolveLocalFile(asset).readBytes()
                "file" -> File(URI(asset.localUri)).readBytes()
                "content", "android.resource" -> contentResolver
                    .openInputStream(Uri.parse(asset.localUri))
                    ?.buffered()
                    ?.use { it.readBytes() }
                    ?: error("Unable to open evidence URI ${asset.localUri}")
                else -> error("Unsupported evidence URI scheme: $scheme")
            }
        }

    private fun resolveLocalFile(asset: EvidenceAssetRef): File {
        if (asset.localUri.isNotBlank()) {
            val direct = File(asset.localUri)
            if (direct.isAbsolute) return direct
        }
        require(asset.relativePath.isNotBlank()) {
            "Evidence asset ${asset.assetId} has no readable local file location"
        }
        return baseDirectory.resolve(asset.relativePath)
    }
}
