package com.happyvertical.smrt.mobile.state

import kotlin.concurrent.Volatile
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Shared presenter state holder for apps that move orchestration into KMP.
 *
 * Compose can collect [state] directly. SwiftUI should observe this through the
 * smrt-ios adapter, which uses [observe] instead of requiring each app to learn
 * Kotlin/Native Flow collection details.
 */
open class MobileStateHolder<T : Any>(
    initialState: T,
    coroutineContext: CoroutineContext = Dispatchers.Default,
) {
    private val rootJob = SupervisorJob(coroutineContext[Job])
    private val scope = CoroutineScope(coroutineContext + rootJob)
    private val mutableState = MutableStateFlow(initialState)

    @Volatile
    private var closed = false

    val state: StateFlow<T> = mutableState.asStateFlow()

    val value: T
        get() = mutableState.value

    fun set(next: T): T {
        ensureOpen()
        mutableState.value = next
        return next
    }

    fun update(reducer: (T) -> T): T {
        ensureOpen()
        var updated = value
        mutableState.update { current ->
            reducer(current).also { updated = it }
        }
        return updated
    }

    fun observe(
        observer: MobileStateObserver,
        emitCurrent: Boolean = true,
    ): MobileStateSubscription {
        ensureOpen()
        val flow = if (emitCurrent) state else state.drop(1)
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            flow.collect { next -> observer.onState(next) }
        }
        return MobileStateSubscription(job)
    }

    open fun close() {
        if (closed) return
        closed = true
        scope.cancel()
    }

    private fun ensureOpen() {
        check(!closed && rootJob.isActive) { "MobileStateHolder is closed" }
    }
}

/**
 * Type-erased observer for Kotlin/Native export. The smrt-ios adapter casts the
 * received value to the Swift generic state type before publishing it.
 */
fun interface MobileStateObserver {
    fun onState(value: Any?)
}

class MobileStateSubscription internal constructor(private val job: Job) {
    val isActive: Boolean
        get() = job.isActive

    fun close() {
        job.cancel()
    }
}

/**
 * Base class for shared presenters/view-models. Apps put orchestration methods
 * on subclasses and expose [holder] to platform UI.
 */
abstract class MobileStatePresenter<T : Any>(
    initialState: T,
    coroutineContext: CoroutineContext = Dispatchers.Default,
) {
    val holder: MobileStateHolder<T> = MobileStateHolder(initialState, coroutineContext)

    val state: StateFlow<T>
        get() = holder.state

    val value: T
        get() = holder.value

    protected fun setState(next: T): T = holder.set(next)

    protected fun updateState(reducer: (T) -> T): T = holder.update(reducer)

    open fun close() {
        holder.close()
    }
}
