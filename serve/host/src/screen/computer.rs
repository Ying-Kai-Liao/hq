//! Bots operating the computer: the `computer` MCP tools and who is in control.

use super::helper::Link;
use super::protocol::{Button, Display, InputEvent, parse_keys, parse_modifiers};
use super::{AGENT_HOLD, SETTLE, Screen};
use crate::LockExt;
use crate::hub::Hub;
use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A `computer` MCP tool call, as the MCP server forwards it (`{name, arguments}`).
#[derive(Debug, Deserialize)]
#[serde(tag = "name", content = "arguments", rename_all = "snake_case")]
pub enum ComputerTool {
    Screenshot {
        display: Option<u32>,
    },
    Click {
        x: f64,
        y: f64,
        #[serde(default)]
        button: Button,
        count: Option<u8>,
        #[serde(default)]
        modifiers: Vec<String>,
        display: Option<u32>,
    },
    Move {
        x: f64,
        y: f64,
        display: Option<u32>,
    },
    Drag {
        x: f64,
        y: f64,
        to_x: f64,
        to_y: f64,
        display: Option<u32>,
    },
    Scroll {
        x: f64,
        y: f64,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
        display: Option<u32>,
    },
    Type {
        text: String,
    },
    Key {
        keys: String,
    },
    UiTree {
        display: Option<u32>,
    },
    OpenApp {
        name: String,
    },
    TypeLogin {
        login: String,
        field: LoginField,
    },
}

/// Which half of a saved login `type_login` types.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginField {
    Username,
    Password,
}

impl ComputerTool {
    /// Tools that only look: allowed while the user has control.
    fn read_only(&self) -> bool {
        matches!(self, Self::Screenshot { .. } | Self::UiTree { .. })
    }
}

impl Screen {
    /// Marks `bot` as the one using the computer. Returns whether that's news.
    fn claim(&self, bot: &str, read_only: bool) -> Result<bool> {
        let mut c = self.control.locked();
        if c.user && !read_only {
            bail!(
                "The user has taken over the screen from their phone. Wait until they hand it back, or ask them what to do."
            );
        }
        if let Some(other) = c.active_agent()
            && other != bot
        {
            bail!("Another bot is using the computer right now. Try again in a minute.");
        }
        let fresh = c.active_agent().is_none();
        c.agent = Some((bot.to_owned(), Instant::now()));
        Ok(fresh)
    }
}

/// Runs one `computer` tool for `bot`: MCP `CallToolResult` content.
pub async fn computer(hub: &Arc<Hub>, bot: &str, tool: ComputerTool) -> Result<Value> {
    let row = hub.store.bot(bot)?.filter(|r| !r.deleted).ok_or_else(|| anyhow!("unknown bot"))?;
    if !row.config.computer {
        bail!("Computer use is turned off for this bot.");
    }
    let screen = &hub.screen;
    let link = screen.link()?;
    if screen.claim(bot, tool.read_only())? {
        screen.emit();
        let screen = screen.clone();
        tokio::spawn(async move {
            // Say when the bot stops, so phones drop the live chip.
            loop {
                tokio::time::sleep(AGENT_HOLD).await;
                if screen.control.locked().active_agent().is_none() {
                    screen.emit();
                    return;
                }
            }
        });
    }
    let display = |id| screen.display(id);
    let act = |id: Option<u32>, event: InputEvent| {
        let link = link.clone();
        async move {
            let d = display(id)?;
            link.request("input", json!({"display": d.id, "event": event})).await?;
            tokio::time::sleep(SETTLE).await;
            shot(&link, &d).await
        }
    };
    match tool {
        ComputerTool::Screenshot { display: id } => shot(&link, &display(id)?).await,
        ComputerTool::Click { x, y, button, count, modifiers, display: id } => {
            let d = display(id)?;
            let (x, y) = d.to_points(x, y)?;
            let modifiers = parse_modifiers(&modifiers)?;
            let count = count.unwrap_or(1).clamp(1, 3);
            act(Some(d.id), InputEvent::Click { x, y, button, count, modifiers }).await
        }
        ComputerTool::Move { x, y, display: id } => {
            let d = display(id)?;
            let (x, y) = d.to_points(x, y)?;
            act(Some(d.id), InputEvent::Move { x, y }).await
        }
        ComputerTool::Drag { x, y, to_x, to_y, display: id } => {
            let d = display(id)?;
            let (x, y) = d.to_points(x, y)?;
            let (to_x, to_y) = d.to_points(to_x, to_y)?;
            act(Some(d.id), InputEvent::Drag { x, y, to_x, to_y }).await
        }
        ComputerTool::Scroll { x, y, dx, dy, display: id } => {
            let d = display(id)?;
            let (x, y) = d.to_points(x, y)?;
            act(Some(d.id), InputEvent::Scroll { x, y, dx, dy }).await
        }
        ComputerTool::Type { text } => act(None, InputEvent::Text { text }).await,
        ComputerTool::Key { keys } => {
            let (key, modifiers) = parse_keys(&keys)?;
            act(None, InputEvent::Key { key, modifiers }).await
        }
        ComputerTool::UiTree { display: id } => {
            let d = display(id)?;
            let mut res = link.request("uiTree", json!({"display": d.id})).await?;
            scale_frames(&mut res["tree"], d.shot_scale());
            let text = format!(
                "Accessibility tree of {} (frames are [x, y, width, height] in screenshot pixels):\n{}",
                res["app"].as_str().unwrap_or("the frontmost app"),
                res["tree"]
            );
            Ok(json!([{"type": "text", "text": text}]))
        }
        ComputerTool::TypeLogin { login, field } => {
            let login = crate::market::logins::get(&hub.store, &login)?;
            // Type only into the login's own site, and a password only into a password field,
            // so a misled bot can't paste it into a page or chat that would show it.
            let focus = link.request("focusedField", json!({})).await?;
            let app = focus["app"].as_str().unwrap_or_default();
            let url = focus["url"].as_str();
            if !crate::market::logins::matches(&login.site, url, app) {
                bail!(
                    "The focused window is {}, not {}. Open {} and focus its sign-in field first.",
                    url.unwrap_or(app),
                    login.site,
                    login.site
                );
            }
            let text = match field {
                LoginField::Username => login.username,
                LoginField::Password => {
                    if focus["secure"] != true {
                        bail!(
                            "Click into the password field first; type_login types a password only into a password field."
                        );
                    }
                    crate::market::passwords::resolve(&hub.store, &login.password).await?
                }
            };
            act(None, InputEvent::Text { text }).await
        }
        ComputerTool::OpenApp { name } => {
            link.request("openApp", json!({"name": name})).await?;
            tokio::time::sleep(Duration::from_secs(1)).await;
            shot(&link, &display(None)?).await
        }
    }
}

async fn shot(link: &Link, d: &Display) -> Result<Value> {
    let (width, height) = d.shot_size();
    let res = link.request("screenshot", json!({"display": d.id, "width": width, "height": height})).await?;
    let data = res["data"].as_str().ok_or_else(|| anyhow!("the screen helper sent no image"))?;
    Ok(json!([
        {"type": "image", "data": data, "mimeType": "image/jpeg"},
        {"type": "text", "text": format!(
            "Display {} \"{}\", {width}×{height}. Coordinates for click/move/drag/scroll are pixels in this image.",
            d.id, d.name
        )},
    ]))
}

/// Display points → screenshot pixels, for every `frame` in an accessibility tree.
fn scale_frames(node: &mut Value, s: f64) {
    if let Some(frame) = node.get_mut("frame").and_then(Value::as_array_mut) {
        for v in frame.iter_mut() {
            if let Some(f) = v.as_f64() {
                *v = json!((f * s).round());
            }
        }
    }
    if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
        for c in children {
            scale_frames(c, s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[test]
    fn tools_parse_from_mcp_calls() {
        let t: ComputerTool =
            serde_json::from_value(json!({"name": "click", "arguments": {"x": 1, "y": 2, "button": "right"}})).unwrap();
        assert!(matches!(t, ComputerTool::Click { button: Button::Right, count: None, .. }));
        let t: ComputerTool = serde_json::from_value(json!({"name": "screenshot", "arguments": {}})).unwrap();
        assert!(t.read_only());
    }

    #[test]
    fn user_takeover_blocks_bot_actions_but_not_looking() {
        let (tx, _) = broadcast::channel(8);
        let s = Screen::new(Some(true), tx);
        assert!(s.claim("a", false).unwrap());
        assert!(!s.claim("a", false).unwrap());
        assert!(s.claim("b", true).is_err(), "one bot at a time");
        s.takeover(true);
        assert!(s.claim("a", false).is_err());
        assert!(s.claim("a", true).is_ok());
    }

    #[test]
    fn frames_scale_recursively() {
        let mut t = json!({"frame": [100, 50, 200, 20], "children": [{"frame": [10.0, 10.0, 5.0, 5.0]}]});
        scale_frames(&mut t, 0.5);
        assert_eq!(t["frame"], json!([50.0, 25.0, 100.0, 10.0]));
        assert_eq!(t["children"][0]["frame"], json!([5.0, 5.0, 3.0, 3.0]));
    }
}
