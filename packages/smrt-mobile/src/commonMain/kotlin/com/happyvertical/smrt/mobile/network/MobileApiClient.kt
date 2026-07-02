package com.happyvertical.smrt.mobile.network

import com.happyvertical.smrt.mobile.auth.AuthTransport
import com.happyvertical.smrt.mobile.auth.AuthUnauthorizedException
import com.happyvertical.smrt.mobile.contract.MobileAuthCompleteRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthSession
import com.happyvertical.smrt.mobile.contract.MobileAuthStartRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthStartResponse
import com.happyvertical.smrt.mobile.contract.MobileSessionBootstrap
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json

/**
 * Shared KMP HTTP client for the `/api/mobile` contract (ADR 0001 Phase 4) —
 * replaces both seed apps' raw HttpURLConnection/URLSession transports.
 * Carries the reporter's networking semantics: bearer on every
 * authenticated request, multipart evidence upload with an idempotency key,
 * and 401 → [UnauthorizedHandler] (the [com.happyvertical.smrt.mobile.auth.MobileSessionManager]
 * hook) before failing. Retry of queued writes stays trigger-driven in
 * `DurableWriteQueue` — this client does not auto-retry (reporter parity).
 */
data class MobileApiConfig(
    val baseUrl: String,
    val apiPath: String = "/api/mobile",
    val requestTimeoutMs: Long = 20_000,
    val uploadTimeoutMs: Long = 60_000,
)

fun interface BearerTokenProvider {
    suspend fun accessToken(): String?
}

fun interface UnauthorizedHandler {
    suspend fun onUnauthorized()
}

/** One uploaded file part of a multipart submission. */
data class MobileUploadPart(
    val fileName: String,
    val contentType: String,
    val bytes: ByteArray,
    val fieldName: String = "file",
)

/** A raw response envelope; apps decode with the contract serializers. */
data class MobileApiResponse(
    val status: Int,
    val body: String,
) {
    val isSuccess: Boolean get() = status in 200..299
}

class MobileApiClient(
    engine: HttpClientEngine,
    private val config: MobileApiConfig,
    private val tokenProvider: BearerTokenProvider,
    private val unauthorizedHandler: UnauthorizedHandler = UnauthorizedHandler {},
) : AuthTransport {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private val client = HttpClient(engine) {
        expectSuccess = false
        install(HttpTimeout) {
            requestTimeoutMillis = config.requestTimeoutMs
        }
    }

    // ---- AuthTransport ----

    override suspend fun start(request: MobileAuthStartRequest): MobileAuthStartResponse =
        postJson(
            path = "auth/start",
            body = json.encodeToString(MobileAuthStartRequest.serializer(), request),
            authenticated = false,
        ).decodeOrThrow(MobileAuthStartResponse.serializer())

    override suspend fun complete(request: MobileAuthCompleteRequest): MobileAuthSession =
        postJson(
            path = "auth/complete",
            body = json.encodeToString(MobileAuthCompleteRequest.serializer(), request),
            authenticated = false,
        ).decodeOrThrow(MobileAuthSession.serializer())

    override suspend fun bootstrap(accessToken: String): MobileSessionBootstrap =
        execute(HttpMethod.Get, "session", bearer = accessToken)
            .decodeOrThrow(MobileSessionBootstrap.serializer())

    override suspend fun logout(accessToken: String) {
        execute(HttpMethod.Delete, "session", bearer = accessToken)
    }

    // ---- Generic surface (queue sender + app calls) ----

    suspend fun get(path: String): MobileApiResponse =
        execute(HttpMethod.Get, path, bearer = tokenProvider.accessToken())

    suspend fun postJson(
        path: String,
        body: String,
        idempotencyKey: String? = null,
        authenticated: Boolean = true,
    ): MobileApiResponse = execute(
        method = HttpMethod.Post,
        path = path,
        bearer = if (authenticated) tokenProvider.accessToken() else null,
        idempotencyKey = idempotencyKey,
    ) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    suspend fun delete(path: String): MobileApiResponse =
        execute(HttpMethod.Delete, path, bearer = tokenProvider.accessToken())

    /**
     * Streams a multipart/form-data submission (evidence upload): plain
     * fields plus file parts, with the entry id as `Idempotency-Key` so the
     * server dedupes re-sent queue entries.
     */
    suspend fun submitMultipart(
        path: String,
        fields: Map<String, String>,
        files: List<MobileUploadPart>,
        idempotencyKey: String? = null,
    ): MobileApiResponse = execute(
        method = HttpMethod.Post,
        path = path,
        bearer = tokenProvider.accessToken(),
        idempotencyKey = idempotencyKey,
        timeoutMs = config.uploadTimeoutMs,
    ) {
        setBody(
            MultiPartFormDataContent(
                formData {
                    for ((name, value) in fields) {
                        append(name, value)
                    }
                    for (part in files) {
                        append(
                            part.fieldName,
                            part.bytes,
                            Headers.build {
                                append(HttpHeaders.ContentType, part.contentType)
                                append(
                                    HttpHeaders.ContentDisposition,
                                    "filename=\"${part.fileName}\"",
                                )
                            },
                        )
                    }
                },
            ),
        )
    }

    private suspend fun execute(
        method: HttpMethod,
        path: String,
        bearer: String?,
        idempotencyKey: String? = null,
        timeoutMs: Long? = null,
        configure: HttpRequestBuilder.() -> Unit = {},
    ): MobileApiResponse {
        val response = client.request(url(path)) {
            this.method = method
            header(HttpHeaders.Accept, ContentType.Application.Json.toString())
            bearer?.let { header(HttpHeaders.Authorization, "Bearer $it") }
            idempotencyKey?.let { header("Idempotency-Key", it) }
            timeoutMs?.let { uploadTimeout ->
                timeout { requestTimeoutMillis = uploadTimeout }
            }
            configure()
        }
        if (response.status == HttpStatusCode.Unauthorized) {
            unauthorizedHandler.onUnauthorized()
            throw AuthUnauthorizedException("401 from ${url(path)}")
        }
        return MobileApiResponse(status = response.status.value, body = response.bodyAsText())
    }

    private fun url(path: String): String =
        "${config.baseUrl.trimEnd('/')}${config.apiPath}/${path.trimStart('/')}"

    private fun <T> MobileApiResponse.decodeOrThrow(strategy: DeserializationStrategy<T>): T {
        if (!isSuccess) {
            throw MobileApiException(status, body)
        }
        return json.decodeFromString(strategy, body)
    }
}

/** A non-401 error response from the mobile API. */
class MobileApiException(val status: Int, val responseBody: String) :
    Exception("mobile api returned http $status")
