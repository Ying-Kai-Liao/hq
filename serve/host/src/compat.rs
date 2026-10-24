//! Phone/host compatibility (docs/reference/compatibility.md). Each side names the oldest
//! protocol level of the other it still works with: the host sends `protocol` and
//! `minProtocol` in `hello`; clients keep their own oldest-host level (`MIN_HOST_PROTOCOL` here
//! for the terminal client). Product versions are for people, never compared for compatibility;
//! a host from before the protocol level (its `hello` has no `protocol`) is level 0.

use serde_json::Value;

/// This host's protocol level (`protocol` in `hello`). Raise it when the host starts sending or
/// accepting something a client checks for; clients gate on it instead of on the version.
pub const PROTOCOL: u64 = 1;

/// The oldest client protocol level (iPhone, desktop app, terminal client) this host still
/// serves (`minProtocol` in `hello`). Raise it only after clients on that level are out, and
/// only when this host stops sending or accepting something older clients depend on.
pub const MIN_PROTOCOL: u64 = 1;

/// The oldest host protocol level the terminal client works with.
pub const MIN_HOST_PROTOCOL: u64 = 1;

// A floor above the level that ships it would lock out even matching builds.
const _: () = assert!(MIN_PROTOCOL <= PROTOCOL && MIN_HOST_PROTOCOL <= PROTOCOL);

/// Whether installing a release that serves clients from `new_min` up would lock out iPhones.
#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    Proceed,
    /// Paired iPhones may run an app below `required`; Kith's iPhone app isn't in the App
    /// Store, so nothing here can tell when they have one.
    WaitForApp {
        required: u64,
    },
}

/// Decides a host update: only a release that raises `minProtocol`, on a computer with
/// iPhones, waits. Going ahead on a guess is what this gate exists to prevent; a person can
/// still choose to (`--skip-app-check`).
pub fn gate(current_min: u64, new_min: u64, iphones: bool) -> Gate {
    if new_min <= current_min || !iphones { Gate::Proceed } else { Gate::WaitForApp { required: new_min } }
}

/// Which side has to update before a client and a host can work together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mismatch {
    /// The client is below the host's `minProtocol`.
    UpdateApp,
    /// The host is below the client's floor.
    UpdateHost,
}

/// Checks a client on protocol `client` with floor `min_host` against a host's `hello`, by
/// protocol level alone. A host without `protocol` is level 0; a missing `minProtocol` is no
/// floor on the client.
pub fn check(client: u64, min_host: u64, hello: &Value) -> Option<Mismatch> {
    if hello["minProtocol"].as_u64().is_some_and(|min| client < min) {
        return Some(Mismatch::UpdateApp);
    }
    (hello["protocol"].as_u64().unwrap_or(0) < min_host).then_some(Mismatch::UpdateHost)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_updates_wait_for_the_iphone_app_only_when_needed() {
        // Same floor, or no iPhone here: nothing to wait for.
        assert_eq!(gate(1, 1, true), Gate::Proceed);
        assert_eq!(gate(1, 2, false), Gate::Proceed);
        // A raised floor waits while iPhones are paired.
        assert_eq!(gate(1, 2, true), Gate::WaitForApp { required: 2 });
    }

    #[test]
    fn decides_which_side_updates() {
        let host = |version: &str, protocol: u64, min: u64| json!({"version": version, "protocol": protocol, "minProtocol": min});
        assert_eq!(check(1, 1, &host("0.1.0", 1, 1)), None);
        assert_eq!(check(1, 1, &host("0.4.0", 3, 2)), Some(Mismatch::UpdateApp));
        assert_eq!(check(2, 2, &host("0.1.0", 1, 1)), Some(Mismatch::UpdateHost));
        // A missing `minProtocol` is no floor on the client.
        assert_eq!(check(1, 1, &json!({"version": "0.1.0", "protocol": 1})), None);
    }

    #[test]
    fn a_host_without_a_protocol_level_is_level_zero() {
        // Whatever its version or `minApp` (both on the old numbering), it needs an update.
        assert_eq!(check(1, 1, &json!({"version": "2.20.0", "minApp": "2.18.0"})), Some(Mismatch::UpdateHost));
        assert_eq!(check(1, 1, &json!({})), Some(Mismatch::UpdateHost));
        assert_eq!(check(1, 0, &json!({"version": "2.20.0"})), None);
    }
}
