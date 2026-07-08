import Foundation
import SmrtMobile

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Foundation Models (Apple Intelligence, iOS 26+) implementation of the shared
/// `OnDeviceLanguageModel` seam.
///
/// **Deliberate deviation from the amaru seed** (and the exact mirror of
/// `GeminiNanoLanguageModel`'s rationale): amaru's `FieldOpsTalkBridge` folded the
/// app's API fallback into the adapter's answers — it collapsed *every* unavailable
/// reason into `api_fallback_available`. This adapter reports **on-device truth
/// only** — `model_not_ready` while the model prepares, `hidden_unavailable` when
/// the device isn't eligible or Apple Intelligence is off — and **never emits
/// `api_fallback_available`**. Apps that carry a server-side fallback map those
/// states onto `api_fallback_available` in their own availability policy.
///
/// Prompt building and output parsing stay app-side (amaru's Talk action vocabulary
/// is app domain); this seam is availability + `generate(prompt) → raw text`.
public final class FoundationModelsLanguageModel: NSObject, OnDeviceLanguageModel {
    private let lock = NSLock()
    private var cached: LanguageModelAvailability

    public override init() {
        cached = Self.hidden(reason: "foundation_models_not_checked")
        super.init()
    }

    public func currentAvailability() -> LanguageModelAvailability {
        lock.lock()
        defer { lock.unlock() }
        return cached
    }

    public func checkAvailability() async throws -> LanguageModelAvailability {
        let availability = Self.availability(for: Self.resolveKind())
        lock.lock()
        cached = availability
        lock.unlock()
        return availability
    }

    /// Runs on-device interpretation and returns the raw model output. Only call
    /// once `checkAvailability()` reports `available`; callers build the prompt
    /// and parse the result. Throws on any failure (empty output included).
    public func generate(prompt: String) async throws -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            do {
                let session = LanguageModelSession()
                let response = try await session.respond(to: prompt)
                let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { throw LanguageModelError.emptyOutput }
                return text
            } catch let error as LanguageModelError {
                throw error
            } catch {
                throw LanguageModelError.generationFailed
            }
        }
        #endif
        throw LanguageModelError.unavailable
    }

    // MARK: - Pure, testable availability mapping (on-device truth only)

    /// On-device availability, decoupled from the FoundationModels enum so the
    /// mapping is testable without iOS 26. Never includes an API-fallback state.
    enum AvailabilityKind: Equatable {
        case available
        case modelNotReady
        case deviceNotEligible
        case appleIntelligenceNotEnabled
        case unsupportedOS
    }

    static func availability(for kind: AvailabilityKind) -> LanguageModelAvailability {
        switch kind {
        case .available:
            return LanguageModelAvailability(
                status: LanguageModelAvailabilityStatus.shared.AVAILABLE,
                provider: LanguageModelProvider.shared.IOS_FOUNDATION_MODELS,
                modelName: "SystemLanguageModel",
                reason: ""
            )
        case .modelNotReady:
            return LanguageModelAvailability(
                status: LanguageModelAvailabilityStatus.shared.MODEL_NOT_READY,
                provider: LanguageModelProvider.shared.IOS_FOUNDATION_MODELS,
                modelName: "SystemLanguageModel",
                reason: "foundation_models_not_ready"
            )
        case .deviceNotEligible:
            return hidden(reason: "foundation_models_device_not_eligible")
        case .appleIntelligenceNotEnabled:
            return hidden(reason: "foundation_models_not_enabled")
        case .unsupportedOS:
            return hidden(reason: "foundation_models_unavailable_os")
        }
    }

    private static func hidden(reason: String) -> LanguageModelAvailability {
        LanguageModelAvailability(
            status: LanguageModelAvailabilityStatus.shared.HIDDEN_UNAVAILABLE,
            provider: "",
            modelName: "",
            reason: reason
        )
    }

    private static func resolveKind() -> AvailabilityKind {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return .available
            case .unavailable(let reason):
                switch reason {
                case .modelNotReady:
                    return .modelNotReady
                case .deviceNotEligible:
                    return .deviceNotEligible
                case .appleIntelligenceNotEnabled:
                    return .appleIntelligenceNotEnabled
                @unknown default:
                    return .deviceNotEligible
                }
            @unknown default:
                return .deviceNotEligible
            }
        }
        #endif
        return .unsupportedOS
    }

    enum LanguageModelError: Error, Equatable {
        case unavailable
        case emptyOutput
        case generationFailed
    }
}
