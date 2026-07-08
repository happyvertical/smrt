import AuthenticationServices
import Foundation
import SmrtMobile
import UIKit

/// `ASWebAuthenticationSession` implementation of smrt-mobile's
/// `ExternalAuthLauncher` seam: opens the PKCE authorization URL, then routes the
/// captured redirect back to `MobileSessionManager.handleRedirect`.
///
/// The Kotlin seam is fire-and-forget (`launch(authorizationUrl:)` returns void);
/// the redirect is delivered through the injected `onRedirect` callback, which the
/// app wires to `Task { try await sessionManager.handleRedirect(url:) }`.
public final class WebAuthSessionLauncher: NSObject, ExternalAuthLauncher,
    ASWebAuthenticationPresentationContextProviding {

    private let callbackURLScheme: String
    private let onRedirect: (String) -> Void
    private var session: ASWebAuthenticationSession?

    public init(callbackURLScheme: String, onRedirect: @escaping (String) -> Void) {
        self.callbackURLScheme = callbackURLScheme
        self.onRedirect = onRedirect
    }

    public func launch(authorizationUrl: String) {
        guard let url = URL(string: authorizationUrl) else { return }
        // ASWebAuthenticationSession must start on the main thread; the seam may
        // be invoked from a Kotlin coroutine dispatcher.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: self.callbackURLScheme
            ) { [weak self] callbackURL, _ in
                if let callbackURL {
                    self?.onRedirect(callbackURL.absoluteString)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            session.start()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // The system invokes this on the main thread; UIApplication is @MainActor.
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            return scene?.keyWindow ?? ASPresentationAnchor()
        }
    }
}
