import KithKit
import KithUI
import SwiftUI

/// Equal access to every account provider at every sign-in entry point.
struct SignInButtons: View {
    @Environment(AccountSession.self) private var account
    /// Apple sign-in hidden until it works.
    private let showsAppleSignIn = false

    var body: some View {
        VStack(spacing: 10) {
            if showsAppleSignIn {
            Button { Task { await account.signIn(provider: .apple) } } label: {
                ZStack {
                    HStack(spacing: 10) {
                        Image(systemName: "apple.logo").font(.system(size: 20))
                        Text("Continue with Apple")
                    }
                    .opacity(account.isBusy ? 0 : 1)
                    if account.isBusy { Spinner(size: 18) }
                }
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.primary)
            .disabled(account.isBusy)
            .animation(Motion.fade, value: account.isBusy)
            }
            GoogleSignInButton()
            GitHubSignInButton()
        }
    }
}
