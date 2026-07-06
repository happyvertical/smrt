package com.happyvertical.smrt.mobile.packs

import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock

/**
 * A stored offline pack: framework identity/integrity columns plus the
 * app-defined domain manifest as its serialized [payload]. Apps decode the
 * payload into their own manifest type (amaru: `OfflineProjectPackManifest`).
 *
 * [storedAtEpochMs] round-trips: [OfflinePackStore.save] keeps an explicit
 * non-zero value (imports/restores) and stamps the store clock when left at
 * the `0` default. It is also the newest-first ordering key for
 * [OfflinePackStore.list] — a device wall-clock value; apps needing stronger
 * ordering guarantees should order on their own manifest fields.
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
    private val context: CoroutineContext = Dispatchers.Default,
) : OfflinePackStore {
    private val queries = database.packRecordQueries

    override suspend fun save(record: OfflinePackRecord): Unit = withContext(context) {
        queries.upsert(
            pack_id = record.packId,
            version = record.version.toLong(),
            manifest_hash = record.manifestHash,
            payload = record.payload,
            stored_at_epoch_ms = if (record.storedAtEpochMs != 0L) {
                record.storedAtEpochMs
            } else {
                clock.now().toEpochMilliseconds()
            },
        )
    }

    override suspend fun get(packId: String): OfflinePackRecord? = withContext(context) {
        queries.selectById(packId, ::toOfflinePackRecord).executeAsOneOrNull()
    }

    override suspend fun list(): List<OfflinePackRecord> = withContext(context) {
        queries.selectAll(::toOfflinePackRecord).executeAsList()
    }

    override suspend fun delete(packId: String): Unit = withContext(context) {
        queries.deleteById(packId)
    }
}

private fun toOfflinePackRecord(
    packId: String,
    version: Long,
    manifestHash: String,
    payload: String,
    storedAtEpochMs: Long,
): OfflinePackRecord = OfflinePackRecord(
    packId = packId,
    version = version.toInt(),
    manifestHash = manifestHash,
    payload = payload,
    storedAtEpochMs = storedAtEpochMs,
)
