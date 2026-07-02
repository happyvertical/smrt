package com.happyvertical.smrt.mobile.auth

import com.happyvertical.smrt.mobile.contract.MobileAuthCompleteRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthSession
import com.happyvertical.smrt.mobile.contract.MobileAuthStartRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthStartResponse
import com.happyvertical.smrt.mobile.contract.MobileSessionBootstrap

/**
 * Platform seams for the auth/session module (ADR 0001 Phase 3). Concrete
 * implementations arrive with the platform libraries: Keystore/Keychain
 * storage and custom-tab / ASWebAuthenticationSession launchers in
 * smrt-android / smrt-ios (Phases 5-6); the HTTP transport in the shared
 * Ktor client (Phase 4).
 */

/**
 * Durable storage for the session and the in-flight auth handshake, as
 * opaque strings (the manager owns serialization). The pending-auth slot
 * must survive process death — the browser hand-off can outlive the app
 * process. Platform implementations should be secure (Keystore/Keychain);
 * the reporter seed's SharedPreferences/UserDefaults storage is explicitly
 * the thing to upgrade.
 */
interface AuthStorage {
    suspend fun readSession(): String?

    suspend fun writeSession(value: String)

    suspend fun clearSession()

    suspend fun readPendingAuth(): String?

    suspend fun writePendingAuth(value: String)

    suspend fun clearPendingAuth()
}

/** Non-durable [AuthStorage] for tests and previews only. */
class InMemoryAuthStorage : AuthStorage {
    private var session: String? = null
    private var pendingAuth: String? = null

    override suspend fun readSession(): String? = session

    override suspend fun writeSession(value: String) {
        session = value
    }

    override suspend fun clearSession() {
        session = null
    }

    override suspend fun readPendingAuth(): String? = pendingAuth

    override suspend fun writePendingAuth(value: String) {
        pendingAuth = value
    }

    override suspend fun clearPendingAuth() {
        pendingAuth = null
    }
}

/** Thrown by [AuthTransport] when the server answers 401. */
class AuthUnauthorizedException(message: String = "unauthorized") : Exception(message)

/**
 * The `/api/mobile` auth endpoints (server-brokered PKCE — the server owns
 * the verifier/state generation and the IdP exchange; issue #1748 tracks the
 * SMRT-shipped handlers).
 */
interface AuthTransport {
    suspend fun start(request: MobileAuthStartRequest): MobileAuthStartResponse

    suspend fun complete(request: MobileAuthCompleteRequest): MobileAuthSession

    suspend fun bootstrap(accessToken: String): MobileSessionBootstrap

    suspend fun logout(accessToken: String)
}

/** Opens the authorization URL in the platform's auth browser surface. */
fun interface ExternalAuthLauncher {
    fun launch(authorizationUrl: String)
}
