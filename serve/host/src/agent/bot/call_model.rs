//! Voice-call turns: a turn spoken in a call runs on the call model (a quick one by default), a typed turn on the
//! agent's own. Same Claude session either way: the model is switched with `session/set_model` before the prompt, so
//! the conversation, its cache and its tools carry over and nothing relaunches.

use super::Actor;
use serde_json::json;

/// What hq's launch said about models: the agent's own, and the call model it named.
#[derive(Clone)]
pub(super) struct CallModels {
    pub own: Option<String>,
    pub launch_call: Option<String>,
}

impl Actor {
    /// The call model that applies now: hq's answer (so a change in the app reaches the next call at once), else what
    /// the launch said. `None` keeps the agent's own model.
    async fn call_model_now(&self, models: &CallModels) -> Option<String> {
        let agent = self.cfg.hq_agent.clone()?;
        let named = match crate::agent::hq::info(&agent, false).await.info {
            Ok(info) => info["call_model_effective"].as_str().map(str::to_owned),
            Err(_) => models.launch_call.clone(),
        };
        named.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty())
    }

    /// Puts `sid` on the model this turn wants. A failure leaves the session on the model it has (the call just
    /// answers with the agent's own) and asks again on the next turn.
    pub(super) async fn sync_call_model(&mut self, sid: &str) {
        let Some(models) = self.call_models.clone() else { return };
        let own = models.own.as_deref().filter(|m| !m.is_empty());
        let wanted = if self.turn_call { self.call_model_now(&models).await } else { None };
        // The same model as the agent's own: nothing to switch.
        let wanted = wanted.filter(|m| Some(m.as_str()) != own);
        let Some(conn) = self.conn.as_ref() else { return };
        if conn.call_sessions.get(sid).cloned() == wanted {
            return;
        }
        let model_id = wanted.clone().or_else(|| own.map(str::to_owned)).unwrap_or_else(|| "default".into());
        match self.session_request("session/set_model", json!({"sessionId": sid, "modelId": model_id})).await {
            Ok(_) => {
                if let Some(conn) = self.conn.as_mut() {
                    match wanted {
                        Some(model) => conn.call_sessions.insert(sid.to_owned(), model),
                        None => conn.call_sessions.remove(sid),
                    };
                }
            }
            Err(error) => {
                let bot = &self.cfg.id;
                tracing::warn!(bot = %bot, model = %model_id, error = format!("{error:#}"), "couldn't switch the call model");
            }
        }
    }
}
