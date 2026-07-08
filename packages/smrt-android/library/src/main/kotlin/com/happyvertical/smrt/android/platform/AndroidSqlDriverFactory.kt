package com.happyvertical.smrt.android.platform

import android.content.Context
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase

/**
 * Android driver factory for smrt-mobile's `SmrtMobileDatabase` (the
 * durable write-queue + pack store). One database file per app — create the
 * driver once and share the queue/store instances built on it (the queue
 * contract is one instance per database).
 */
class AndroidSqlDriverFactory(private val context: Context) {
    fun createDriver(name: String = DEFAULT_DATABASE_NAME): SqlDriver = AndroidSqliteDriver(
        schema = SmrtMobileDatabase.Schema,
        context = context.applicationContext,
        name = name,
    )

    companion object {
        const val DEFAULT_DATABASE_NAME = "smrt_mobile.db"
    }
}
