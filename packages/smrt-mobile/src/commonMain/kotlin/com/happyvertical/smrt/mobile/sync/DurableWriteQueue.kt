package com.happyvertical.smrt.mobile.sync

import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlin.concurrent.Volatile
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock

/**
 * Durable, crash-safe offline write-queue (ADR 0001 Phase 2). Semantics are
 * the anytown reporter's hardened queue, productionized onto SQLDelight —
 * the full contract lives here (AGENTS/README summarize):
 *
 * - `pending → uploading → (row deleted on success) / failed` — a synced
 *   entry never lingers (reporter parity); `failed` is terminal, excluded
 *   from auto-flush, discardable via [discardFailed]. Apps that need a
 *   record of synced writes (e.g. undo-after-sync) capture server ids inside
 *   their [QueueSender].
 * - **Single-flight, trigger-preserving flush**: overlapping triggers
 *   coalesce into the running flush — the overlapped call returns
 *   `alreadyRunning` after latching a rerun, and the running flush loops
 *   until no rerun is requested, so a trigger is never silently dropped.
 *   Rerun passes skip entries already retried in this call: a failed send
 *   waits for the next real trigger instead of hot-looping its attempt
 *   budget away during an outage.
 * - **Attempt cap** (default 5): the claim step charges one attempt before
 *   each send; a retryable failure at the cap parks the entry as `failed`.
 *   A 401 abort refunds the charged attempt — an auth outage must not spend
 *   an entry's retry budget.
 * - **Crash/cancel recovery**: interrupted `uploading` rows reset to
 *   `pending` at the start of every flush pass, and a cancelled in-flight
 *   send resets its own row immediately. Call [recoverInterrupted] eagerly
 *   at app start when recovered rows must show as pending before the first
 *   flush.
 * - **Guarded transitions**: every post-send write applies only while the
 *   row is still the claimed in-flight version, so re-enqueueing an id
 *   (replace semantics) during its send never loses the replacement.
 * - **Idempotency**: the entry id is the idempotency key; servers dedupe on
 *   it (`clientCaptureId` / `Idempotency-Key`), so a re-sent POST is safe.
 * - Queue order is insertion order.
 *
 * One `DurableWriteQueue` instance must own a given database's queue table —
 * flush-start recovery would reset another instance's in-flight rows.
 * Database work runs on [context] (default [Dispatchers.Default]) so every
 * call is safe from main/UI dispatchers. Flush *triggers* are platform
 * concerns — foreground/connectivity callbacks simply call [flush];
 * transport is a [QueueSender] seam until the shared Ktor client (Phase 4).
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

    /**
     * Non-401 4xx — permanently rejected by the server; the entry is removed
     * and [reason] is surfaced in [FlushSummary.rejectedReasons].
     */
    data class Rejected(val reason: String = "") : SendOutcome

    /** 5xx / network failure — retried on later flushes until the attempt cap. */
    data class Retryable(val reason: String = "") : SendOutcome

    /** 401 — the flush aborts; entries stay queued (budget refunded) for after re-auth. */
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
    val rejectedReasons: List<String> = emptyList(),
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
    private val context: CoroutineContext = Dispatchers.Default,
) {
    private val queries = database.queueEntryQueries
    private val flushLock = Mutex()

    init {
        require(maxAttempts >= 1) { "maxAttempts must be >= 1 (was $maxAttempts)" }
    }

    @Volatile
    private var rerunRequested = false

    /** Durably enqueues; re-enqueueing an existing id replaces the entry. */
    suspend fun enqueue(entry: NewQueueEntry): QueueEntry = withContext(context) {
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
        QueueEntry(
            id = entry.id,
            kind = entry.kind,
            tenantId = entry.tenantId,
            payload = entry.payload,
            state = QueueEntryState.PENDING,
            attemptCount = 0,
            lastError = "",
            createdAtEpochMs = now,
            updatedAtEpochMs = now,
        )
    }

    suspend fun get(id: String): QueueEntry? = withContext(context) {
        queries.selectById(id, ::toQueueEntry).executeAsOneOrNull()
    }

    suspend fun pending(): List<QueueEntry> = byState(QueueEntryState.PENDING)

    suspend fun failed(): List<QueueEntry> = byState(QueueEntryState.FAILED)

    suspend fun all(): List<QueueEntry> = withContext(context) {
        queries.selectAll(::toQueueEntry).executeAsList()
    }

    suspend fun stats(): QueueStats = withContext(context) {
        val counts = queries.countsByState().executeAsList()
            .associate { row -> row.state to row.n }
        QueueStats(
            pending = counts[QueueEntryState.PENDING] ?: 0,
            uploading = counts[QueueEntryState.UPLOADING] ?: 0,
            failed = counts[QueueEntryState.FAILED] ?: 0,
        )
    }

    /** Removes terminally-failed entries; returns how many were discarded. */
    suspend fun discardFailed(): Long = withContext(context) {
        queries.transactionWithResult {
            val failedCount = queries.countsByState().executeAsList()
                .firstOrNull { row -> row.state == QueueEntryState.FAILED }
                ?.n ?: 0L
            queries.deleteByState(QueueEntryState.FAILED)
            failedCount
        }
    }

    /**
     * Resets interrupted `uploading` rows to `pending`. Runs automatically at
     * the start of every flush pass; call eagerly at app start when recovered
     * rows must show as pending before the first flush. Serialized with
     * [flush], so it can never reset a row this instance has in flight.
     */
    suspend fun recoverInterrupted() {
        flushLock.withLock { sweepInterrupted() }
    }

    private suspend fun sweepInterrupted(): Unit = withContext(context) {
        queries.recoverInterrupted(
            pending = QueueEntryState.PENDING,
            now = nowMs(),
            uploading = QueueEntryState.UPLOADING,
        )
    }

    /**
     * Sends every pending entry through [sender], oldest first, looping while
     * overlapped triggers latch a rerun. An overlapping call returns
     * `alreadyRunning` after latching.
     */
    suspend fun flush(sender: QueueSender): FlushSummary {
        if (!flushLock.tryLock()) {
            rerunRequested = true
            return FlushSummary(alreadyRunning = true)
        }
        var sent = 0
        var rejected = 0
        var retried = 0
        var failedTerminally = 0
        var unauthorizedAbort = false
        val rejectedReasons = mutableListOf<String>()
        // Entries already retried in THIS call: rerun passes skip them so a
        // latched trigger drains new work without hot-looping failed sends.
        val deferredIds = mutableSetOf<String>()

        fun summary() = FlushSummary(
            sent = sent,
            rejected = rejected,
            retried = retried,
            failedTerminally = failedTerminally,
            unauthorized = unauthorizedAbort,
            rejectedReasons = rejectedReasons.toList(),
        )

        while (true) {
            try {
                passes@ do {
                    rerunRequested = false
                    sweepInterrupted()
                    for (entry in pending()) {
                        if (entry.id in deferredIds) continue
                        // Claim (guarded): charges the attempt. Re-read so the
                        // cap check and the sender both see the claimed row.
                        withContext(context) {
                            queries.markUploading(
                                uploading = QueueEntryState.UPLOADING,
                                now = nowMs(),
                                id = entry.id,
                                pending = QueueEntryState.PENDING,
                            )
                        }
                        val claimed = get(entry.id)
                        if (claimed == null || claimed.state != QueueEntryState.UPLOADING) {
                            // Replaced or removed after the snapshot — not ours.
                            continue
                        }

                        val outcome = try {
                            sender.send(claimed)
                        } catch (cancellation: CancellationException) {
                            // Cancelled mid-send: put the row back for the
                            // next flush. The charged attempt stays spent —
                            // the send may have reached the server.
                            // NonCancellable rides on the db context so the
                            // write stays off the caller's dispatcher.
                            withContext(context + NonCancellable) {
                                queries.setStateIfUploading(
                                    state = QueueEntryState.PENDING,
                                    lastError = "cancelled",
                                    now = nowMs(),
                                    id = claimed.id,
                                    uploading = QueueEntryState.UPLOADING,
                                )
                            }
                            throw cancellation
                        } catch (failure: Exception) {
                            SendOutcome.Retryable(failure.message ?: "send failed")
                        }

                        when (outcome) {
                            is SendOutcome.Success -> {
                                withContext(context) {
                                    queries.deleteIfUploading(
                                        id = claimed.id,
                                        uploading = QueueEntryState.UPLOADING,
                                    )
                                }
                                sent++
                            }
                            is SendOutcome.Rejected -> {
                                withContext(context) {
                                    queries.deleteIfUploading(
                                        id = claimed.id,
                                        uploading = QueueEntryState.UPLOADING,
                                    )
                                }
                                rejected++
                                if (outcome.reason.isNotBlank()) {
                                    rejectedReasons.add(outcome.reason)
                                }
                            }
                            is SendOutcome.Retryable -> {
                                val terminal = claimed.attemptCount >= maxAttempts
                                val applied = withContext(context) {
                                    queries.setStateIfUploading(
                                        state = if (terminal) {
                                            QueueEntryState.FAILED
                                        } else {
                                            QueueEntryState.PENDING
                                        },
                                        lastError = outcome.reason,
                                        now = nowMs(),
                                        id = claimed.id,
                                        uploading = QueueEntryState.UPLOADING,
                                    ).value > 0
                                }
                                if (applied) {
                                    if (terminal) {
                                        failedTerminally++
                                    } else {
                                        retried++
                                        deferredIds.add(claimed.id)
                                    }
                                }
                            }
                            is SendOutcome.Unauthorized -> {
                                withContext(context) {
                                    queries.restoreAfterUnauthorized(
                                        pending = QueueEntryState.PENDING,
                                        lastError = "unauthorized",
                                        now = nowMs(),
                                        id = claimed.id,
                                        uploading = QueueEntryState.UPLOADING,
                                    )
                                }
                                // A latched rerun is deliberately dropped on
                                // 401 — it would 401 too. Re-auth flows
                                // trigger a fresh flush; the stale latch is
                                // cleared at that flush's first pass.
                                unauthorizedAbort = true
                                break@passes
                            }
                        }
                    }
                } while (rerunRequested)
            } catch (failure: Throwable) {
                flushLock.unlock()
                throw failure
            }

            // The latch can be set between the do-while check and this
            // unlock; re-acquire and loop so that trigger is not dropped.
            flushLock.unlock()
            if (unauthorizedAbort || !rerunRequested || !flushLock.tryLock()) {
                return summary()
            }
        }
    }

    private suspend fun byState(state: String): List<QueueEntry> = withContext(context) {
        queries.selectByState(state, ::toQueueEntry).executeAsList()
    }

    private fun nowMs(): Long = clock.now().toEpochMilliseconds()

    companion object {
        const val DEFAULT_MAX_ATTEMPTS = 5
    }
}

private fun toQueueEntry(
    id: String,
    kind: String,
    tenantId: String,
    payload: String,
    state: String,
    attemptCount: Long,
    lastError: String,
    createdAtEpochMs: Long,
    updatedAtEpochMs: Long,
): QueueEntry = QueueEntry(
    id = id,
    kind = kind,
    tenantId = tenantId,
    payload = payload,
    state = state,
    attemptCount = attemptCount.toInt(),
    lastError = lastError,
    createdAtEpochMs = createdAtEpochMs,
    updatedAtEpochMs = updatedAtEpochMs,
)
