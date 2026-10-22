//! The labeled text fields sheet: keys, connector setup, a pasted MCP config, a handoff.

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};

use super::super::app::{App, Editor, Entry, Overlay};
use super::market::connector_inputs;
use super::{Fields, Input, Reply, Submit, ctrl, newline};

impl App {
    pub(in crate::tui) fn fields_key(&mut self, mut f: Box<Fields>, k: KeyEvent) -> Option<Overlay> {
        if f.saving {
            return if k.code == KeyCode::Esc { None } else { Some(Overlay::Fields(f)) };
        }
        let rows = f.offset() + f.inputs.len();
        let on_choice = f.offset() == 1 && f.cursor == 0;
        let multiline = f.current().is_some_and(|i| i.multiline);
        match k.code {
            KeyCode::Esc => return None,
            _ if newline(k) && multiline => {
                if let Some(i) = f.current() {
                    i.ed.insert("\n");
                }
            }
            KeyCode::Enter => self.save_fields(&mut f),
            KeyCode::Char('s') if ctrl(k) => self.save_fields(&mut f),
            KeyCode::Tab | KeyCode::Down => f.cursor = (f.cursor + 1) % rows.max(1),
            KeyCode::BackTab | KeyCode::Up => f.cursor = (f.cursor + rows.max(1) - 1) % rows.max(1),
            KeyCode::Left | KeyCode::Right | KeyCode::Char(' ') if on_choice => {
                f.choice = (f.choice + 1) % f.choices.len();
                connector_inputs(&mut f);
                super::super::connections::option_fields(&mut f);
            }
            _ => {
                if let Some(i) = f.current() {
                    i.ed.key(k);
                }
            }
        }
        Some(Overlay::Fields(f))
    }

    fn save_fields(&mut self, f: &mut Fields) {
        if f.saving {
            return;
        }
        if let Some(i) = f.inputs.iter().find(|i| i.required && i.ed.text.trim().is_empty()) {
            f.error = Some(format!("{} is required.", i.label));
            return;
        }
        let values: serde_json::Map<String, Value> = f
            .inputs
            .iter()
            .filter(|i| !i.ed.text.trim().is_empty())
            .map(|i| (i.name.clone(), if i.secret { i.ed.text.as_str() } else { i.ed.text.trim() }.into()))
            .collect();
        f.saving = true;
        f.error = None;
        match &f.submit {
            Submit::Connection(_) => self.submit_connection(f, &values),
            Submit::AgentEnv(backend) => {
                if values.is_empty() {
                    f.saving = false;
                    f.error = Some("Type at least one key.".into());
                    return;
                }
                self.sheet("setAgentEnv", json!({"backend": backend, "vars": values}), Reply::FieldsSaved);
            }
            Submit::Connector(item) => {
                let option = item["options"][f.choice]["id"].clone();
                self.sheet(
                    "installConnector",
                    json!({"registryName": item["name"], "option": option, "inputs": values}),
                    Reply::FieldsSaved,
                );
            }
            Submit::Import => self.sheet("importConnectors", json!({"config": values["config"]}), Reply::FieldsSaved),
            Submit::Handoff(entry) => {
                self.sheet("editHandoff", json!({"entryId": entry, "text": values["text"]}), Reply::FieldsSaved);
            }
            Submit::MemoryFile { bot, shared, name, base } => {
                let file = name.clone().map_or_else(|| values.get("file").cloned().unwrap_or_default(), Value::from);
                // A note keeps its text as typed: trimming would drop its last line break.
                let content = f.inputs.iter().find(|i| i.name == "content").map_or("", |i| i.ed.text.as_str());
                let body = json!({"botId": bot, "file": file, "shared": shared, "content": content, "base": base});
                self.sheet("saveMemoryFile", body, Reply::FieldsSaved);
            }
        }
    }
}

/// Edits what a handoff card carries into the next conversation.
pub fn handoff_fields(entry: &Entry) -> Fields {
    Fields {
        title: "Edit the handoff".into(),
        note: "Your next message starts a fresh conversation that begins with this. ⇧↵ new line, ↵ saves.".into(),
        choices: vec![],
        choice: 0,
        inputs: vec![Input {
            name: "text".into(),
            label: "What it carries".into(),
            secret: false,
            required: true,
            multiline: true,
            placeholder: String::new(),
            ed: Editor::with(entry.data["handoff"]["text"].as_str().unwrap_or_default()),
        }],
        cursor: 0,
        error: None,
        saving: false,
        submit: Submit::Handoff(entry.id.clone()),
    }
}

/// Writes a long-form note: a new one (`name` none) or a change over what was loaded (`base`).
pub fn memory_file_fields(bot: &str, shared: bool, name: Option<&str>, base: Option<String>, content: &str) -> Fields {
    let input = |name: &str, label: &str, multiline: bool, placeholder: &str, text: &str| Input {
        name: name.into(),
        label: label.into(),
        secret: false,
        required: true,
        multiline,
        placeholder: placeholder.into(),
        ed: Editor::with(text),
    };
    let mut inputs = Vec::new();
    if name.is_none() {
        inputs.push(input("file", "File name", false, "people.md", ""));
    }
    inputs.push(input("content", "Note", true, "", content));
    Fields {
        title: name.map_or_else(|| "New note".to_owned(), str::to_owned),
        note: "Starts with a description: line saying when the bot should read it. ⇧↵ new line, ↵ saves.".into(),
        choices: vec![],
        choice: 0,
        inputs,
        cursor: 0,
        error: None,
        saving: false,
        submit: Submit::MemoryFile { bot: bot.to_owned(), shared, name: name.map(str::to_owned), base },
    }
}
