import Foundation

/// A long-form memory file: a Markdown note on one topic, as the host last recorded it.
public struct MemoryFile: Decodable, Identifiable, Hashable, Sendable {
    /// The bot whose folder holds it; nil for what all bots share.
    public var bot: String?
    public var name: String
    /// SHA-256 of what it holds; a save is made over it.
    public var hash: String
    public var description: String?
    public var tokens: Int
    public var deleted: Bool
    public var updatedAt: Int64

    public var id: String { name }
}

/// One layer's folder of files.
public struct MemoryFolder: Decodable, Hashable, Sendable {
    public var files: [MemoryFile]
    /// Where it is on the computer.
    public var folder: String
}

/// Both layers' files, with the caps the host marks.
public struct MemoryFiles: Decodable, Hashable, Sendable {
    public var yours: MemoryFolder
    public var bot: MemoryFolder
    /// Tokens one file may hold.
    public var cap: Int
    /// Files one folder may hold.
    public var folderCap: Int
}

/// One version of a file: who made it, why, and what it held then.
public struct MemoryFileVersion: Decodable, Identifiable, Hashable, Sendable {
    public var id: Int64
    /// nil: the file was deleted.
    public var content: String?
    /// user · bot · dream · computer
    public var author: String
    public var authorBot: String?
    /// edit · delete · restore · undo · dream
    public var cause: String
    public var at: Int64
}

/// A file as it is on disk now, with its recent versions.
public struct MemoryFileDetail: Decodable, Hashable, Sendable {
    public var file: String
    public var shared: Bool
    /// nil when the file is gone.
    public var content: String?
    /// The hash to save over; nil when the file is gone.
    public var hash: String?
    public var path: String
    public var versions: [MemoryFileVersion]
}

/// A bot's change to a memory file in the chat. Every field is optional so a newer host's card still decodes.
public struct MemoryFileCard: Codable, Hashable, Sendable {
    public var file: String?
    public var shared: Bool?
    /// done · pending · accepted · declined · undone · restored · failed
    public var status: String?
    /// `- ` removed and `+ ` added lines.
    public var diff: String?
    public var created: Bool?
    public var deleted: Bool?
    /// The change removes more than a quarter of the file.
    public var big: Bool?
    /// Why it was put back, or couldn't be made.
    public var reason: String?

    /// What the user can do with it now, as with a memory entry's card.
    public var choice: MemoryWrite.Choice? {
        switch status {
        case "pending": .answer
        case "done", "accepted": .undo
        default: nil
        }
    }
}

extension HostClient {
    public func memoryFile(botId: String, file: String, shared: Bool) async throws -> MemoryFileDetail {
        struct Body: Encodable { var botId: String; var file: String; var shared: Bool }
        return try await call("memoryFile", Body(botId: botId, file: file, shared: shared))
    }

    /// Saves (`content`), deletes (`content` and `version` nil) or brings back a version of a file, over the content
    /// whose hash is `base` (nil: a new file).
    public func changeMemoryFile(botId: String, file: String, shared: Bool, base: String?, content: String? = nil,
                                 version: Int64? = nil) async throws {
        struct Body: Encodable {
            var botId: String; var file: String; var shared: Bool; var base: String?; var content: String?; var version: Int64?
        }
        let method = version != nil ? "restoreMemoryFile" : content != nil ? "saveMemoryFile" : "deleteMemoryFile"
        let _: Empty = try await call(method, Body(botId: botId, file: file, shared: shared, base: base, content: content, version: version))
    }
}
