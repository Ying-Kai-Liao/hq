//! Helper protocol types: displays, helper status and input events, plus key-combo parsing.

use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};

/// Long edge of screenshots handed to agents: sharp enough to read UI text,
/// small enough to keep every turn cheap.
pub const SHOT_MAX_EDGE: f64 = 1280.0;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    /// Size in points (the coordinate space of [`InputEvent`]).
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub main: bool,
}

impl Display {
    /// Screenshot scale: points → agent image pixels.
    pub(super) fn shot_scale(&self) -> f64 {
        (SHOT_MAX_EDGE / self.width.max(self.height)).min(1.0)
    }

    /// Agent image size for this display.
    pub(super) fn shot_size(&self) -> (u32, u32) {
        let s = self.shot_scale();
        // Display sizes are a few thousand points: always in range.
        #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        ((self.width * s).round() as u32, (self.height * s).round() as u32)
    }

    /// Agent image pixels → display points, rejecting points off the image.
    pub(super) fn to_points(&self, x: f64, y: f64) -> Result<(f64, f64)> {
        let (width, height) = self.shot_size();
        if !(0.0..=f64::from(width)).contains(&x) || !(0.0..=f64::from(height)).contains(&y) {
            bail!("({x}, {y}) is outside the {width}×{height} screenshot");
        }
        // Per axis: the image size is rounded, so its aspect differs slightly from the display's.
        Ok((x * self.width / f64::from(width), y * self.height / f64::from(height)))
    }
}

/// What the helper reports about itself.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub displays: Vec<Display>,
    /// Screen capture is permitted.
    #[serde(default)]
    pub capture: bool,
    /// Input injection (and the accessibility tree) is permitted.
    #[serde(default)]
    pub input: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    /// ⌘ on macOS, Super on Linux.
    Cmd,
    Option,
    Ctrl,
    Shift,
}

/// One input action for the helper, in display points.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum InputEvent {
    Move {
        x: f64,
        y: f64,
    },
    Click {
        x: f64,
        y: f64,
        button: Button,
        count: u8,
        modifiers: Vec<Modifier>,
    },
    Drag {
        x: f64,
        y: f64,
        to_x: f64,
        to_y: f64,
    },
    /// Scroll by `dx`/`dy` lines (positive = right/down) with the pointer at `x`,`y`.
    Scroll {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    Text {
        text: String,
    },
    Key {
        key: String,
        modifiers: Vec<Modifier>,
    },
}

/// Named keys the helpers understand; any other key is a single character.
const NAMED_KEYS: &[&str] = &[
    "return",
    "tab",
    "space",
    "escape",
    "delete",
    "forwardDelete",
    "left",
    "right",
    "up",
    "down",
    "home",
    "end",
    "pageUp",
    "pageDown",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
];

/// Modifier names with common aliases, deduplicated.
pub(super) fn parse_modifiers(names: &[impl AsRef<str>]) -> Result<Vec<Modifier>> {
    let mut out = vec![];
    for m in names {
        let m = match m.as_ref().to_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" | "win" => Modifier::Cmd,
            "option" | "opt" | "alt" => Modifier::Option,
            "ctrl" | "control" => Modifier::Ctrl,
            "shift" => Modifier::Shift,
            other => bail!("unknown modifier `{other}` (use cmd, option, ctrl, shift)"),
        };
        if !out.contains(&m) {
            out.push(m);
        }
    }
    Ok(out)
}

/// `"cmd+shift+t"` → key `t` with ⌘⇧. Accepts common aliases (`ctrl`, `alt`, `enter`, `esc`, …).
pub fn parse_keys(combo: &str) -> Result<(String, Vec<Modifier>)> {
    let parts: Vec<&str> = combo.split('+').map(str::trim).collect();
    let (key, mods) =
        parts.split_last().filter(|(k, _)| !k.is_empty()).ok_or_else(|| anyhow!("no key in `{combo}`"))?;
    let modifiers = parse_modifiers(mods)?;
    let lower = key.to_lowercase();
    let key = match lower.as_str() {
        "enter" => "return".to_owned(),
        "esc" => "escape".to_owned(),
        "backspace" => "delete".to_owned(),
        "del" | "forwarddelete" => "forwardDelete".to_owned(),
        "pageup" | "pgup" => "pageUp".to_owned(),
        "pagedown" | "pgdn" => "pageDown".to_owned(),
        "arrowleft" => "left".to_owned(),
        "arrowright" => "right".to_owned(),
        "arrowup" => "up".to_owned(),
        "arrowdown" => "down".to_owned(),
        _ if NAMED_KEYS.contains(&lower.as_str()) => lower,
        _ if key.chars().count() == 1 => lower,
        _ => bail!("unknown key `{key}`"),
    };
    Ok((key, modifiers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::tests::retina;
    use serde_json::json;

    #[test]
    fn screenshot_coordinates_map_to_points() {
        let d = retina();
        assert_eq!(d.shot_size(), (1280, 831));
        assert_eq!(d.to_points(1280.0, 831.0).unwrap(), (1512.0, 982.0));
        let (x, y) = d.to_points(640.0, 415.5).unwrap();
        assert!((x - 756.0).abs() < 0.01 && (y - 491.0).abs() < 0.01);
        assert!(d.to_points(1281.0, 10.0).is_err());
        // Small displays aren't upscaled.
        let small = Display { width: 800.0, height: 600.0, ..retina() };
        assert_eq!(small.shot_size(), (800, 600));
    }

    #[test]
    fn key_combos_parse() {
        assert_eq!(parse_keys("cmd+shift+T").unwrap(), ("t".into(), vec![Modifier::Cmd, Modifier::Shift]));
        assert_eq!(parse_keys("Enter").unwrap(), ("return".into(), vec![]));
        assert_eq!(parse_keys("ctrl+alt+Delete").unwrap(), ("delete".into(), vec![Modifier::Ctrl, Modifier::Option]));
        assert_eq!(parse_keys("cmd++").unwrap_err().to_string(), "no key in `cmd++`");
        assert!(parse_keys("hyper+x").is_err());
        assert!(parse_keys("cmd+banana").is_err());
    }

    #[test]
    fn input_events_serialize_for_helpers() {
        let e = InputEvent::Drag { x: 1.0, y: 2.0, to_x: 3.0, to_y: 4.0 };
        assert_eq!(
            serde_json::to_value(e).unwrap(),
            json!({"type": "drag", "x": 1.0, "y": 2.0, "toX": 3.0, "toY": 4.0})
        );
    }
}
