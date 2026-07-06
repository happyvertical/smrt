package com.happyvertical.smrt.mobile.network

import com.happyvertical.smrt.mobile.auth.AuthUnauthorizedException
import com.happyvertical.smrt.mobile.sync.QueueEntry
import com.happyvertical.smrt.mobile.sync.QueueSender
import com.happyvertical.smrt.mobile.sync.SendOutcome
import kotlinx.coroutines.CancellationException

/**
 * How a queue entry becomes an HTTP request. Routing is app policy (the
 * queue payload/kind are app-defined); the outcome mapping below is the
 * framework's.
 */
sealed interface QueueHttpRequest {
    /** POST the entry's JSON payload to [path]. */
    data class JsonPost(val path: String) : QueueHttpRequest

    /** POST a multipart submission (evidence/media upload) to [path]. */
    data class Multipart(
        val path: String,
        val fields: Map<String, String>,
        val files: List<MobileUploadPart>,
    ) : QueueHttpRequest
}

/**
 * The queue's transport for the HAND-WRITTEN `/api/mobile` endpoints
 * (single-item semantics — anytown reference; issue #1748), wired through
 * [MobileApiClient] (ADR 0001 Phase 4). Outcome mapping carries the
 * reporter semantics the queue expects:
 *
 * - 2xx → [SendOutcome.Success] (entry removed)
 * - 401 → [SendOutcome.Unauthorized] (flush aborts; queue intact; the
 *   client has already fired its 401 hook)
 * - 408/429 → [SendOutcome.Retryable] (transient by definition)
 * - other 4xx → [SendOutcome.Rejected] (permanent; entry removed)
 * - 5xx / transport failure → [SendOutcome.Retryable] (until the cap)
 *
 * The entry id travels as the `Idempotency-Key`; the `/api/mobile`
 * handlers dedupe re-sent POSTs on it.
 *
 * Framework-MODEL writes are a different contract: core's `sync/apply`
 * batch endpoint (docs/content/architecture/sync-apply-contract.md, which
 * names this queue as a consumer) returns per-item statuses inside
 * HTTP 200, treats any non-2xx batch response as retryable, and dedupes by
 * construction (no header). A batch-shaped sync/apply sender is planned as
 * a follow-up — do not point this single-item sender at `sync/apply`.
 */
class HttpQueueSender(
    private val client: MobileApiClient,
    private val requestForEntry: (QueueEntry) -> QueueHttpRequest,
) : QueueSender {
    override suspend fun send(entry: QueueEntry): SendOutcome {
        val response = try {
            when (val plan = requestForEntry(entry)) {
                is QueueHttpRequest.JsonPost -> client.postJson(
                    path = plan.path,
                    body = entry.payload,
                    idempotencyKey = entry.id,
                )
                is QueueHttpRequest.Multipart -> client.submitMultipart(
                    path = plan.path,
                    fields = plan.fields,
                    files = plan.files,
                    idempotencyKey = entry.id,
                )
            }
        } catch (unauthorized: AuthUnauthorizedException) {
            return SendOutcome.Unauthorized
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: Exception) {
            return SendOutcome.Retryable(failure.message ?: "network failure")
        }

        return when {
            response.isSuccess -> SendOutcome.Success
            // Request-timeout and rate-limit are transient, not verdicts.
            response.status == 408 || response.status == 429 ->
                SendOutcome.Retryable("http ${response.status}")
            response.status in 400..499 -> SendOutcome.Rejected("http ${response.status}")
            else -> SendOutcome.Retryable("http ${response.status}")
        }
    }
}
