package com.happyvertical.smrt.mobile.auth

import com.happyvertical.smrt.mobile.contract.MobileAuthCompleteRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthSession
import com.happyvertical.smrt.mobile.contract.MobileAuthStartRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthStartResponse
import com.happyvertical.smrt.mobile.contract.MobileSessionBootstrap
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Provider-agnostic mobile session manager (ADR 0001 Phase 3), seeded from
 * the anytown reporter's PKCE flow and generalized: configurable provider,
 * redirect scheme, and scopes instead of `ai.anytown.reporter` constants.
 *
 * Flow: [beginSignIn] → server-brokered PKCE start → the platform launcher
 * opens the authorization URL → the IdP redirects to the app's deep link →
 * [handleRedirect] validates `state`, exchanges the code, and persists the
 * session. The pending handshake is persisted too — the browser hand-off can
 * outlive the app process (reporter parity).
 *
 * 401 semantics: [onUnauthorized] (called by the networking client, Phase 4)
 * clears the stored session so the UI re-enters sign-in — the queue keeps
 * its entries (see `DurableWriteQueue`).
 */
data class MobileAuthConfig(
    val redirectUri: String,
    val providerId: String? = null,
    val scopes: List<String> = emptyList(),
)

@Serializable
internal data class PendingAuth(
    val providerId: String,
    val state: String,
    val codeVerifier: String?,
    val redirectUri: String,
)

sealed class AuthFailure(message: String) : Exception(message) {
    /** A redirect arrived with no persisted handshake to match it. */
    class NoPendingAuth : AuthFailure("no pending auth handshake")

    /** The redirect `state` does not match the pending handshake. */
    class StateMismatch : AuthFailure("redirect state does not match pending auth")

    /** The IdP returned an error (e.g. `access_denied`). */
    class ProviderError(val code: String, description: String) :
        AuthFailure(if (description.isBlank()) code else "$code: $description")

    /** The redirect carries no authorization code. */
    class MissingCode : AuthFailure("redirect carries no authorization code")
}

class MobileSessionManager(
    private val config: MobileAuthConfig,
    private val transport: AuthTransport,
    private val storage: AuthStorage,
    private val launcher: ExternalAuthLauncher,
) {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Starts the handshake: persists the pending `state`/`codeVerifier` and
     * hands the authorization URL to the platform launcher.
     */
    suspend fun beginSignIn(loginHint: String? = null): MobileAuthStartResponse {
        val response = transport.start(
            MobileAuthStartRequest(
                providerId = config.providerId,
                redirectUri = config.redirectUri,
                scopes = config.scopes,
                loginHint = loginHint,
            ),
        )
        storage.writePendingAuth(
            json.encodeToString(
                PendingAuth.serializer(),
                PendingAuth(
                    providerId = response.providerId,
                    state = response.state,
                    codeVerifier = response.codeVerifier,
                    redirectUri = response.redirectUri,
                ),
            ),
        )
        launcher.launch(response.authorizationUrl)
        return response
    }

    /**
     * Completes the handshake from the deep-link redirect. Validates `state`
     * against the persisted handshake before exchanging the code. On a
     * mismatch or provider error the pending handshake is kept — a correct
     * redirect for it can still arrive.
     */
    suspend fun handleRedirect(url: String): MobileAuthSession {
        val params = parseQueryParameters(url)
        params["error"]?.let { code ->
            throw AuthFailure.ProviderError(code, params["error_description"] ?: "")
        }
        val pending = readPendingAuth() ?: throw AuthFailure.NoPendingAuth()
        val state = params["state"]
        if (state == null || state != pending.state) {
            throw AuthFailure.StateMismatch()
        }
        val code = params["code"] ?: throw AuthFailure.MissingCode()

        val session = transport.complete(
            MobileAuthCompleteRequest(
                providerId = pending.providerId,
                code = code,
                state = state,
                codeVerifier = pending.codeVerifier,
                redirectUri = pending.redirectUri,
            ),
        )
        storage.writeSession(json.encodeToString(MobileAuthSession.serializer(), session))
        storage.clearPendingAuth()
        return session
    }

    suspend fun currentSession(): MobileAuthSession? = storage.readSession()?.let { stored ->
        try {
            json.decodeFromString(MobileAuthSession.serializer(), stored)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            null
        }
    }

    suspend fun accessToken(): String? = currentSession()?.accessToken

    /**
     * Loads the session bootstrap with the stored bearer. A 401 clears the
     * stored session before rethrowing so callers re-enter sign-in.
     */
    suspend fun bootstrap(): MobileSessionBootstrap {
        val token = accessToken() ?: throw AuthUnauthorizedException("no stored session")
        return try {
            transport.bootstrap(token)
        } catch (unauthorized: AuthUnauthorizedException) {
            storage.clearSession()
            throw unauthorized
        }
    }

    /** The 401 hook for the networking client: drops the stored session. */
    suspend fun onUnauthorized() {
        storage.clearSession()
    }

    /** Best-effort server logout, then clears session + pending handshake. */
    suspend fun signOut() {
        accessToken()?.let { token ->
            try {
                transport.logout(token)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Best-effort: local sign-out proceeds regardless.
            }
        }
        storage.clearSession()
        storage.clearPendingAuth()
    }

    private suspend fun readPendingAuth(): PendingAuth? = storage.readPendingAuth()?.let { stored ->
        try {
            json.decodeFromString(PendingAuth.serializer(), stored)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            null
        }
    }
}

/** Parses query parameters from a redirect URL (fragment ignored). */
internal fun parseQueryParameters(url: String): Map<String, String> {
    val query = url.substringAfter('?', missingDelimiterValue = "").substringBefore('#')
    if (query.isEmpty()) return emptyMap()
    return query
        .split('&')
        .filter { it.isNotEmpty() }
        .associate { pair ->
            val key = percentDecode(pair.substringBefore('='))
            val value = percentDecode(pair.substringAfter('=', missingDelimiterValue = ""))
            key to value
        }
}

/** Decodes %XX sequences (UTF-8) and `+` as space. */
internal fun percentDecode(value: String): String {
    val bytes = ArrayList<Byte>(value.length)
    var i = 0
    while (i < value.length) {
        val char = value[i]
        when {
            char == '+' -> {
                bytes.add(' '.code.toByte())
                i++
            }
            char == '%' && i + 2 < value.length -> {
                val parsed = value.substring(i + 1, i + 3).toIntOrNull(16)
                if (parsed == null) {
                    bytes.add(char.code.toByte())
                    i++
                } else {
                    bytes.add(parsed.toByte())
                    i += 3
                }
            }
            else -> {
                for (byte in char.toString().encodeToByteArray()) {
                    bytes.add(byte)
                }
                i++
            }
        }
    }
    return bytes.toByteArray().decodeToString()
}
