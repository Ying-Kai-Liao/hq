import Foundation

/// Runs a process-wide setup once and hands every later caller the first result, so a second owner
/// (a re-created session, a background launch) can't configure the same SDK twice.
@MainActor
public final class ConfigureOnce<Value> {
    private var value: Value?
    public init() {}

    public func get(_ make: () -> Value?) -> Value? {
        if let value { return value }
        value = make()
        return value
    }
}
