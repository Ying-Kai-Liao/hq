import CodyncKit
import CodyncUI
import SwiftUI

extension BotStore {
    /// One short line for a computer's connection, used next to its name.
    var statusText: String {
        switch connection {
        case .online: "Online"
        case .connecting: "Connecting…"
        case let .computerOffline(lastSeen): lastSeen.map { "Offline · seen \(RelativeTime.day($0))" } ?? "Offline"
        case .offline: "Can't reach"
        case .unauthorized: "No access"
        case .unpaired: "Not paired"
        }
    }
}

/// How the phone reaches a computer right now: a subtle icon, direct Wi-Fi/LAN or the encrypted relay.
struct RouteIcon: View {
    let route: HostRoute?

    var body: some View {
        switch route {
        case .direct:
            Image(systemName: "wifi").accessibilityLabel("Wi-Fi or Tailscale")
        case .relay:
            Image(systemName: "cloud").accessibilityLabel("Through Cloudflare")
        case .loopback, nil:
            EmptyView()
        }
    }
}
