package com.happyvertical.smrt.mobile.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.io.path.createTempFile
import kotlin.io.path.deleteIfExists
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class DurableWriteQueueTest {
    private fun newDatabase(url: String = JdbcSqliteDriver.IN_MEMORY, createSchema: Boolean = true): SmrtMobileDatabase {
        val driver = JdbcSqliteDriver(url)
        if (createSchema) {
            SmrtMobileDatabase.Schema.create(driver)
        }
        return SmrtMobileDatabase(driver)
    }

    private fun entry(id: String, payload: String = """{"n":1}""") =
        NewQueueEntry(id = id, kind = "capture", payload = payload, tenantId = "tenant-1")

    @Test
    fun successfulFlushRemovesEntries() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1"))
        queue.enqueue(entry("e2"))

        val summary = queue.flush { SendOutcome.Success }

        assertEquals(2, summary.sent)
        assertTrue(queue.all().isEmpty())
        assertEquals(0, queue.stats().pending)
    }

    @Test
    fun retryableKeepsPendingThenParksAsFailedAtCap() = runBlocking {
        val queue = DurableWriteQueue(newDatabase(), maxAttempts = 2)
        queue.enqueue(entry("e1"))

        val first = queue.flush { SendOutcome.Retryable("http 503") }
        assertEquals(1, first.retried)
        val afterFirst = assertNotNull(queue.get("e1"))
        assertEquals(QueueEntryState.PENDING, afterFirst.state)
        assertEquals(1, afterFirst.attemptCount)
        assertEquals("http 503", afterFirst.lastError)

        val second = queue.flush { SendOutcome.Retryable("http 503") }
        assertEquals(1, second.failedTerminally)
        val afterSecond = assertNotNull(queue.get("e1"))
        assertEquals(QueueEntryState.FAILED, afterSecond.state)
        assertEquals(2, afterSecond.attemptCount)

        // Terminal entries are excluded from auto-flush…
        val third = queue.flush { SendOutcome.Success }
        assertEquals(0, third.sent)
        assertEquals(1, queue.failed().size)

        // …and can be discarded manually.
        assertEquals(1, queue.discardFailed())
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun senderExceptionsAreRetryable() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1"))

        val summary = queue.flush { throw IllegalStateException("socket reset") }

        assertEquals(1, summary.retried)
        assertEquals("socket reset", assertNotNull(queue.get("e1")).lastError)
    }

    @Test
    fun rejectedEntriesAreRemoved() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1"))

        val summary = queue.flush { SendOutcome.Rejected("http 422") }

        assertEquals(1, summary.rejected)
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun unauthorizedAbortsFlushAndPreservesQueue() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1"))
        queue.enqueue(entry("e2"))

        val summary = queue.flush { SendOutcome.Unauthorized }

        assertTrue(summary.unauthorized)
        assertEquals(0, summary.sent)
        val entries = queue.all()
        assertEquals(2, entries.size)
        assertTrue(entries.all { it.state == QueueEntryState.PENDING })
        // Only the first entry was attempted before the abort.
        assertEquals(1, assertNotNull(queue.get("e1")).attemptCount)
        assertEquals(0, assertNotNull(queue.get("e2")).attemptCount)
    }

    @Test
    fun overlappingFlushesCoalesceToSingleFlight() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1"))
        val gate = CompletableDeferred<Unit>()

        val slowFlush = launch(Dispatchers.Default) {
            queue.flush {
                gate.await()
                SendOutcome.Success
            }
        }

        withTimeout(5000) {
            while (queue.stats().uploading == 0L) {
                delay(10)
            }
        }

        val overlapping = queue.flush { SendOutcome.Success }
        assertTrue(overlapping.alreadyRunning)

        gate.complete(Unit)
        slowFlush.join()
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun interruptedUploadRecoversToPendingOnRestart() = runBlocking {
        val dbFile = createTempFile("smrt-mobile-queue", ".db")
        try {
            val url = "jdbc:sqlite:${dbFile.toAbsolutePath()}"
            val database = newDatabase(url)
            DurableWriteQueue(database).enqueue(entry("e1"))
            // Simulate a process death mid-upload: the row is left in
            // `uploading` and this "process" never completes the send.
            database.queueEntryQueries.markUploading(42L, "e1")

            val restarted = DurableWriteQueue(newDatabase(url, createSchema = false))

            val recovered = assertNotNull(restarted.get("e1"))
            assertEquals(QueueEntryState.PENDING, recovered.state)
            assertEquals(1, recovered.attemptCount)
            assertEquals(1, restarted.pending().size)
        } finally {
            dbFile.deleteIfExists()
        }
    }

    @Test
    fun reEnqueueingSameIdReplacesTheEntry() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1", payload = """{"v":"a"}"""))
        queue.flush { SendOutcome.Retryable("offline") }

        val replaced = queue.enqueue(entry("e1", payload = """{"v":"b"}"""))

        assertEquals(1, queue.all().size)
        assertEquals("""{"v":"b"}""", replaced.payload)
        assertEquals(0, replaced.attemptCount)
        assertEquals(QueueEntryState.PENDING, replaced.state)
    }

    @Test
    fun flushSendsOldestFirst() = runBlocking {
        val queue = DurableWriteQueue(newDatabase())
        queue.enqueue(entry("e1"))
        queue.enqueue(entry("e2"))
        val seen = mutableListOf<String>()

        queue.flush { sent ->
            seen.add(sent.id)
            SendOutcome.Success
        }

        assertEquals(listOf("e1", "e2"), seen)
    }
}
