package com.happyvertical.smrt.mobile.platform

import app.cash.sqldelight.driver.native.NativeSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import com.happyvertical.smrt.mobile.network.BearerTokenProvider
import com.happyvertical.smrt.mobile.network.MobileApiClient
import com.happyvertical.smrt.mobile.network.MobileApiConfig
import com.happyvertical.smrt.mobile.network.UnauthorizedHandler
import com.happyvertical.smrt.mobile.packs.DurableOfflinePackStore
import com.happyvertical.smrt.mobile.sync.DurableWriteQueue
import io.ktor.client.engine.darwin.Darwin

/**
 * iOS platform factories the exported `SmrtMobile` framework hands to Swift
 * (Phase 6, ADR 0001).
 *
 * The durable store and the shared HTTP client are built from **Kotlin/Native
 * types Swift cannot instantiate** — SQLDelight's [NativeSqliteDriver] and
 * Ktor's `Darwin` engine. smrt-android is itself Kotlin, so it constructs its
 * own `AndroidSqliteDriver`/OkHttp engine; the iOS half has to cross the
 * framework boundary here. These deps live in `iosMain` (not commonMain, which
 * stays engine-free) and are bundled into the static framework, so `smrt-ios`
 * links only `SmrtMobile.framework` — no CocoaPods, no separate Kotlin
 * artifacts in the Swift build.
 */
object SmrtMobileIos {
    /**
     * Opens the durable [SmrtMobileDatabase] (write-queue + pack store) on a
     * `NativeSqliteDriver`. **One database per app** — build it once and share
     * the `DurableWriteQueue`/`DurableOfflinePackStore` instances built on it
     * (the queue contract is one instance per database). The native driver
     * creates and migrates the schema on open.
     */
    fun createDatabase(name: String = DEFAULT_DATABASE_NAME): SmrtMobileDatabase =
        SmrtMobileDatabase(NativeSqliteDriver(SmrtMobileDatabase.Schema, name))

    /**
     * Builds the shared [MobileApiClient] over Ktor's Darwin engine, hiding the
     * engine from Swift. Wire [tokenProvider] to `MobileSessionManager.accessToken`
     * and [unauthorizedHandler] to `MobileSessionManager.onUnauthorized`.
     */
    fun createApiClient(
        config: MobileApiConfig,
        tokenProvider: BearerTokenProvider,
        unauthorizedHandler: UnauthorizedHandler = UnauthorizedHandler {},
    ): MobileApiClient = MobileApiClient(
        engine = Darwin.create(),
        config = config,
        tokenProvider = tokenProvider,
        unauthorizedHandler = unauthorizedHandler,
    )

    /**
     * The durable offline pack store on [database]. Hides the defaulted
     * `clock`/`context` params (Kotlin defaults Swift cannot supply).
     */
    fun createOfflinePackStore(database: SmrtMobileDatabase): DurableOfflinePackStore =
        DurableOfflinePackStore(database)

    /**
     * The durable, crash-safe write-queue on [database]. Hides the defaulted
     * `clock`/`maxAttempts`/`context` params. One queue per database.
     */
    fun createWriteQueue(database: SmrtMobileDatabase): DurableWriteQueue =
        DurableWriteQueue(database)

    const val DEFAULT_DATABASE_NAME: String = "smrt_mobile.db"
}
