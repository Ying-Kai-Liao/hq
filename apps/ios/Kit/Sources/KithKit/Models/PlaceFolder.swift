import Foundation

// The folder a place (a bot's chat, a thread or task, a group lane) works in, and the host calls around it.
// See serve/docs/place-folders.md. Every field a host might lack is optional.

/// Where a place works. `kind`: `project`, `folder`, or `workspace` (nothing picked).
public struct PlaceFolder: Codable, Hashable, Sendable {
    public var kind: String
    public var project: String?
    /// Where the agent works; nil while a project's folder isn't known yet.
    public var path: String?
    public var name: String
    /// The place has no pick of its own.
    public var inherited: Bool
    /// The project has no folder on this computer, or the folder is gone: the agent works in the bot's folder.
    public var missing: Bool

    public init(kind: String, project: String? = nil, path: String? = nil, name: String, inherited: Bool = false, missing: Bool = false) {
        self.kind = kind
        self.project = project
        self.path = path
        self.name = name
        self.inherited = inherited
        self.missing = missing
    }

    private enum CodingKeys: String, CodingKey { case kind, project, path, name, inherited, missing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "workspace"
        project = try c.decodeIfPresent(String.self, forKey: .project)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        inherited = try c.decodeIfPresent(Bool.self, forKey: .inherited) ?? false
        missing = try c.decodeIfPresent(Bool.self, forKey: .missing) ?? false
    }

    /// SF Symbol for the chip.
    public var icon: String {
        switch kind {
        case "project": "shippingbox"
        case "folder": "folder"
        default: "tray"
        }
    }
}

/// One entry of hq's project registry.
public struct HQProject: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var path: String?
    public var paths: [String]
    public var parent: String?
    public var exists: Bool

    public init(id: String, path: String? = nil, paths: [String] = [], parent: String? = nil, exists: Bool = true) {
        self.id = id
        self.path = path
        self.paths = paths
        self.parent = parent
        self.exists = exists
    }

    private enum CodingKeys: String, CodingKey { case id, path, paths, parent, exists }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        paths = try c.decodeIfPresent([String].self, forKey: .paths) ?? []
        parent = try c.decodeIfPresent(String.self, forKey: .parent)
        exists = try c.decodeIfPresent(Bool.self, forKey: .exists) ?? true
    }
}

/// `projects`: hq's registry; `error` says why it is empty (hq missing or failing).
public struct ProjectList: Decodable, Sendable {
    public var projects: [HQProject]
    public var error: String?

    public init(projects: [HQProject] = [], error: String? = nil) {
        self.projects = projects
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case projects, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = try c.decodeIfPresent([HQProject].self, forKey: .projects) ?? []
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// A folder or project a place was set to recently.
public struct RecentFolder: Codable, Hashable, Sendable, Identifiable {
    public var path: String
    public var name: String
    public var project: String?
    public var id: String { path }
}

/// A drive or the home folder `listDirs` can start from.
public struct DirRoot: Codable, Hashable, Sendable, Identifiable {
    public var name: String
    public var path: String
    public var id: String { path }
}

/// What a client picks for a place: a registered project or a folder path.
public enum FolderChoice: Hashable, Sendable {
    case project(String)
    case folder(String)

    public var projectId: String? { if case .project(let id) = self { id } else { nil } }
    public var folderPath: String? { if case .folder(let path) = self { path } else { nil } }
}
