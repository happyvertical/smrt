import SwiftUI
import SmrtMobile

/// SwiftUI observation bridge for a shared KMP `MobileStateHolder`.
///
/// Shared presenters expose their holder from Kotlin. SwiftUI owns this adapter
/// as a `@StateObject`/`@ObservedObject` and reads `value`; the adapter closes
/// the Kotlin subscription when it deinitializes.
@MainActor
public final class MobileObservableState<State: AnyObject>: ObservableObject {
    private let holder: MobileStateHolder<State>
    private var observer: MobileObservableStateObserver<State>?
    private var subscription: MobileStateSubscription?

    @Published public private(set) var value: State

    public init(holder: MobileStateHolder<State>, emitCurrent: Bool = true) {
        self.holder = holder
        self.value = holder.value

        let observer = MobileObservableStateObserver<State> { [weak self] next in
            self?.value = next
        }
        self.observer = observer
        self.subscription = holder.observe(observer: observer, emitCurrent: emitCurrent)
    }

    public func refreshFromHolder() {
        value = holder.value
    }

    public func close() {
        subscription?.close()
        subscription = nil
        observer = nil
    }

    deinit {
        subscription?.close()
    }
}

private final class MobileObservableStateObserver<State: AnyObject>: NSObject, MobileStateObserver {
    private let publish: @MainActor (State) -> Void

    init(publish: @escaping @MainActor (State) -> Void) {
        self.publish = publish
    }

    func onState(value: Any?) {
        guard let state = value as? State else { return }
        Task { @MainActor in
            self.publish(state)
        }
    }
}
