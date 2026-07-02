package com.happyvertical.smrt.mobile.testsupport

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/**
 * Shared jvmTest bootstrap for the SQLDelight database: in-memory by default,
 * file-backed (pass a `jdbc:sqlite:<path>` url with `createSchema = false` on
 * reopen) for process-death simulations.
 */
fun newTestDatabase(
    url: String = JdbcSqliteDriver.IN_MEMORY,
    createSchema: Boolean = true,
): SmrtMobileDatabase {
    val driver = JdbcSqliteDriver(url)
    if (createSchema) {
        SmrtMobileDatabase.Schema.create(driver)
    }
    return SmrtMobileDatabase(driver)
}

/** Deterministic clock advancing one millisecond per read. */
class SteppingClock(private var nowMs: Long = 1_000) : Clock {
    override fun now(): Instant = Instant.fromEpochMilliseconds(nowMs++)
}

/** Deterministic clock frozen at [nowMs] (same-timestamp ordering tests). */
class FixedClock(private val nowMs: Long = 1_000) : Clock {
    override fun now(): Instant = Instant.fromEpochMilliseconds(nowMs)
}
