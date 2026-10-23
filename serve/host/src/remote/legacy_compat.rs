//! Pre-rename compatibility: delete after every device paired before the Kith rename has been re-paired and
//! every host and app has moved past PR #38. This is the only place the old wire names are spelled; everything
//! else says `Labels::Legacy`.

/// Domain-separation family of those pairings (`<family>/hs1/v1`, `<family>-sig-v1`, `<family>/claim/v1`, …).
/// Also the name stored beside a pairing and announced in pairing links.
pub const LABEL: &str = "codync";

/// The request-signature header they send.
pub const SIG_HEADER: &str = "Codync-Sig";
