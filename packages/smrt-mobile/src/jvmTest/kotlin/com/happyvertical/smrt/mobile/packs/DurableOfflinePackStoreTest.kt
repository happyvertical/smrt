package com.happyvertical.smrt.mobile.packs

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

private class SteppingClock(private var nowMs: Long = 1_000) : Clock {
    override fun now(): Instant = Instant.fromEpochMilliseconds(nowMs++)
}

class DurableOfflinePackStoreTest {
    private fun newDatabase(): SmrtMobileDatabase {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        SmrtMobileDatabase.Schema.create(driver)
        return SmrtMobileDatabase(driver)
    }

    @Test
    fun savesAndReadsBackRecords() = runBlocking {
        val store = DurableOfflinePackStore(newDatabase(), SteppingClock())
        store.save(
            OfflinePackRecord(
                packId = "pack-1",
                version = 3,
                manifestHash = "abc123",
                payload = """{"projectName":"Depot"}""",
            ),
        )

        val loaded = assertNotNull(store.get("pack-1"))
        assertEquals(3, loaded.version)
        assertEquals("abc123", loaded.manifestHash)
        assertEquals("""{"projectName":"Depot"}""", loaded.payload)
        assertNull(store.get("missing"))
    }

    @Test
    fun listReturnsNewestFirst() = runBlocking {
        val store = DurableOfflinePackStore(newDatabase(), SteppingClock())
        store.save(OfflinePackRecord(packId = "old", payload = "{}"))
        store.save(OfflinePackRecord(packId = "new", payload = "{}"))

        assertEquals(listOf("new", "old"), store.list().map { it.packId })
    }

    @Test
    fun savingSamePackIdReplacesTheSnapshot() = runBlocking {
        val store = DurableOfflinePackStore(newDatabase(), SteppingClock())
        store.save(OfflinePackRecord(packId = "pack-1", version = 1, payload = """{"v":1}"""))
        store.save(OfflinePackRecord(packId = "pack-1", version = 2, payload = """{"v":2}"""))

        assertEquals(1, store.list().size)
        val loaded = assertNotNull(store.get("pack-1"))
        assertEquals(2, loaded.version)
        assertEquals("""{"v":2}""", loaded.payload)
    }

    @Test
    fun deleteRemovesTheRecord() = runBlocking {
        val store = DurableOfflinePackStore(newDatabase(), SteppingClock())
        store.save(OfflinePackRecord(packId = "pack-1", payload = "{}"))

        store.delete("pack-1")

        assertNull(store.get("pack-1"))
        assertEquals(0, store.list().size)
    }
}
