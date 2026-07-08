import AVFoundation
import Foundation
import SmrtMobile
import Speech

/// `SFSpeechRecognizer` implementation of the shared `SpeechTranscriber` seam
/// (the iOS counterpart of Android's `AndroidSpeechTranscriber`). Streams mic
/// audio through `SFSpeechAudioBufferRecognitionRequest`; recognizer/audio
/// failures map onto the shared `SpeechErrorCode` vocabulary via the pure,
/// unit-tested `speechErrorCode`. Requires `NSSpeechRecognitionUsageDescription`
/// and `NSMicrophoneUsageDescription`.
// NB: iOS 26's Speech framework introduced its own `SpeechTranscriber`; qualify
// the smrt-mobile seam to disambiguate.
public final class IOSSpeechTranscriber: NSObject, SmrtMobile.SpeechTranscriber {
    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var listener: SpeechTranscriptListener?

    public override init() { super.init() }

    public func isAvailable() -> Bool {
        SFSpeechRecognizer()?.isAvailable ?? false
    }

    public func startListening(request listenRequest: SpeechListenRequest, listener: SpeechTranscriptListener) {
        stopListening()
        self.listener = listener

        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted:
            listener.onError(code: Self.speechErrorCode(for: .permissionDenied))
            return
        default:
            break
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: listenRequest.locale)),
              recognizer.isAvailable else {
            listener.onError(code: Self.speechErrorCode(for: .recognizerUnavailable))
            return
        }
        self.recognizer = recognizer

        let audioRequest = SFSpeechAudioBufferRecognitionRequest()
        audioRequest.shouldReportPartialResults = listenRequest.partialResults
        self.request = audioRequest

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            listener.onError(code: Self.speechErrorCode(for: .audio))
            return
        }

        let inputNode = audioEngine.inputNode
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputNode.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            teardownAudio()
            listener.onError(code: Self.speechErrorCode(for: .audio))
            return
        }

        task = recognizer.recognitionTask(with: audioRequest) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    if text.isEmpty {
                        self.listener?.onError(code: SpeechErrorCode.shared.NO_MATCH)
                    } else {
                        self.listener?.onFinalTranscript(text: text)
                    }
                } else {
                    self.listener?.onPartialTranscript(text: text)
                }
            }
            if let error {
                self.listener?.onError(code: Self.speechErrorLabel(for: error as NSError))
                self.teardownAudio()
            }
        }
    }

    public func stopListening() {
        request?.endAudio()
        task?.finish()
        teardownAudio()
    }

    public func destroy() {
        stopListening()
        task?.cancel()
        task = nil
        recognizer = nil
        listener = nil
    }

    private func teardownAudio() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        request = nil
    }

    // MARK: - Pure, testable error mapping (shared SpeechErrorCode vocabulary)

    enum SpeechFailure: Equatable {
        case permissionDenied
        case recognizerUnavailable
        case noMatch
        case audio
        case cancelled
        case other(Int)
    }

    static func speechErrorCode(for failure: SpeechFailure) -> String {
        let code = SpeechErrorCode.shared
        switch failure {
        case .permissionDenied: return code.PERMISSION_DENIED
        case .recognizerUnavailable: return code.SERVER_ERROR
        case .noMatch: return code.NO_MATCH
        case .audio: return code.AUDIO_ERROR
        case .cancelled: return code.CLIENT_ERROR
        case .other(let native): return code.unknown(nativeCode: Int32(truncatingIfNeeded: native))
        }
    }

    static func speechErrorLabel(for error: NSError) -> String {
        if error.domain == "kAFAssistantErrorDomain" {
            switch error.code {
            case 203, 1110: return speechErrorCode(for: .noMatch)
            case 216, 301, 1: return speechErrorCode(for: .cancelled)
            default: return speechErrorCode(for: .other(error.code))
            }
        }
        return speechErrorCode(for: .other(error.code))
    }
}
