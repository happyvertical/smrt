package com.happyvertical.smrt.mobile.network

import com.happyvertical.smrt.mobile.auth.AuthUnauthorizedException
import com.happyvertical.smrt.mobile.contract.MobileAuthStartRequest
import com.happyvertical.smrt.mobile.sync.QueueEntry
import com.happyvertical.smrt.mobile.sync.SendOutcome
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val START_RESPONSE = """
{
  "providerId": "kanidm",
  "authorizationUrl": "https://idp.example.com/authorize",
  "state": "state-1",
  "codeVerifier": "verifier-1",
  "redirectUri": "app://auth"
}
"""

private fun jsonHeaders() = headersOf(HttpHeaders.ContentType, "application/json")

private fun client(
    engine: MockEngine,
    token: String? = "token-1",
    onUnauthorized: UnauthorizedHandler = UnauthorizedHandler {},
) = MobileApiClient(
    engine = engine,
    config = MobileApiConfig(baseUrl = "https://app.example.com/"),
    tokenProvider = { token },
    unauthorizedHandler = onUnauthorized,
)

class MobileApiClientTest {
    @Test
    fun startPostsJsonWithoutBearerAndDecodes() = runTest {
        val engine = MockEngine { respond(START_RESPONSE, HttpStatusCode.OK, jsonHeaders()) }

        val response = client(engine).start(
            MobileAuthStartRequest(providerId = "kanidm", redirectUri = "app://auth"),
        )

        assertEquals("state-1", response.state)
        val request = engine.requestHistory.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("https://app.example.com/api/mobile/auth/start", request.url.toString())
        assertNull(request.headers[HttpHeaders.Authorization])
        val body = request.body.toByteArray().decodeToString()
        assertTrue(body.contains("\"providerId\":\"kanidm\""))
        assertTrue(body.contains("\"redirectUri\":\"app://auth\""))
    }

    @Test
    fun authenticatedRequestsCarryBearerAndAccept() = runTest {
        val engine = MockEngine { respond("{}", HttpStatusCode.OK, jsonHeaders()) }

        client(engine).get("events/nearby?lat=50.4&lng=-104.6")

        val request = engine.requestHistory.single()
        assertEquals("Bearer token-1", request.headers[HttpHeaders.Authorization])
        assertEquals("application/json", request.headers[HttpHeaders.Accept])
        assertEquals(
            "https://app.example.com/api/mobile/events/nearby?lat=50.4&lng=-104.6",
            request.url.toString(),
        )
    }

    @Test
    fun unauthorizedResponseFiresHookAndThrows() = runTest {
        val engine = MockEngine { respond("denied", HttpStatusCode.Unauthorized) }
        var hookCalls = 0

        assertFailsWith<AuthUnauthorizedException> {
            client(engine, onUnauthorized = { hookCalls++ }).get("session")
        }
        assertEquals(1, hookCalls)
    }

    @Test
    fun bootstrapAndLogoutUseExplicitBearer() = runTest {
        val engine = MockEngine { request ->
            if (request.method == HttpMethod.Delete) {
                respond("", HttpStatusCode.NoContent)
            } else {
                respond("""{"user":{"id":"u1"}}""", HttpStatusCode.OK, jsonHeaders())
            }
        }
        val apiClient = client(engine, token = null)

        apiClient.bootstrap("explicit-bearer")
        apiClient.logout("explicit-bearer")

        assertEquals(2, engine.requestHistory.size)
        assertTrue(
            engine.requestHistory.all {
                it.headers[HttpHeaders.Authorization] == "Bearer explicit-bearer"
            },
        )
        assertEquals(HttpMethod.Delete, engine.requestHistory[1].method)
    }

    @Test
    fun non2xxContractResponseThrowsApiException() = runTest {
        val engine = MockEngine { respond("boom", HttpStatusCode.InternalServerError) }

        val failure = assertFailsWith<MobileApiException> {
            client(engine).start(MobileAuthStartRequest(redirectUri = "app://auth"))
        }
        assertEquals(500, failure.status)
    }

    @Test
    fun multipartCarriesFieldsFilesBearerAndIdempotencyKey() = runTest {
        val engine = MockEngine { respond("""{"id":"c1"}""", HttpStatusCode.Created, jsonHeaders()) }

        client(engine).submitMultipart(
            path = "contributions",
            fields = mapOf("eventId" to "event-1", "note" to "hail damage"),
            files = listOf(
                MobileUploadPart(
                    fileName = "asset-1.jpg",
                    contentType = "image/jpeg",
                    bytes = "jpegbytes".encodeToByteArray(),
                ),
            ),
            idempotencyKey = "entry-1",
        )

        val request = engine.requestHistory.single()
        assertEquals("entry-1", request.headers["Idempotency-Key"])
        assertEquals("Bearer token-1", request.headers[HttpHeaders.Authorization])
        val contentType = request.body.contentType.toString()
        assertTrue(contentType.startsWith("multipart/form-data"), contentType)
        val body = request.body.toByteArray().decodeToString()
        assertTrue(body.contains("name=eventId") || body.contains("name=\"eventId\""))
        assertTrue(body.contains("filename=\"asset-1.jpg\""))
        assertTrue(body.contains("jpegbytes"))
    }
}

class HttpQueueSenderTest {
    private fun entry(id: String = "e1") = QueueEntry(
        id = id,
        kind = "capture",
        tenantId = "",
        payload = """{"eventId":"event-1"}""",
        state = "uploading",
        attemptCount = 1,
        lastError = "",
        createdAtEpochMs = 0,
        updatedAtEpochMs = 0,
    )

    private fun sender(engine: MockEngine, onUnauthorized: UnauthorizedHandler = UnauthorizedHandler {}) =
        HttpQueueSender(client(engine, onUnauthorized = onUnauthorized)) {
            QueueHttpRequest.JsonPost("contributions")
        }

    @Test
    fun successMapsFrom2xx() = runTest {
        val engine = MockEngine { respond("""{"id":"c1"}""", HttpStatusCode.Created, jsonHeaders()) }

        assertEquals(SendOutcome.Success, sender(engine).send(entry()))
        val request = engine.requestHistory.single()
        assertEquals("e1", request.headers["Idempotency-Key"])
        assertTrue(request.body.toByteArray().decodeToString().contains("event-1"))
    }

    @Test
    fun clientErrorMapsToRejected() = runTest {
        val engine = MockEngine { respond("bad", HttpStatusCode.UnprocessableEntity) }

        val outcome = sender(engine).send(entry())

        assertTrue(outcome is SendOutcome.Rejected)
        assertEquals("http 422", outcome.reason)
    }

    @Test
    fun serverErrorMapsToRetryable() = runTest {
        val engine = MockEngine { respond("down", HttpStatusCode.ServiceUnavailable) }

        val outcome = sender(engine).send(entry())

        assertTrue(outcome is SendOutcome.Retryable)
        assertEquals("http 503", outcome.reason)
    }

    @Test
    fun transientClientErrorsMapToRetryable() = runTest {
        // 408/429 are transient, not verdicts — they must not consume the
        // entry like other 4xx rejections do.
        for (status in listOf(HttpStatusCode.RequestTimeout, HttpStatusCode.TooManyRequests)) {
            val engine = MockEngine { respond("busy", status) }

            val outcome = sender(engine).send(entry())

            assertTrue(outcome is SendOutcome.Retryable, "expected Retryable for $status")
            assertEquals("http ${status.value}", outcome.reason)
        }
    }

    @Test
    fun unauthorizedMapsAndFiresHook() = runTest {
        val engine = MockEngine { respond("denied", HttpStatusCode.Unauthorized) }
        var hookCalls = 0

        val outcome = sender(engine, onUnauthorized = { hookCalls++ }).send(entry())

        assertEquals(SendOutcome.Unauthorized, outcome)
        assertEquals(1, hookCalls)
    }

    @Test
    fun transportFailureMapsToRetryable() = runTest {
        val engine = MockEngine { throw RuntimeException("connection reset") }

        val outcome = sender(engine).send(entry())

        assertTrue(outcome is SendOutcome.Retryable)
        assertTrue(outcome.reason.contains("connection reset"))
    }
}
