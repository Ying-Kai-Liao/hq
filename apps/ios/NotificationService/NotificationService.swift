import CodyncKit
import UserNotifications
import os

/// APNs and the push relay carry generic fallback text; the private title and text arrive
/// sealed to this account's push key (spec §6.7). Opening them is local work only: no network.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let info = request.content.userInfo
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let sealed = info["sealed"] as? String,
              let computerId = info["computerId"] as? String,
              let ctx = info["ctx"] as? String,
              let alert = DeviceIdentity.openPush(sealed: sealed, computerId: computerId, contextID: ctx) else {
            Logger(subsystem: "com.pokai.Codync.ios", category: "NotificationService")
                .error("Showing notification fallback: sealed content or shared key unavailable")
            contentHandler(request.content)
            return
        }
        content.title = alert.title
        content.subtitle = alert.subtitle ?? ""
        content.body = alert.body
        contentHandler(content)
    }
}
