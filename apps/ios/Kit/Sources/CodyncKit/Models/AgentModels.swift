import Foundation

/// Model identifiers and display names advertised by the selected computer's ACP agent.
public struct AgentModels: Decodable, Sendable {
    public struct Model: Decodable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let description: String?
    }

    public let models: [Model]
    public let currentModelId: String?
}
