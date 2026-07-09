package com.happyvertical.smrt.mobile.evidence

import com.happyvertical.smrt.mobile.network.MobileUploadPart
import com.happyvertical.smrt.mobile.network.QueueHttpRequest
import kotlinx.serialization.Serializable

/**
 * Platform seam for loading captured evidence bytes at queue-flush time.
 *
 * Implementations should use the platform's efficient whole-file read for
 * [EvidenceAssetRef.localUri] or [EvidenceAssetRef.relativePath]. This avoids
 * storing media bytes in the durable queue row while still letting
 * `HttpQueueSender` build multipart requests when connectivity returns.
 */
fun interface EvidenceByteSource {
    suspend fun readBytes(asset: EvidenceAssetRef): ByteArray
}

@Serializable
data class EvidenceMultipartAsset(
    val asset: EvidenceAssetRef,
    val fieldName: String = "file",
)

/**
 * Serializable queue payload for a durable evidence/media multipart upload.
 * Apps store this as a queue entry payload, then decode it in the sender mapper
 * and call [toQueueHttpRequest] with their platform byte source.
 */
@Serializable
data class EvidenceMultipartUpload(
    val path: String,
    val fields: Map<String, String> = emptyMap(),
    val assets: List<EvidenceMultipartAsset> = emptyList(),
) {
    suspend fun toQueueHttpRequest(byteSource: EvidenceByteSource): QueueHttpRequest.Multipart {
        val files = mutableListOf<MobileUploadPart>()
        for (part in assets) {
            files.add(
                part.asset.toMobileUploadPart(
                    fieldName = part.fieldName,
                    bytes = byteSource.readBytes(part.asset),
                )
            )
        }
        return QueueHttpRequest.Multipart(
            path = path,
            fields = fields,
            files = files,
        )
    }
}

fun EvidenceAssetRef.toMobileUploadPart(
    bytes: ByteArray,
    fieldName: String = "file",
): MobileUploadPart = MobileUploadPart(
    fileName = fileName,
    contentType = contentType,
    bytes = bytes,
    fieldName = fieldName,
)
