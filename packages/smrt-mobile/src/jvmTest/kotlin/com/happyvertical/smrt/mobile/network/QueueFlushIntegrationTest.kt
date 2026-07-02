package com.happyvertical.smrt.mobile.network

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import com.happyvertical.smrt.mobile.sync.DurableWriteQueue
import com.happyvertical.smrt.mobile.sync.NewQueueEntry
import com.happyvertical.smrt.mobile.sync.QueueEntryState
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
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

    private fun sender(engine: MockEngine): HttpQueueSender {
        val client = MobileApiClient(
            engine = engine,
            config = MobileApiConfig(baseUrl = "https://app.example.com"),
            tokenProvider = { "bearer-1" },
        )
        return HttpQueueSender(client) { entry ->
            if (entry.kind == "evidence") {
                QueueHttpRequest.Multipart(
                    path = "contributions",
                    fields = mapOf("eventId" to "event-1"),
                    files = listOf(
                        MobileUploadPart(
                            fileName = "asset.jpg",
                            contentType = "image/jpeg",
                            bytes = "img".encodeToByteArray(),
                        ),
                    ),
                )
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
        queue.enqueue(NewQueueEntry(id = "e1", kind = "play", payload = """{"statKey":"goal"}"""))
        queue.enqueue(NewQueueEntry(id = "e2", kind = "evidence", payload = """{"eventId":"event-1"}"""))

        val summary = queue.flush(sender(engine))

        assertEquals(2, summary.sent)
        assertTrue(queue.all().isEmpty())
        assertEquals(2, engine.requestHistory.size)
        assertTrue(engine.requestHistory.all { it.headers[HttpHeaders.Authorization] == "Bearer bearer-1" })
        assertEquals(listOf("e1", "e2"), engine.requestHistory.map { it.headers["Idempotency-Key"] })
        assertTrue(
            engine.requestHistory[1].body.contentType.toString().startsWith("multipart/form-data"),
        )
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
