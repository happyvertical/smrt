package com.happyvertical.smrt.mobile.sync

import com.happyvertical.smrt.mobile.db.Queue_entry
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.datetime.Clock

/**
 * Durable, crash-safe offline write-queue (ADR 0001 Phase 2). Semantics are
 * the anytown reporter's hardened queue, productionized onto SQLDelight:
 *
 * - `pending → uploading → (row deleted on success) / failed` — a synced
 *   entry never lingers; `failed` is terminal and excluded from auto-flush.
 * - **Single-flight coalesced flush**: overlapping triggers (foreground,
 *   connectivity regained, manual retry) collapse into one run.
 * - **Attempt cap** (default 5): a retryable failure past the cap parks the
 *   entry as `failed` for visibility + manual discard.
 * - **Crash recovery**: any `uploading` row found at construction is reset to
 *   `pending` — an interrupted POST re-sends rather than being lost.
 * - **Idempotency**: the entry id is the idempotency key; servers dedupe on
 *   it (`clientCaptureId` / `Idempotency-Key`), so a re-sent POST is safe.
 *
 * Flush *triggers* are platform concerns — foreground/connectivity callbacks
 * simply call [flush]. Transport is a [QueueSender] seam until the shared
 * Ktor client lands (Phase 4).
 */
object QueueEntryState {
    const val PENDING = "pending"
    const val UPLOADING = "uploading"
    const val FAILED = "failed"
}

data class QueueEntry(
    val id: String,
    val kind: String,
    val tenantId: String,
    val payload: String,
    val state: String,
    val attemptCount: Int,
    val lastError: String,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
)

/**
 * A new durable entry. [id] is the idempotency key (callers supply a UUID);
 * [kind] discriminates app payload types; [payload] is opaque serialized
 * JSON owned by the app.
 */
data class NewQueueEntry(
    val id: String,
    val kind: String,
    val payload: String,
    val tenantId: String = "",
)

sealed interface SendOutcome {
    /** 2xx — the entry is removed. */
    data object Success : SendOutcome

    /** Non-401 4xx — permanently rejected by the server; the entry is removed. */
    data class Rejected(val reason: String = "") : SendOutcome

    /** 5xx / network failure — retried on later flushes until the attempt cap. */
    data class Retryable(val reason: String = "") : SendOutcome

    /** 401 — the flush aborts; entries stay queued for after re-auth. */
    data object Unauthorized : SendOutcome
}

fun interface QueueSender {
    suspend fun send(entry: QueueEntry): SendOutcome
}

data class FlushSummary(
    val sent: Int = 0,
    val rejected: Int = 0,
    val retried: Int = 0,
    val failedTerminally: Int = 0,
    val unauthorized: Boolean = false,
    val alreadyRunning: Boolean = false,
)

data class QueueStats(
    val pending: Long,
    val uploading: Long,
    val failed: Long,
)

class DurableWriteQueue(
    database: SmrtMobileDatabase,
    private val clock: Clock = Clock.System,
    private val maxAttempts: Int = DEFAULT_MAX_ATTEMPTS,
) {
    private val queries = database.queueEntryQueries
    private val flushLock = Mutex()

    init {
        queries.recoverInterrupted(nowMs())
    }

    /** Durably enqueues; re-enqueueing an existing id replaces the entry. */
    fun enqueue(entry: NewQueueEntry): QueueEntry {
        val now = nowMs()
        queries.insertOrReplace(
            id = entry.id,
            kind = entry.kind,
            tenant_id = entry.tenantId,
            payload = entry.payload,
            state = QueueEntryState.PENDING,
            attempt_count = 0,
            last_error = "",
            created_at_epoch_ms = now,
            updated_at_epoch_ms = now,
        )
        return requireNotNull(get(entry.id))
    }

    fun get(id: String): QueueEntry? =
        queries.selectById(id).executeAsOneOrNull()?.toDomain()

    fun pending(): List<QueueEntry> = byState(QueueEntryState.PENDING)

    fun failed(): List<QueueEntry> = byState(QueueEntryState.FAILED)

    fun all(): List<QueueEntry> =
        queries.selectAll().executeAsList().map { it.toDomain() }

    fun stats(): QueueStats = QueueStats(
        pending = queries.countByState(QueueEntryState.PENDING).executeAsOne(),
        uploading = queries.countByState(QueueEntryState.UPLOADING).executeAsOne(),
        failed = queries.countByState(QueueEntryState.FAILED).executeAsOne(),
    )

    /** Removes terminally-failed entries; returns how many were discarded. */
    fun discardFailed(): Long {
        val count = queries.countByState(QueueEntryState.FAILED).executeAsOne()
        queries.deleteByState(QueueEntryState.FAILED)
        return count
    }

    fun delete(id: String) {
        queries.deleteById(id)
    }

    /**
     * Sends every pending entry through [sender], oldest first. Coalesced:
     * a flush that overlaps a running one returns `alreadyRunning` without
     * touching the queue.
     */
    suspend fun flush(sender: QueueSender): FlushSummary {
        if (!flushLock.tryLock()) return FlushSummary(alreadyRunning = true)
        try {
            var sent = 0
            var rejected = 0
            var retried = 0
            var failedTerminally = 0
            for (entry in pending()) {
                queries.markUploading(nowMs(), entry.id)
                val attempt = entry.attemptCount + 1
                val outcome = try {
                    sender.send(
                        entry.copy(state = QueueEntryState.UPLOADING, attemptCount = attempt),
                    )
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (failure: Throwable) {
                    SendOutcome.Retryable(failure.message ?: "send failed")
                }
                when (outcome) {
                    is SendOutcome.Success -> {
                        queries.deleteById(entry.id)
                        sent++
                    }
                    is SendOutcome.Rejected -> {
                        queries.deleteById(entry.id)
                        rejected++
                    }
                    is SendOutcome.Retryable -> {
                        if (attempt >= maxAttempts) {
                            queries.setState(QueueEntryState.FAILED, outcome.reason, nowMs(), entry.id)
                            failedTerminally++
                        } else {
                            queries.setState(QueueEntryState.PENDING, outcome.reason, nowMs(), entry.id)
                            retried++
                        }
                    }
                    is SendOutcome.Unauthorized -> {
                        queries.setState(QueueEntryState.PENDING, "unauthorized", nowMs(), entry.id)
                        return FlushSummary(
                            sent = sent,
                            rejected = rejected,
                            retried = retried,
                            failedTerminally = failedTerminally,
                            unauthorized = true,
                        )
                    }
                }
            }
            return FlushSummary(
                sent = sent,
                rejected = rejected,
                retried = retried,
                failedTerminally = failedTerminally,
            )
        } finally {
            flushLock.unlock()
        }
    }

    private fun byState(state: String): List<QueueEntry> =
        queries.selectByState(state).executeAsList().map { it.toDomain() }

    private fun nowMs(): Long = clock.now().toEpochMilliseconds()

    companion object {
        const val DEFAULT_MAX_ATTEMPTS = 5
    }
}

private fun Queue_entry.toDomain(): QueueEntry = QueueEntry(
    id = id,
    kind = kind,
    tenantId = tenant_id,
    payload = payload,
    state = state,
    attemptCount = attempt_count.toInt(),
    lastError = last_error,
    createdAtEpochMs = created_at_epoch_ms,
    updatedAtEpochMs = updated_at_epoch_ms,
)
