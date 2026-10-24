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
                EmptyState(title: "No agents to pick", systemImage: "person.crop.circle.badge.plus",
                           message: "Group rooms can't be called or started from here. Open one from Crew, or create an agent from the new-chat button.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(choices) { choice in
                            Button {
                                dismiss()
                                // The sheet has to be gone before a chat or a call rises.
                                Task {
                                    try? await Task.sleep(for: .milliseconds(450))
                                    choice.pick()
                                }
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
