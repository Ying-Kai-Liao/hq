//! A bot's routines: the list, the form, and the triggers typed into it.

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};
use std::str::FromStr as _;

use super::super::app::{App, Confirm, ConfirmAct, Editor, Focus, Overlay};
use super::{Reply, RoutineField, RoutineForm, RoutineList, ctrl, newline, s};

impl App {
    pub fn open_routines(&mut self) {
        let Some(b) = self.bot().filter(|b| !b.group) else {
            self.flash("Routines belong to a bot, not a group");
            return;
        };
        let bot = b.id.clone();
        self.sheet("routines", json!({"botId": bot}), Reply::Routines(bot.clone()));
        self.overlays.push(Overlay::Routines(RoutineList { bot, items: None, cursor: 0 }));
    }

    pub(in crate::tui) fn routines_key(&mut self, mut l: RoutineList, k: KeyEvent) -> Option<Overlay> {
        let n = l.items.as_ref().map_or(0, Vec::len);
        let current = l.items.as_ref().and_then(|v| v.get(l.cursor)).cloned();
        let bot = l.bot.clone();
        match (k.code, current) {
            (KeyCode::Esc | KeyCode::Char('q' | 'R'), _) => return None,
            (KeyCode::Down | KeyCode::Char('j'), _) => l.cursor = (l.cursor + 1).min(n.saturating_sub(1)),
            (KeyCode::Up | KeyCode::Char('k'), _) => l.cursor = l.cursor.saturating_sub(1),
            (KeyCode::Char('n'), _) => {
                self.overlays.push(Overlay::Routines(l));
                self.overlays.push(Overlay::Routine(Box::new(RoutineForm {
                    bot,
                    id: None,
                    name: Editor::default(),
                    instruction: Editor::default(),
                    when: Editor::default(),
                    original: Value::Null,
                    original_text: String::new(),
                    field: RoutineField::Name,
                    error: None,
                    saving: false,
                })));
                return None;
            }
            (KeyCode::Char('c'), _) => {
                // Or ask the bot to set one up: start the ask in its chat.
                let draft = self.drafts.entry(bot).or_default();
                if !draft.text.is_empty() {
                    draft.insert("\n");
                }
                draft.insert("I want a routine that ");
                self.thread = None;
                self.focus = Focus::Chat;
                self.typing = true;
                return None;
            }
            (KeyCode::Enter | KeyCode::Char('e'), Some(r)) => {
                let triggers = r["triggers"].clone();
                let text = when_text(&triggers, &local_zone());
                let original_text = r["triggerDescriptions"]
                    .as_array()
                    .map(|d| d.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" · "))
                    .unwrap_or_default();
                self.overlays.push(Overlay::Routines(l));
                self.overlays.push(Overlay::Routine(Box::new(RoutineForm {
                    bot,
                    id: Some(s(&r, "id")),
                    name: Editor::with(&s(&r, "name")),
                    instruction: Editor::with(&s(&r, "instruction")),
                    when: Editor::with(text.as_deref().unwrap_or_default()),
                    original: if text.is_some() { Value::Null } else { triggers },
                    original_text,
                    field: RoutineField::Name,
                    error: None,
                    saving: false,
                })));
                return None;
            }
            (KeyCode::Char(' '), Some(r)) => {
                let on = !r["enabled"].as_bool().unwrap_or(false);
                self.sheet(
                    "setRoutineEnabled",
                    json!({"botId": bot, "id": r["id"], "enabled": on}),
                    Reply::Routines(bot.clone()),
                );
                if let Some(item) = l.items.as_mut().and_then(|v| v.get_mut(l.cursor)) {
                    item["enabled"] = on.into();
                }
            }
            (KeyCode::Char('r'), Some(r)) => {
                self.sheet("runRoutine", json!({"botId": bot, "id": r["id"]}), Reply::Routines(bot.clone()));
                self.flash(&format!("Running {} now", s(&r, "name")));
            }
            (KeyCode::Char('w' | 'W'), Some(r)) if !has_webhook(&r) => {
                self.flash("Only a routine that runs on a webhook has a URL and key");
            }
            (KeyCode::Char('w'), Some(r)) => {
                self.sheet("routineWebhook", json!({"botId": bot, "id": r["id"]}), Reply::Webhook);
            }
            (KeyCode::Char('W'), Some(r)) => {
                let c = Confirm {
                    title: format!("Replace the webhook key of {}?", s(&r, "name")),
                    detail: "Senders using the current key stop working.".into(),
                    note: "The new one is copied in a curl command.".into(),
                    button: "Replace",
                    act: ConfirmAct::RotateRoutineKey(bot, s(&r, "id")),
                };
                self.overlays.push(Overlay::Routines(l));
                self.overlays.push(Overlay::Confirm(c));
                return None;
            }
            (KeyCode::Char('x'), Some(r)) => {
                let c = Confirm {
                    title: format!("Delete the routine {}?", s(&r, "name")),
                    detail: "It stops running.".into(),
                    note: "What it already posted stays in the chat.".into(),
                    button: "Delete",
                    act: ConfirmAct::DeleteRoutine(bot, s(&r, "id")),
                };
                self.overlays.push(Overlay::Routines(l));
                self.overlays.push(Overlay::Confirm(c));
                return None;
            }
            _ => {}
        }
        Some(Overlay::Routines(l))
    }

    pub(in crate::tui) fn routine_key(&mut self, mut f: Box<RoutineForm>, k: KeyEvent) -> Option<Overlay> {
        use RoutineField::{Instruction, Name, When};
        match k.code {
            KeyCode::Esc => return None,
            _ if newline(k) && f.field == Instruction => f.instruction.insert("\n"),
            KeyCode::Enter => self.save_routine(&mut f),
            KeyCode::Char('s') if ctrl(k) => self.save_routine(&mut f),
            KeyCode::Tab | KeyCode::Down => {
                f.field = match f.field {
                    Name => Instruction,
                    Instruction => When,
                    When => Name,
                };
            }
            KeyCode::BackTab | KeyCode::Up => {
                f.field = match f.field {
                    Name => When,
                    Instruction => Name,
                    When => Instruction,
                };
            }
            _ => {
                let ed = match f.field {
                    Name => &mut f.name,
                    Instruction => &mut f.instruction,
                    When => &mut f.when,
                };
                ed.key(k);
            }
        }
        Some(Overlay::Routine(f))
    }

    fn save_routine(&mut self, f: &mut RoutineForm) {
        if f.saving {
            return;
        }
        let (name, instruction) = (f.name.text.trim(), f.instruction.text.trim());
        if name.is_empty() || instruction.is_empty() {
            f.error = Some("A routine needs a name and what to do.".into());
            return;
        }
        let triggers = if f.when.text.trim().is_empty() && !f.original.is_null() {
            f.original.clone()
        } else {
            match parse_when(&f.when.text, &local_zone(), crate::store::now_ms()) {
                Ok(t) => json!([t]),
                Err(e) => {
                    f.error = Some(e);
                    f.field = RoutineField::When;
                    return;
                }
            }
        };
        let mut body = json!({"botId": f.bot, "name": name, "instruction": instruction, "triggers": triggers});
        if let Some(id) = &f.id {
            body["id"] = id.clone().into();
        }
        f.saving = true;
        f.error = None;
        self.sheet("saveRoutine", body, Reply::RoutineSaved);
    }
}

/// A routine with a webhook (or event) trigger, which has a URL and key.
fn has_webhook(r: &Value) -> bool {
    r["triggers"].as_array().into_iter().flatten().any(|t| matches!(t["type"].as_str(), Some("webhook" | "event")))
}

/// This computer's IANA time zone (routines run on the host's clock in it).
pub fn local_zone() -> String {
    let valid = |z: &str| chrono_tz::Tz::from_str(z).is_ok();
    if let Ok(tz) = std::env::var("TZ")
        && valid(tz.trim_start_matches(':'))
    {
        return tz.trim_start_matches(':').to_owned();
    }
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|p| p.to_string_lossy().split_once("zoneinfo/").map(|(_, z)| z.to_owned()))
        .filter(|z| valid(z))
        .unwrap_or_else(|| "UTC".into())
}

/// One trigger from what's typed: `webhook`, `every 30m`, a date and time (once),
/// or five cron fields in `zone`.
pub fn parse_when(text: &str, zone: &str, now: i64) -> Result<Value, String> {
    let t = text.trim().to_lowercase();
    if t.is_empty() {
        return Err("Say when it runs.".into());
    }
    if t == "webhook" {
        return Ok(json!({"type": "webhook"}));
    }
    if let Some(rest) = t.strip_prefix("every") {
        let rest = rest.trim();
        let split = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        let (n, unit) = rest.split_at(split);
        let n: i64 = if n.is_empty() { 1 } else { n.parse().map_err(|_| "Use a whole number, like every 30m.")? };
        let unit = match unit.trim().trim_end_matches('s') {
            "sec" | "second" => 1,
            "m" | "min" | "minute" => 60,
            "h" | "hr" | "hour" => 3600,
            "d" | "day" => 86400,
            "" if n > 0 && !rest.is_empty() => return Err("Add a unit: s, m, h or d.".into()),
            _ => return Err("Use s, m, h or d, like every 2h.".into()),
        };
        return Ok(json!({"type": "interval", "seconds": n * unit}));
    }
    if let Ok(at) = chrono::NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M") {
        let tz = chrono_tz::Tz::from_str(zone).map_err(|_| "Unknown time zone")?;
        let at = at.and_local_timezone(tz).earliest().ok_or("That time doesn't exist here.")?.timestamp_millis();
        if at <= now {
            return Err("That time has passed.".into());
        }
        return Ok(json!({"type": "once", "at": at}));
    }
    if t.split_whitespace().count() == 5 {
        return Ok(
            json!({"type": "cron", "expression": t.split_whitespace().collect::<Vec<_>>().join(" "), "timeZone": zone}),
        );
    }
    Err("Try 0 9 * * 1-5, every 2h, 2026-10-01 09:00 or webhook.".into())
}

/// A routine's triggers as `parse_when` reads them, when they're one it can write.
pub fn when_text(triggers: &Value, zone: &str) -> Option<String> {
    let [t] = triggers.as_array()?.as_slice() else { return None };
    match t["type"].as_str()? {
        "webhook" => Some("webhook".into()),
        "interval" => {
            let secs = t["seconds"].as_i64()?;
            let (n, u) = [(86400, "d"), (3600, "h"), (60, "m"), (1, "s")].into_iter().find(|(u, _)| secs % u == 0)?;
            Some(format!("every {}{u}", secs / n))
        }
        "cron" if t["timeZone"].as_str() == Some(zone) => t["expression"].as_str().map(str::to_owned),
        "once" => {
            let tz = chrono_tz::Tz::from_str(zone).ok()?;
            let at = chrono::DateTime::from_timestamp_millis(t["at"].as_i64()?)?.with_timezone(&tz);
            Some(at.format("%Y-%m-%d %H:%M").to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_reads_what_it_writes() {
        let now = 1_790_470_800_000;
        let zone = "Asia/Taipei";
        assert_eq!(parse_when("webhook", zone, now), Ok(json!({"type": "webhook"})));
        assert_eq!(parse_when("every 30m", zone, now), Ok(json!({"type": "interval", "seconds": 1800})));
        assert_eq!(parse_when("Every 2 hours", zone, now), Ok(json!({"type": "interval", "seconds": 7200})));
        assert!(parse_when("every 5", zone, now).is_err());
        assert!(parse_when("2020-01-01 09:00", zone, now).is_err());
        assert!(parse_when("tomorrow", zone, now).is_err());
        for text in ["0 9 * * 1-5", "every 90m", "every 1d", "webhook", "2030-10-01 09:00"] {
            let t = parse_when(text, zone, now).expect(text);
            let back = when_text(&json!([t]), zone).expect(text);
            assert_eq!(parse_when(&back, zone, now), Ok(t), "{text}");
        }
        // Another zone's cron, or several triggers, stay as they were.
        assert_eq!(when_text(&json!([{"type": "cron", "expression": "0 9 * * *", "timeZone": "UTC"}]), zone), None);
        assert_eq!(when_text(&json!([{"type": "webhook"}, {"type": "webhook"}]), zone), None);
    }
}
