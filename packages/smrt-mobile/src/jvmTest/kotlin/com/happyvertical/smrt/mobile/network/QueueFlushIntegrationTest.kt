package com.happyvertical.smrt.mobile.network

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import com.happyvertical.smrt.mobile.evidence.EvidenceAssetRef
import com.happyvertical.smrt.mobile.evidence.EvidenceByteSource
import com.happyvertical.smrt.mobile.evidence.EvidenceMultipartAsset
import com.happyvertical.smrt.mobile.evidence.EvidenceMultipartUpload
import com.happyvertical.smrt.mobile.sync.DurableWriteQueue
import com.happyvertical.smrt.mobile.sync.NewQueueEntry
import com.happyvertical.smrt.mobile.sync.QueueEntryState
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Phase 4 acceptance: the durable queue flushes end-to-end through the
 * shared Ktor client — bearer on every request, idempotency keys attached,
 * and the reporter outcome semantics driving queue state.
 */
class QueueFlushIntegrationTest {
    private fun newQueue(): DurableWriteQueue {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        SmrtMobileDatabase.Schema.create(driver)
        return DurableWriteQueue(SmrtMobileDatabase(driver))
    }

    private fun sender(
        engine: MockEngine,
        byteSource: EvidenceByteSource = EvidenceByteSource { "img".encodeToByteArray() },
    ): HttpQueueSender {
        val client = MobileApiClient(
            engine = engine,
            config = MobileApiConfig(baseUrl = "https://app.example.com"),
            tokenProvider = { "bearer-1" },
        )
        return HttpQueueSender(client) { entry ->
            if (entry.kind == "evidence") {
                Json.decodeFromString<EvidenceMultipartUpload>(entry.payload)
                    .toQueueHttpRequest(byteSource)
            } else {
                QueueHttpRequest.JsonPost("plays")
            }
        }
    }

    @Test
    fun queueDrainsThroughTheHttpClient() = runBlocking {
        val engine = MockEngine {
            respond("""{"id":"c1"}""", HttpStatusCode.Created, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val queue = newQueue()
        val asset = EvidenceAssetRef(
            assetId = "asset-1",
            localUri = "file:///data/evidence/asset.jpg",
            fileName = "asset.jpg",
            contentType = "image/jpeg",
        )
        val evidencePayload = Json.encodeToString(
            EvidenceMultipartUpload(
                path = "contributions",
                fields = mapOf("eventId" to "event-1"),
                assets = listOf(EvidenceMultipartAsset(asset)),
            ),
        )
        var loadedAssetId: String? = null
        queue.enqueue(NewQueueEntry(id = "e1", kind = "play", payload = """{"statKey":"goal"}"""))
        queue.enqueue(NewQueueEntry(id = "e2", kind = "evidence", payload = evidencePayload))

        val summary = queue.flush(
            sender(
                engine,
                EvidenceByteSource { requested ->
                    loadedAssetId = requested.assetId
                    "bytes-loaded-at-flush".encodeToByteArray()
                },
            ),
        )

        assertEquals(2, summary.sent)
        assertTrue(queue.all().isEmpty())
        assertEquals(2, engine.requestHistory.size)
        assertTrue(engine.requestHistory.all { it.headers[HttpHeaders.Authorization] == "Bearer bearer-1" })
        assertEquals(listOf("e1", "e2"), engine.requestHistory.map { it.headers["Idempotency-Key"] })
        assertTrue(
            engine.requestHistory[1].body.contentType.toString().startsWith("multipart/form-data"),
        )
        assertEquals("asset-1", loadedAssetId)
        val multipartBody = engine.requestHistory[1].body.toByteArray().decodeToString()
        assertTrue(multipartBody.contains("filename=\"asset.jpg\""))
        assertTrue(multipartBody.contains("bytes-loaded-at-flush"))
    }

    @Test
    fun serverOutageLeavesEntriesPendingForNextTrigger() = runBlocking {
        val engine = MockEngine { respond("down", HttpStatusCode.ServiceUnavailable) }
        val queue = newQueue()
        queue.enqueue(NewQueueEntry(id = "e1", kind = "play", payload = "{}"))

        val summary = queue.flush(sender(engine))

        assertEquals(1, summary.retried)
        val entry = queue.pending().single()
        assertEquals(1, entry.attemptCount)
        assertEquals("http 503", entry.lastError)
    }

    @Test
    fun expiredBearerAbortsFlushAndKeepsQueueIntact() = runBlocking {
        val engine = MockEngine { respond("denied", HttpStatusCode.Unauthorized) }
        val queue = newQueue()
        queue.enqueue(NewQueueEntry(id = "e1", kind = "play", payload = "{}"))
        queue.enqueue(NewQueueEntry(id = "e2", kind = "play", payload = "{}"))

        val summary = queue.flush(sender(engine))

        assertTrue(summary.unauthorized)
        assertEquals(2, queue.all().size)
        assertTrue(queue.all().all { it.state == QueueEntryState.PENDING })
        // Only the first entry hit the wire before the abort.
        assertEquals(1, engine.requestHistory.size)
    }
}
