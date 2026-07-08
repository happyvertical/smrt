package com.happyvertical.smrt.mobile.platform

import kotlinx.serialization.Serializable

/**
 * Shared speech-transcription seam (ADR 0001 Correction 4 — net-new; the
 * amaru seed's recognizer was a concrete Android class with no shared
 * contract). Named `SpeechTranscriber` to avoid colliding with the platform
 * `SpeechRecognizer` classes the implementations wrap.
 */

/** A listening session request. */
@Serializable
data class SpeechListenRequest(
    val locale: String = "en-US",
    val partialResults: Boolean = true,
)

/** Receives transcripts and session errors. */
interface SpeechTranscriptListener {
    fun onPartialTranscript(text: String) {}

    fun onFinalTranscript(text: String)

    fun onError(code: String)
}

/**
 * Session error codes (amaru's label set). Platform implementations map
 * their native error values onto these; unknown values follow the
 * `unknown_error_<native code>` pattern.
 */
object SpeechErrorCode {
    const val AUDIO_ERROR = "audio_error"
    const val CLIENT_ERROR = "client_error"
    const val PERMISSION_DENIED = "permission_denied"
    const val NETWORK_ERROR = "network_error"
    const val NETWORK_TIMEOUT = "network_timeout"
    const val NO_MATCH = "no_match"
    const val RECOGNIZER_BUSY = "recognizer_busy"
    const val SERVER_ERROR = "server_error"
    const val SPEECH_TIMEOUT = "speech_timeout"

    fun unknown(nativeCode: Int): String = "unknown_error_$nativeCode"
}

/** Platform seam: speech-to-text over the device recognizer. */
interface SpeechTranscriber {
    fun isAvailable(): Boolean

    fun startListening(
        request: SpeechListenRequest = SpeechListenRequest(),
        listener: SpeechTranscriptListener,
    )

    fun stopListening()

    /** Releases the underlying recognizer; the instance is done after this. */
    fun destroy()
}
