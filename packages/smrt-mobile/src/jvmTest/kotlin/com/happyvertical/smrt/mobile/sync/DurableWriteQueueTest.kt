package com.happyvertical.smrt.mobile.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import com.happyvertical.smrt.mobile.testsupport.FixedClock
import com.happyvertical.smrt.mobile.testsupport.newTestDatabase
import com.happyvertical.smrt.mobile.testsupport.newTestDriver
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
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
    private fun entry(id: String, payload: String = """{"n":1}""") =
        NewQueueEntry(id = id, kind = "capture", payload = payload, tenantId = "tenant-1")

    private suspend fun DurableWriteQueue.awaitUploading() {
        withTimeout(5000) {
            while (stats().uploading == 0L) {
                delay(10)
            }
        }
    }

    @Test
    fun successfulFlushRemovesEntries() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))
        queue.enqueue(entry("e2"))

        val summary = queue.flush { SendOutcome.Success }

        assertEquals(2, summary.sent)
        assertTrue(queue.all().isEmpty())
        assertEquals(0, queue.stats().pending)
    }

    @Test
    fun retryableKeepsPendingThenParksAsFailedAtCap() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase(), maxAttempts = 2)
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
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))

        val summary = queue.flush { throw IllegalStateException("socket reset") }

        assertEquals(1, summary.retried)
        assertEquals("socket reset", assertNotNull(queue.get("e1")).lastError)
    }

    @Test
    fun rejectedEntriesAreRemovedAndReasonsSurfaced() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))

        val summary = queue.flush { SendOutcome.Rejected("http 422") }

        assertEquals(1, summary.rejected)
        assertEquals(listOf("http 422"), summary.rejectedReasons)
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun unauthorizedAbortsFlushWithoutSpendingAttempts() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))
        queue.enqueue(entry("e2"))

        // Repeated auth outages must not walk entries toward the cap.
        repeat(3) {
            val summary = queue.flush { SendOutcome.Unauthorized }
            assertTrue(summary.unauthorized)
            assertEquals(0, summary.sent)
        }

        val entries = queue.all()
        assertEquals(2, entries.size)
        assertTrue(entries.all { it.state == QueueEntryState.PENDING })
        assertTrue(entries.all { it.attemptCount == 0 })
        // Only the first entry was ever attempted before each abort.
        assertEquals("unauthorized", assertNotNull(queue.get("e1")).lastError)
        assertEquals("", assertNotNull(queue.get("e2")).lastError)
    }

    @Test
    fun overlappingFlushLatchesARerunAndDrains() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))
        val gate = CompletableDeferred<Unit>()

        val slowFlush = launch(Dispatchers.Default) {
            queue.flush {
                if (!gate.isCompleted) gate.await()
                SendOutcome.Success
            }
        }
        queue.awaitUploading()

        // Enqueued during the running flush + an overlapped trigger: the
        // trigger is latched, not dropped.
        queue.enqueue(entry("e2"))
        val overlapping = queue.flush { SendOutcome.Success }
        assertTrue(overlapping.alreadyRunning)

        gate.complete(Unit)
        slowFlush.join()

        assertTrue(queue.all().isEmpty(), "latched rerun should drain e2")
    }

    @Test
    fun rerunPassSkipsEntriesAlreadyRetriedThisCall() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))
        val gate = CompletableDeferred<Unit>()

        val slowFlush = launch(Dispatchers.Default) {
            queue.flush {
                if (!gate.isCompleted) gate.await()
                SendOutcome.Retryable("http 503")
            }
        }
        queue.awaitUploading()
        // Latch a rerun while e1's send is in flight…
        assertTrue(queue.flush { SendOutcome.Retryable("http 503") }.alreadyRunning)
        gate.complete(Unit)
        slowFlush.join()

        // …the rerun pass must not immediately re-send e1: retries wait for
        // the next real trigger, so exactly one attempt is spent.
        val after = assertNotNull(queue.get("e1"))
        assertEquals(1, after.attemptCount)
        assertEquals(QueueEntryState.PENDING, after.state)
    }

    @Test
    fun reEnqueueDuringInFlightSendSurvivesStaleSuccess() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1", payload = """{"v":"a"}"""))
        val gate = CompletableDeferred<Unit>()

        val slowFlush = launch(Dispatchers.Default) {
            queue.flush {
                if (!gate.isCompleted) gate.await()
                SendOutcome.Success
            }
        }
        queue.awaitUploading()

        // User edits the capture while payload "a" is mid-send: the
        // replacement must survive the stale send's Success.
        queue.enqueue(entry("e1", payload = """{"v":"b"}"""))
        gate.complete(Unit)
        slowFlush.join()

        val survivor = assertNotNull(queue.get("e1"), "replacement row must survive")
        assertEquals("""{"v":"b"}""", survivor.payload)
        assertEquals(QueueEntryState.PENDING, survivor.state)
        assertEquals(0, survivor.attemptCount)
    }

    @Test
    fun reEnqueueDuringInFlightSendIsNotParkedByStaleCapFailure() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase(), maxAttempts = 1)
        queue.enqueue(entry("e1", payload = """{"v":"a"}"""))
        val gate = CompletableDeferred<Unit>()

        val slowFlush = launch(Dispatchers.Default) {
            queue.flush {
                if (!gate.isCompleted) gate.await()
                SendOutcome.Retryable("http 503")
            }
        }
        queue.awaitUploading()

        queue.enqueue(entry("e1", payload = """{"v":"b"}"""))
        gate.complete(Unit)
        slowFlush.join()

        val survivor = assertNotNull(queue.get("e1"))
        assertEquals(QueueEntryState.PENDING, survivor.state)
        assertEquals("""{"v":"b"}""", survivor.payload)
        assertEquals(0, survivor.attemptCount)
    }

    @Test
    fun cancelledInFlightSendResetsRowForNextFlush() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1"))
        val started = CompletableDeferred<Unit>()

        val cancelled = launch(Dispatchers.Default) {
            queue.flush {
                started.complete(Unit)
                CompletableDeferred<Unit>().await() // suspend until cancelled
                SendOutcome.Success
            }
        }
        started.await()
        queue.awaitUploading()
        cancelled.cancelAndJoin()

        val recovered = assertNotNull(queue.get("e1"))
        assertEquals(QueueEntryState.PENDING, recovered.state)
        assertEquals(1, recovered.attemptCount)
        assertEquals("cancelled", recovered.lastError)

        // The queue is usable again immediately.
        assertEquals(1, queue.flush { SendOutcome.Success }.sent)
    }

    @Test
    fun interruptedUploadRecoversAfterRestart() = runBlocking {
        val dbFile = createTempFile("smrt-mobile-queue", ".db")
        val firstProcess = newTestDriver("jdbc:sqlite:${dbFile.toAbsolutePath()}")
        var secondProcess: JdbcSqliteDriver? = null
        try {
            val database = SmrtMobileDatabase(firstProcess)
            DurableWriteQueue(database).enqueue(entry("e1"))
            // Simulate process death mid-upload: the row is left `uploading`
            // and this "process" never completes the send.
            database.queueEntryQueries.markUploading(
                uploading = QueueEntryState.UPLOADING,
                now = 42L,
                id = "e1",
                pending = QueueEntryState.PENDING,
            )
            firstProcess.close()

            secondProcess = newTestDriver(
                "jdbc:sqlite:${dbFile.toAbsolutePath()}",
                createSchema = false,
            )
            val restarted = DurableWriteQueue(SmrtMobileDatabase(secondProcess))
            assertEquals(1, restarted.stats().uploading)

            // Eager recovery surfaces the row before any flush…
            restarted.recoverInterrupted()
            val recovered = assertNotNull(restarted.get("e1"))
            assertEquals(QueueEntryState.PENDING, recovered.state)
            assertEquals(1, recovered.attemptCount)

            // …and a flush re-sends it.
            assertEquals(1, restarted.flush { SendOutcome.Success }.sent)
        } finally {
            secondProcess?.close()
            dbFile.deleteIfExists()
        }
    }

    @Test
    fun flushAloneRecoversInterruptedRows() = runBlocking {
        val database = newTestDatabase()
        val queue = DurableWriteQueue(database)
        queue.enqueue(entry("e1"))
        database.queueEntryQueries.markUploading(
            uploading = QueueEntryState.UPLOADING,
            now = 42L,
            id = "e1",
            pending = QueueEntryState.PENDING,
        )

        // No explicit recovery call: the flush-start sweep picks it up.
        assertEquals(1, queue.flush { SendOutcome.Success }.sent)
        assertTrue(queue.all().isEmpty())
    }

    @Test
    fun reEnqueueingSameIdReplacesTheEntry() = runBlocking {
        val queue = DurableWriteQueue(newTestDatabase())
        queue.enqueue(entry("e1", payload = """{"v":"a"}"""))
        queue.flush { SendOutcome.Retryable("offline") }

        val replaced = queue.enqueue(entry("e1", payload = """{"v":"b"}"""))

        assertEquals(1, queue.all().size)
        assertEquals("""{"v":"b"}""", replaced.payload)
        assertEquals(0, replaced.attemptCount)
        assertEquals(QueueEntryState.PENDING, replaced.state)
    }

    @Test
    fun flushSendsInInsertionOrderEvenWithinOneMillisecond() = runBlocking {
        // FixedClock: identical created_at for every entry — ordering must
        // come from insertion (rowid), not timestamps or id lexicography.
        val queue = DurableWriteQueue(newTestDatabase(), clock = FixedClock())
        queue.enqueue(entry("zz-first"))
        queue.enqueue(entry("aa-second"))
        val seen = mutableListOf<String>()

        queue.flush { sent ->
            seen.add(sent.id)
            SendOutcome.Success
        }

        assertEquals(listOf("zz-first", "aa-second"), seen)
    }
}
