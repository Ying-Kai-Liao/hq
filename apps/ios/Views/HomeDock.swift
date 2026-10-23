import KithKit
import KithUI
import SwiftUI
import UIKit

/// What the dock's "pick an agent" sheet is for.
enum AgentPick: Identifiable {
    /// Start a new session with the agent and send what was typed (and attached).
    case send
    /// Call the agent.
    case call

    var id: Self { self }
    var title: String { self == .send ? "Pick an agent" : "Call an agent" }
}

/// A list of agents (not groups) to choose from, in the order Crew shows them.
struct PickAgentSheet: View {
    struct Choice: Identifiable {
        let model: CrewRowModel
        let pick: () -> Void
        var id: String { model.id }
    }

    let title: String
    let choices: [Choice]
    @Environment(\.dismissModal) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ModalHeader(title)
            if choices.isEmpty {
                EmptyState(title: "No agents yet", systemImage: "person.crop.circle.badge.plus",
                           message: "Create a bot from the new-chat button first.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(choices) { choice in
                            Button {
                                dismiss()
                                choice.pick()
                            } label: {
                                CrewRow(choice.model)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .background(Palette.background)
    }
}

/// The system camera, for the dock's +: one photo, handed back as JPEG data.
struct CameraPicker: UIViewControllerRepresentable {
    let picked: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85) {
                parent.picked(data)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// The glass pill in the middle of the top bar while Board is not built yet: Crew alone, in the switch's look.
struct CrewOnlyPill: View {
    var body: some View {
        Text("Crew")
            .kithText(.topBar)
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, 20)
            .frame(minHeight: KithSize.topButton - 6)
            .background(Capsule().fill(Palette.ink.opacity(0.09)))
            .padding(3)
            .frame(minHeight: KithSize.topButton)
            .kithGlass(in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Crew"))
            .accessibilityAddTraits(.isHeader)
    }
}
