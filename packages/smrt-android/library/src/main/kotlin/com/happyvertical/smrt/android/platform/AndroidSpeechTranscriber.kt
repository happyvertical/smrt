package com.happyvertical.smrt.android.platform

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.happyvertical.smrt.mobile.platform.SpeechErrorCode
import com.happyvertical.smrt.mobile.platform.SpeechListenRequest
import com.happyvertical.smrt.mobile.platform.SpeechTranscriber
import com.happyvertical.smrt.mobile.platform.SpeechTranscriptListener

/**
 * `android.speech.SpeechRecognizer` implementation of the shared
 * [SpeechTranscriber] seam, ported from amaru's
 * `AndroidFieldOpsSpeechRecognizer` (ADR 0001 Phase 5). Must be driven from
 * the main thread (a platform recognizer requirement). Requires
 * `android.permission.RECORD_AUDIO`.
 */
class AndroidSpeechTranscriber(private val context: Context) : SpeechTranscriber {
    private val recognizer: SpeechRecognizer by lazy {
        SpeechRecognizer.createSpeechRecognizer(context)
    }

    override fun isAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    override fun startListening(request: SpeechListenRequest, listener: SpeechTranscriptListener) {
        recognizer.cancel()
        recognizer.setRecognitionListener(
            object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit

                override fun onPartialResults(partialResults: Bundle?) {
                    firstTranscript(partialResults)?.let(listener::onPartialTranscript)
                }

                override fun onResults(results: Bundle?) {
                    firstTranscript(results)?.let(listener::onFinalTranscript)
                        ?: listener.onError(SpeechErrorCode.NO_MATCH)
                }

                override fun onError(error: Int) {
                    listener.onError(speechErrorLabel(error))
                }
            },
        )
        recognizer.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, request.locale)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, request.partialResults)
            },
        )
    }

    override fun stopListening() {
        recognizer.stopListening()
    }

    override fun destroy() {
        recognizer.destroy()
    }
}

private fun firstTranscript(bundle: Bundle?): String? =
    bundle
        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        ?.firstOrNull()
        ?.takeIf { transcript -> transcript.isNotBlank() }

/** Platform recognizer error int → shared [SpeechErrorCode] label. */
internal fun speechErrorLabel(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_AUDIO -> SpeechErrorCode.AUDIO_ERROR
    SpeechRecognizer.ERROR_CLIENT -> SpeechErrorCode.CLIENT_ERROR
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> SpeechErrorCode.PERMISSION_DENIED
    SpeechRecognizer.ERROR_NETWORK -> SpeechErrorCode.NETWORK_ERROR
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> SpeechErrorCode.NETWORK_TIMEOUT
    SpeechRecognizer.ERROR_NO_MATCH -> SpeechErrorCode.NO_MATCH
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> SpeechErrorCode.RECOGNIZER_BUSY
    SpeechRecognizer.ERROR_SERVER -> SpeechErrorCode.SERVER_ERROR
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> SpeechErrorCode.SPEECH_TIMEOUT
    else -> SpeechErrorCode.unknown(error)
}
