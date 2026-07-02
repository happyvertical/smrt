package com.happyvertical.smrt.mobile.packs

import com.happyvertical.smrt.mobile.db.Pack_record
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlinx.datetime.Clock

/**
 * A stored offline pack: framework identity/integrity columns plus the
 * app-defined domain manifest as its serialized [payload]. Apps decode the
 * payload into their own manifest type (amaru: `OfflineProjectPackManifest`).
 */
data class OfflinePackRecord(
    val packId: String,
    val version: Int = 1,
    val manifestHash: String = "",
    val payload: String,
    val storedAtEpochMs: Long = 0,
)

/**
 * Durable offline pack store (ADR 0001 Phase 2) — replaces amaru's
 * in-memory `OfflinePackStore`, keeping its save/get/list seam.
 */
interface OfflinePackStore {
    suspend fun save(record: OfflinePackRecord)

    suspend fun get(packId: String): OfflinePackRecord?

    suspend fun list(): List<OfflinePackRecord>

    suspend fun delete(packId: String)
}

class DurableOfflinePackStore(
    database: SmrtMobileDatabase,
    private val clock: Clock = Clock.System,
) : OfflinePackStore {
    private val queries = database.packRecordQueries

    override suspend fun save(record: OfflinePackRecord) {
        queries.upsert(
            pack_id = record.packId,
            version = record.version.toLong(),
            manifest_hash = record.manifestHash,
            payload = record.payload,
            stored_at_epoch_ms = clock.now().toEpochMilliseconds(),
        )
    }

    override suspend fun get(packId: String): OfflinePackRecord? =
        queries.selectById(packId).executeAsOneOrNull()?.toDomain()

    override suspend fun list(): List<OfflinePackRecord> =
        queries.selectAll().executeAsList().map { it.toDomain() }

    override suspend fun delete(packId: String) {
        queries.deleteById(packId)
    }
}

private fun Pack_record.toDomain(): OfflinePackRecord = OfflinePackRecord(
    packId = pack_id,
    version = version.toInt(),
    manifestHash = manifest_hash,
    payload = payload,
    storedAtEpochMs = stored_at_epoch_ms,
)
