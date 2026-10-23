import KithKit
import Foundation
import Observation

/// What the People screens ask of a computer; `HostClient` answers it, a fake does in tests.
public protocol PeopleHost: Sendable {
    func people() async throws -> [HostPerson]
    func invites() async throws -> [HostInvite]
    func createInvite(name: String?, personId: String?, agents: [String: InviteRole]) async throws -> CreatedInvite
    func revokeInvite(_ inviteId: String) async throws
    func setPersonAccess(personId: String, agents: [String: InviteRole]?, projects: [String]?) async throws
    func revokePerson(_ personId: String) async throws
    func audit(since: Date?, personId: String?) async throws -> [AuditRow]
    func projectList() async throws -> [HQProject]
}

extension HostClient: PeopleHost {
    public func projectList() async throws -> [HQProject] { try await projects().projects }
}

/// The owner's view of the people invited to a computer: who they are, what they may use, what is pending.
@MainActor
@Observable
public final class PeopleStore {
    public private(set) var people: [HostPerson] = []
    public private(set) var invites: [HostInvite] = []
    public private(set) var audit: [AuditRow] = []
    public private(set) var projects: [HQProject] = []
    /// The computer's host doesn't know invites (older than #95): the People screens stay away.
    public private(set) var unsupported = false
    public private(set) var loaded = false
    /// A write is in flight: Create and the edit buttons wait, so a double tap makes one invite.
    public private(set) var busy = false
    public var error: String?

    private let host: @MainActor () -> (any PeopleHost)?

    public init(host: @escaping @MainActor () -> (any PeopleHost)?) {
        self.host = host
    }

    public convenience init(store: BotStore) {
        self.init(host: { [weak store] in store?.client })
    }

    /// Invites still waiting for the person.
    public var pending: [HostInvite] { invites.filter { $0.isOpen() } }

    public func person(_ id: String) -> HostPerson? { people.first { $0.personId == id } }

    private func note(_ error: Error) {
        if InviteProof.isUnknownMethod(error) {
            unsupported = true
        } else {
            self.error = error.localizedDescription
        }
    }

    public func load() async {
        guard let host = host() else { return }
        error = nil
        do {
            async let p = host.people()
            async let i = host.invites()
            let (people, invites) = try await (p, i)
            self.people = people
            self.invites = invites
            loaded = true
        } catch {
            note(error)
        }
    }

    public func loadProjects() async {
        guard projects.isEmpty, let host = host() else { return }
        // Only a convenience for the edit screen; a computer without projects just shows none.
        projects = (try? await host.projectList()) ?? []
    }

    public func loadAudit(personId: String? = nil) async {
        guard let host = host() else { return }
        error = nil
        do {
            audit = try await host.audit(since: nil, personId: personId)
        } catch {
            note(error)
        }
    }

    /// Makes an invite for a new person (`name`) or one already invited (`personId`). Nil when it failed (see `error`)
    /// or while another write is still running.
    public func createInvite(name: String?, personId: String?, agents: [String: InviteRole]) async -> CreatedInvite? {
        guard !busy, let host = host() else { return nil }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let made = try await host.createInvite(name: name, personId: personId, agents: agents)
            await load()
            return made
        } catch {
            note(error)
            return nil
        }
    }

    public func revokeInvite(_ id: String) async {
        await write { try await $0.revokeInvite(id) }
    }

    public func setAccess(_ personId: String, agents: [String: InviteRole], projects: [String]) async -> Bool {
        await write { try await $0.setPersonAccess(personId: personId, agents: agents, projects: projects) }
    }

    /// Ends their access. Their chats and memory stay on the computer.
    public func remove(_ personId: String) async -> Bool {
        await write { try await $0.revokePerson(personId) }
    }

    @discardableResult
    private func write(_ call: (any PeopleHost) async throws -> Void) async -> Bool {
        guard !busy, let host = host() else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await call(host)
            await load()
            return true
        } catch {
            note(error)
            return false
        }
    }
}
