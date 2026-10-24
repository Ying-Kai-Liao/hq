//! Phone/host compatibility (docs/reference/compatibility.md). Each side names the oldest
//! protocol level of the other it still works with: the host sends `protocol` and
//! `minProtocol` in `hello`; clients keep their own oldest-host level (`MIN_HOST_PROTOCOL` here
//! for the terminal client). Product versions are for people, never compared for compatibility,
//! except toward hosts from before the protocol level (their `hello` has no `protocol`).

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

/// Toward a host from before the protocol level (no `protocol` in its `hello`): the oldest of
/// those versions the clients still work with. Those hosts numbered their releases 2.x.
pub const LEGACY_MIN_HOST: &str = "2.12.0";

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
    /// The host is below the client's floor; `version` is what it reports.
    UpdateHost { version: String },
}

/// `major.minor.patch`, ignoring a leading `v` and any pre-release or build suffix; missing
/// parts count as 0. `None` for anything else, which never blocks a connection.
pub fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let mut next = |required: bool| match parts.next() {
        Some(p) => p.parse::<u64>().ok(),
        None if required => None,
        None => Some(0),
    };
    let v = (next(true)?, next(false)?, next(false)?);
    parts.next().is_none().then_some(v)
}

/// Whether `version` is below `minimum`; unreadable versions never are.
pub fn below(version: &str, minimum: &str) -> bool {
    matches!((parse(version), parse(minimum)), (Some(v), Some(m)) if v < m)
}

/// Checks a client on protocol `client` with floor `min_host` against a host's `hello`.
/// A host without `protocol` predates it: only its version is checked, against
/// `LEGACY_MIN_HOST` (any client with a protocol level is newer than its `minApp`).
pub fn check(client: u64, min_host: u64, hello: &Value) -> Option<Mismatch> {
    let version = hello["version"].as_str().unwrap_or_default();
    let host_too_old = match hello["protocol"].as_u64() {
        Some(protocol) => {
            if hello["minProtocol"].as_u64().is_some_and(|min| client < min) {
                return Some(Mismatch::UpdateApp);
            }
            protocol < min_host
        }
        None => below(version, LEGACY_MIN_HOST),
    };
    host_too_old.then(|| Mismatch::UpdateHost { version: version.to_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_legacy_floor_is_a_version() {
        assert!(parse(LEGACY_MIN_HOST).is_some());
    }

    #[test]
    fn parses_leniently() {
        assert_eq!(parse("2.4.1"), Some((2, 4, 1)));
        assert_eq!(parse(" v2.4 "), Some((2, 4, 0)));
        assert_eq!(parse("3"), Some((3, 0, 0)));
        assert_eq!(parse("2.4.0-beta.1+77"), Some((2, 4, 0)));
        assert_eq!(parse("2.10.0").cmp(&parse("2.9.9")), std::cmp::Ordering::Greater);
        for bad in ["", "abc", "2.x", "2.4.0.1", "-1.0.0", "2..0"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn unreadable_versions_never_block() {
        assert!(!below("", "2.4.0"));
        assert!(!below("2.0.0", "garbage"));
        assert!(below("2.3.9", "2.4.0"));
        assert!(!below("2.4.0", "2.4.0"));
        assert!(!below("2.4.0-dev", "2.4.0"));
    }

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
        assert_eq!(check(2, 2, &host("0.1.0", 1, 1)), Some(Mismatch::UpdateHost { version: "0.1.0".into() }));
        // A host before the protocol level: its version against the old floor; its `minApp`
        // names a version on the old numbering, which every client with a level is past.
        assert_eq!(check(1, 1, &json!({"version": "2.20.0", "minApp": "2.18.0"})), None);
        assert_eq!(
            check(1, 1, &json!({"version": "2.11.3", "minApp": "2.3.0"})),
            Some(Mismatch::UpdateHost { version: "2.11.3".into() })
        );
        // A hello without a version can't be judged.
        assert_eq!(check(1, 1, &json!({})), None);
    }
}
