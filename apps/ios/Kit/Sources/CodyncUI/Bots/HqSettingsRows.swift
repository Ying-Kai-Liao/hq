import CodyncKit
import SwiftUI

/// An hq bot's permission, model, effort and Fast mode, once. hq holds them: the permission is written through to hq
/// and shown as hq reports it; the others hq has no setting for, so they are read-only and say "Set in Kith".
struct HqSettingsRows: View {
    let store: KithInfoStore

    var body: some View {
        ForEach(HqSetting.rows(store.info), id: \.key) { row in
            ValueRow(row.label, detail: row.hint) {
                if row.editable {
                    ChoicePicker(
                        selection: Binding(
                            get: { row.value },
                            set: { mode in
                                guard mode != row.value else { return }
                                Task { await store.setPermission(mode) }
                            }),
                        options: options(including: row.value))
                } else {
                    Text(row.value).foregroundStyle(Palette.secondary).lineLimit(1)
                }
            }
        }
        if let error = store.permissionError {
            Text("Permission not changed: \(error)").font(.footnote).foregroundStyle(Palette.danger)
        }
    }

    /// hq's modes, plus the current one when this app doesn't know it.
    private func options(including current: String) -> [(id: String, label: String)] {
        let known = HqSetting.permissionModes
        return known.contains { $0.id == current } ? known : known + [(id: current, label: HqSetting.permissionLabel(current))]
    }
}
