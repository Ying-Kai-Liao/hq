//! The composer's `/` commands, listed while the draft is just `/partial`: Fast mode and New
//! session run here (`updateBot`, `newSession`); a skill fills in `/<id> `, which the host turns
//! into "read this skill first" (`market::expand_command`).

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::json;

use super::{After, App, Editor};

/// What picking a command does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlashAction {
    Fast,
    NewSession,
    Skill,
}

/// A command the list offers.
pub struct SlashCommand {
    /// What follows the `/`.
    pub name: String,
    pub title: String,
    pub detail: String,
    pub action: SlashAction,
}

impl SlashCommand {
    /// The row's text after `/name`.
    pub fn about(&self) -> String {
        match self.action {
            SlashAction::Skill if self.detail.is_empty() => self.title.clone(),
            SlashAction::Skill => self.detail.replace('\n', " "),
            _ => format!("{} · {}", self.title, self.detail),
        }
    }
}

impl App {
    /// The selected bot's built-in commands; a group has none.
    fn built_in(&self) -> Vec<SlashCommand> {
        let Some(bot) = self.bot().filter(|b| !b.group) else { return vec![] };
        let fast = bot.fast_shown().then(|| SlashCommand {
            name: "fast".into(),
            title: "Fast mode".into(),
            detail: bot.fast_detail(),
            action: SlashAction::Fast,
        });
        let new = SlashCommand {
            name: "new".into(),
            title: "New session".into(),
            detail: "Start over with a fresh context; the transcript stays".into(),
            action: SlashAction::NewSession,
        };
        fast.into_iter().chain([new]).collect()
    }

    /// Built-in commands, then the selected bot's skills, whose name or title holds the
    /// `/partial` being typed (none in a group).
    pub fn slash_commands(&self) -> Vec<SlashCommand> {
        let Some(bot) = self.bot().filter(|b| !b.group) else { return vec![] };
        let draft = self.draft();
        let Some((query, None)) = crate::market::slash_command(&draft.text) else { return vec![] };
        let query = query.to_lowercase();
        let skills = self.plugins.1.iter().filter_map(|s| {
            let id = s["id"].as_str()?;
            bot.skills.iter().any(|on| on == id).then(|| SlashCommand {
                name: id.to_owned(),
                title: s["name"].as_str().unwrap_or(id).to_owned(),
                detail: s["description"].as_str().unwrap_or_default().to_owned(),
                action: SlashAction::Skill,
            })
        });
        self.built_in()
            .into_iter()
            .chain(skills)
            .filter(|c| c.name.contains(&query) || c.title.to_lowercase().contains(&query))
            .collect()
    }

    /// The highlighted row of `count`: kept while the draft stays the same, else the first.
    pub fn slash_selected(&self, count: usize) -> usize {
        let (draft, index) = &self.slash_pick;
        if *draft == self.draft().text { (*index).min(count.saturating_sub(1)) } else { 0 }
    }

    /// Keys while the list is up: ↑/↓ move, Tab or Return runs the highlighted command (Return
    /// sends a skill whose name is already typed out). Returns whether it took the key.
    pub(super) fn slash_key(&mut self, k: KeyEvent) -> bool {
        if !k.modifiers.is_empty() {
            return false;
        }
        let commands = self.slash_commands();
        let Some(n) = std::num::NonZeroUsize::new(commands.len()).map(usize::from) else { return false };
        let typed = self.draft().text;
        let sel = self.slash_selected(n);
        match k.code {
            KeyCode::Down => self.slash_pick = (typed, (sel + 1) % n),
            KeyCode::Up => self.slash_pick = (typed, (sel + n - 1) % n),
            KeyCode::Tab | KeyCode::Enter => {
                let picked = &commands[sel];
                if k.code == KeyCode::Enter && picked.action == SlashAction::Skill && typed[1..] == picked.name {
                    return false;
                }
                self.run_slash(picked);
            }
            _ => return false,
        }
        true
    }

    /// A draft that is just a built-in command (`/fast`, `/new`) runs it instead of being sent.
    /// Returns whether it did.
    pub(super) fn built_in_command(&mut self, text: &str) -> bool {
        let Some(name) = text.strip_prefix('/') else { return false };
        let Some(command) = self.built_in().into_iter().find(|c| c.name == name) else { return false };
        self.run_slash(&command);
        true
    }

    fn run_slash(&mut self, command: &SlashCommand) {
        let Some((id, fast)) = self.bot().map(|b| (b.id.clone(), b.fast_mode)) else { return };
        let fill = match command.action {
            SlashAction::Fast => {
                self.call("updateBot", json!({"id": id, "fastMode": !fast}), After::Nothing);
                self.flash(if fast { "Fast mode off" } else { "Fast mode on" });
                String::new()
            }
            SlashAction::NewSession => {
                self.call("newSession", json!({"botId": id}), After::Nothing);
                self.flash("New session");
                String::new()
            }
            SlashAction::Skill => format!("/{} ", command.name),
        };
        if let Some(key) = self.draft_key() {
            self.drafts.insert(key, Editor::with(&fill));
        }
    }

    /// Starting a draft with `/` loads the computer's skills again, so the menu is current.
    pub(super) fn slash_typed(&self) {
        if self.bot().is_some_and(|b| !b.group) && self.draft().text == "/" {
            self.call("skills", json!({}), After::Skills);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Bot, test_app};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use serde_json::json;

    fn app_with(bot: &serde_json::Value) -> super::App {
        let mut app = test_app();
        app.bots.insert("b".into(), Bot::parse(bot).expect("a bot parses"));
        app.selected = Some("b".into());
        app.plugins.1 = vec![
            json!({"id": "pdf", "name": "pdf", "description": "PDFs"}),
            json!({"id": "docx", "name": "docx"}),
            json!({"id": "xlsx", "name": "xlsx"}),
        ];
        app
    }

    fn names(app: &super::App) -> Vec<String> {
        app.slash_commands().into_iter().map(|c| c.name).collect()
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[tokio::test]
    async fn the_list_offers_built_in_commands_then_the_bots_skills() {
        let mut app =
            app_with(&json!({"id": "b", "name": "Bot", "skills": ["pdf", "docx"], "fastModeSupport": "offered"}));
        app.drafts.insert("b".into(), super::Editor::with("/"));
        assert_eq!(names(&app), ["fast", "new", "pdf", "docx"], "only skills the bot has on");
        app.drafts.insert("b".into(), super::Editor::with("/session"));
        assert_eq!(names(&app), ["new"], "titles match too");
        app.bots.get_mut("b").expect("the bot").fast_support = "unsupported".into();
        app.drafts.insert("b".into(), super::Editor::with("/"));
        assert_eq!(names(&app), ["new", "pdf", "docx"], "no Fast mode on offer");
    }

    #[tokio::test]
    async fn arrows_pick_a_row_and_return_runs_it() {
        let mut app = app_with(&json!({"id": "b", "name": "Bot", "skills": ["pdf"], "fastModeSupport": "offered"}));
        app.drafts.insert("b".into(), super::Editor::with("/"));
        assert!(app.slash_key(key(KeyCode::Up)), "up wraps to the last row");
        assert_eq!(app.slash_selected(3), 2);
        assert!(app.slash_key(key(KeyCode::Enter)), "Return on a skill fills it in");
        assert_eq!(app.draft().text, "/pdf ");
        assert!(names(&app).is_empty(), "the list closes once the name is done");
        app.drafts.insert("b".into(), super::Editor::with("/pdf"));
        assert!(!app.slash_key(key(KeyCode::Enter)), "a skill already typed out sends");
        app.drafts.insert("b".into(), super::Editor::with("/fa"));
        assert!(app.slash_key(key(KeyCode::Tab)), "a built-in command runs");
        assert_eq!(app.draft().text, "", "and the draft clears");
    }

    #[tokio::test]
    async fn sending_just_a_built_in_command_runs_it() {
        let mut app = app_with(&json!({"id": "b", "name": "Bot", "fastModeSupport": "offered"}));
        assert!(!app.built_in_command("/fast please"), "only the bare command");
        assert!(app.built_in_command("/new"));
        assert!(app.built_in_command("/fast"));
        app.bots.get_mut("b").expect("the bot").fast_support = "unsupported".into();
        assert!(!app.built_in_command("/fast"), "without Fast mode it reaches the agent");
    }
}
