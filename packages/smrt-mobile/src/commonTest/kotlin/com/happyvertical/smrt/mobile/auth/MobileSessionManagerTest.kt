package com.happyvertical.smrt.mobile.auth

import com.happyvertical.smrt.mobile.contract.MobileAuthCompleteRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthSession
import com.happyvertical.smrt.mobile.contract.MobileAuthStartRequest
import com.happyvertical.smrt.mobile.contract.MobileAuthStartResponse
import com.happyvertical.smrt.mobile.contract.MobileSessionBootstrap
import com.happyvertical.smrt.mobile.contract.MobileUserSummary
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeTransport : AuthTransport {
    var startRequests = mutableListOf<MobileAuthStartRequest>()
    var completeRequests = mutableListOf<MobileAuthCompleteRequest>()
    var bootstrapTokens = mutableListOf<String>()
    var logoutTokens = mutableListOf<String>()
    var bootstrapUnauthorized = false
    var logoutThrows = false

    override suspend fun start(request: MobileAuthStartRequest): MobileAuthStartResponse {
        startRequests.add(request)
        return MobileAuthStartResponse(
            providerId = request.providerId ?: "kanidm",
            authorizationUrl = "https://idp.example.com/oauth/authorize?state=state-1",
            state = "state-1",
            codeVerifier = "verifier-1",
            redirectUri = request.redirectUri,
        )
    }

    override suspend fun complete(request: MobileAuthCompleteRequest): MobileAuthSession {
        completeRequests.add(request)
        return MobileAuthSession(
            accessToken = "bearer-1",
            user = MobileUserSummary(id = "user-1", email = "reporter@example.com"),
        )
    }

    override suspend fun bootstrap(accessToken: String): MobileSessionBootstrap {
        bootstrapTokens.add(accessToken)
        if (bootstrapUnauthorized) throw AuthUnauthorizedException()
        return MobileSessionBootstrap(user = MobileUserSummary(id = "user-1"))
    }

    override suspend fun logout(accessToken: String) {
        logoutTokens.add(accessToken)
        if (logoutThrows) throw IllegalStateException("network down")
    }
}

private class RecordingLauncher : ExternalAuthLauncher {
    val launched = mutableListOf<String>()

    override fun launch(authorizationUrl: String) {
        launched.add(authorizationUrl)
    }
}

class MobileSessionManagerTest {
    private val config = MobileAuthConfig(
        redirectUri = "com.example.app://auth",
        providerId = "kanidm",
        scopes = listOf("openid"),
    )

    private fun manager(
        transport: FakeTransport = FakeTransport(),
        storage: AuthStorage = InMemoryAuthStorage(),
        launcher: RecordingLauncher = RecordingLauncher(),
    ) = MobileSessionManager(config, transport, storage, launcher)

    @Test
    fun fullHandshakeRoundTrip() = runTest {
        val transport = FakeTransport()
        val storage = InMemoryAuthStorage()
        val launcher = RecordingLauncher()
        val manager = MobileSessionManager(config, transport, storage, launcher)

        val started = manager.beginSignIn(loginHint = "reporter@example.com")
        assertEquals(listOf(started.authorizationUrl), launcher.launched)
        assertEquals("reporter@example.com", transport.startRequests.single().loginHint)
        assertNotNull(storage.readPendingAuth())

        val session = manager.handleRedirect("com.example.app://auth?code=code-1&state=state-1")

        assertEquals("bearer-1", session.accessToken)
        val complete = transport.completeRequests.single()
        assertEquals("code-1", complete.code)
        assertEquals("state-1", complete.state)
        assertEquals("verifier-1", complete.codeVerifier)
        assertEquals("com.example.app://auth", complete.redirectUri)
        assertNull(storage.readPendingAuth())
        assertEquals("bearer-1", manager.accessToken())
    }

    @Test
    fun handshakeSurvivesProcessRestart() = runTest {
        val storage = InMemoryAuthStorage()
        manager(storage = storage).beginSignIn()

        // A fresh manager over the same storage (new process) completes it.
        val restarted = manager(storage = storage)
        val session = restarted.handleRedirect("com.example.app://auth?code=code-1&state=state-1")

        assertEquals("bearer-1", session.accessToken)
    }

    @Test
    fun stateMismatchIsRejectedAndPendingKept() = runTest {
        val storage = InMemoryAuthStorage()
        val manager = manager(storage = storage)
        manager.beginSignIn()

        assertFailsWith<AuthFailure.StateMismatch> {
            manager.handleRedirect("com.example.app://auth?code=code-1&state=forged")
        }
        assertNotNull(storage.readPendingAuth())

        // The genuine redirect still completes.
        assertEquals(
            "bearer-1",
            manager.handleRedirect("com.example.app://auth?code=code-1&state=state-1").accessToken,
        )
    }

    @Test
    fun providerErrorSurfacesDecodedDescription() = runTest {
        val manager = manager()
        manager.beginSignIn()

        val failure = assertFailsWith<AuthFailure.ProviderError> {
            manager.handleRedirect(
                "com.example.app://auth?error=access_denied&error_description=User%20cancelled+sign-in",
            )
        }
        assertEquals("access_denied", failure.code)
        assertEquals("access_denied: User cancelled sign-in", failure.message)
    }

    @Test
    fun redirectWithoutPendingHandshakeFails() = runTest {
        assertFailsWith<AuthFailure.NoPendingAuth> {
            manager().handleRedirect("com.example.app://auth?code=c&state=s")
        }
    }

    @Test
    fun redirectWithoutCodeFails() = runTest {
        val manager = manager()
        manager.beginSignIn()

        assertFailsWith<AuthFailure.MissingCode> {
            manager.handleRedirect("com.example.app://auth?state=state-1")
        }
    }

    @Test
    fun sessionPersistsAcrossManagerInstances() = runTest {
        val storage = InMemoryAuthStorage()
        val first = manager(storage = storage)
        first.beginSignIn()
        first.handleRedirect("com.example.app://auth?code=code-1&state=state-1")

        assertEquals("bearer-1", manager(storage = storage).accessToken())
    }

    @Test
    fun corruptedStoredSessionReadsAsNull() = runTest {
        val storage = InMemoryAuthStorage()
        storage.writeSession("{not json")

        assertNull(manager(storage = storage).currentSession())
    }

    @Test
    fun bootstrapForwardsBearerAndClearsSessionOn401() = runTest {
        val transport = FakeTransport()
        val storage = InMemoryAuthStorage()
        val manager = manager(transport = transport, storage = storage)
        manager.beginSignIn()
        manager.handleRedirect("com.example.app://auth?code=code-1&state=state-1")

        manager.bootstrap()
        assertEquals(listOf("bearer-1"), transport.bootstrapTokens)

        transport.bootstrapUnauthorized = true
        assertFailsWith<AuthUnauthorizedException> { manager.bootstrap() }
        assertNull(storage.readSession())
    }

    @Test
    fun bootstrapWithoutSessionIsUnauthorized() = runTest {
        assertFailsWith<AuthUnauthorizedException> { manager().bootstrap() }
    }

    @Test
    fun onUnauthorizedClearsStoredSession() = runTest {
        val storage = InMemoryAuthStorage()
        val manager = manager(storage = storage)
        manager.beginSignIn()
        manager.handleRedirect("com.example.app://auth?code=code-1&state=state-1")

        manager.onUnauthorized()

        assertNull(manager.accessToken())
    }

    @Test
    fun signOutLogsOutAndClearsEvenWhenServerCallFails() = runTest {
        val transport = FakeTransport().apply { logoutThrows = true }
        val storage = InMemoryAuthStorage()
        val manager = manager(transport = transport, storage = storage)
        manager.beginSignIn()
        manager.handleRedirect("com.example.app://auth?code=code-1&state=state-1")

        manager.signOut()

        assertEquals(listOf("bearer-1"), transport.logoutTokens)
        assertNull(storage.readSession())
        assertNull(storage.readPendingAuth())
    }
}

class RedirectParsingTest {
    @Test
    fun parsesQueryParameters() {
        val params = parseQueryParameters("app://auth?code=abc&state=xyz")

        assertEquals("abc", params["code"])
        assertEquals("xyz", params["state"])
    }

    @Test
    fun ignoresFragmentAndHandlesMissingQuery() {
        assertEquals("abc", parseQueryParameters("app://auth?code=abc#fragment")["code"])
        assertTrue(parseQueryParameters("app://auth").isEmpty())
    }

    @Test
    fun percentDecodesUtf8AndPlus() {
        assertEquals("User cancelled sign-in", percentDecode("User%20cancelled+sign-in"))
        assertEquals("café", percentDecode("caf%C3%A9"))
        assertEquals("100%", percentDecode("100%"))
    }
}
