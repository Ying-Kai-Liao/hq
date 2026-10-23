import KithKit
import SwiftUI

/// Files picked on Crew's dock, prepared exactly as the chat composer prepares them, so they go out with the first
/// message of a new session.
public enum HomeAttachments {
    public static func files(from urls: [URL]) -> [OutgoingFile] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return (try? Data(contentsOf: url, options: .mappedIfSafe)).map { OutgoingFile.prepared(name: url.lastPathComponent, data: $0) }
        }
    }

    /// Photos go out as JPEG: HEIC isn't something every agent can read.
    public static func photos(_ images: [Data]) -> [OutgoingFile] {
        let stamp = Int(Date.now.timeIntervalSince1970)
        return images.enumerated().compactMap { i, data in
            ImageData.jpeg(data).map { OutgoingFile(name: "photo-\(stamp)-\(i + 1).jpg", data: $0) }
        }
    }

    /// Files over the limit are left out; the second value is what to tell the person.
    public static func accepted(_ files: [OutgoingFile]) -> (files: [OutgoingFile], error: String?) {
        var error: String?
        let ok = files.filter { file in
            let fits = file.data.count <= OutgoingFile.maxSize
            if !fits { error = "\(file.name) is larger than 100 MB." }
            return fits
        }
        return (ok, error)
    }
}

/// The picked files above the dock's box, each with its remove button.
public struct HomeAttachmentChips: View {
    let files: [OutgoingFile]
    let remove: (OutgoingFile) -> Void

    public init(files: [OutgoingFile], remove: @escaping (OutgoingFile) -> Void) {
        self.files = files
        self.remove = remove
    }

    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(files) { file in ComposerAttachment(file: file) { remove(file) } }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
        }
    }
}
