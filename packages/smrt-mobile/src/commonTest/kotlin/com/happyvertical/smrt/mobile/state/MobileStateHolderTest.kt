package com.happyvertical.smrt.mobile.state

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest

class MobileStateHolderTest {
    @Test
    fun observesCurrentStateAndUpdates() = runTest {
        val holder = MobileStateHolder(0, StandardTestDispatcher(testScheduler))
        val seen = mutableListOf<Int>()

        val subscription = holder.observe(
            MobileStateObserver { value -> seen.add(value as Int) },
        )
        testScheduler.advanceUntilIdle()

        holder.set(1)
        testScheduler.advanceUntilIdle()
        holder.update { current -> current + 1 }
        testScheduler.advanceUntilIdle()

        assertEquals(listOf(0, 1, 2), seen)
        assertTrue(subscription.isActive)

        subscription.close()
        holder.set(3)
        testScheduler.advanceUntilIdle()

        assertEquals(listOf(0, 1, 2), seen)
        assertFalse(subscription.isActive)
    }

    @Test
    fun canSkipInitialEmission() = runTest {
        val holder = MobileStateHolder("initial", StandardTestDispatcher(testScheduler))
        val seen = mutableListOf<String>()

        holder.observe(
            MobileStateObserver { value -> seen.add(value as String) },
            emitCurrent = false,
        )
        testScheduler.advanceUntilIdle()
        holder.set("next")
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("next"), seen)
    }

    @Test
    fun parentCancellationStopsObservation() = runTest {
        val parent = Job()
        val holder = MobileStateHolder(
            0,
            StandardTestDispatcher(testScheduler) + parent,
        )
        val subscription = holder.observe(MobileStateObserver {})
        testScheduler.advanceUntilIdle()

        parent.cancel()
        testScheduler.advanceUntilIdle()

        assertFalse(subscription.isActive)
        assertFailsWith<IllegalStateException> { holder.set(1) }
    }

    @Test
    fun presenterSubclassesMutateSharedState() {
        val presenter = CounterPresenter()

        assertEquals(1, presenter.increment())
        assertEquals(1, presenter.value)

        presenter.close()
        assertFailsWith<IllegalStateException> { presenter.increment() }
    }

    private class CounterPresenter : MobileStatePresenter<Int>(0) {
        fun increment(): Int = updateState { current -> current + 1 }
    }
}
