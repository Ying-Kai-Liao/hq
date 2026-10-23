//! What an invited person (a device with a `person_id`) may do: deny by default. A method must be on
//! [`MEMBER_METHODS`] and, when it names a chat, the chat must be theirs and its agent still granted to them.
//! Everything an allowed method returns is shaped here too, so no handler has to know who is asking.
//! The owner's devices and Local never come through here (see `dispatch`).

use super::devices::NotAllowed;
use crate::hub::Hub;
use crate::remote::account;
use crate::store::Store;
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::Arc;

/// The whole of what an invited person can call. A new method is refused for them until it is added here, with a
/// reason; `every_router_method_is_denied_to_members_unless_listed` walks the router to keep it that way.
pub const MEMBER_METHODS: &[&str] = &[
    // The connection handshake; answered without paths, addresses, backends or screen state.
    "hello",
    // An agent's card, for a chat that is theirs.
    "kithInfo",
    // Their own chats, one per granted agent. `startChat` makes it; the rest are the chat methods that name a chat.
    "startChat",
    "send",
    "thread",
    "history",
    "newSession",
    "unsend",
    "markRead",
    "stop",
    // Files go through the chat's own upload folder.
    "upload",
    "readUpload",
    "react",
    // The agent's permission cards in their own chat; answered only by a member of that agent (see `guard`): a guest's
    // go to the owner.
    "respondPermission",
    "editHandoff",
    "keepConversation",
    // Only the project folders the owner shared with them.
    "projects",
    // The code that links their own Telegram, Discord or Slack account to their person.
    "linkCode",
];

/// All an unproven device of an invited person may call: showing the invite token (see `people::prove_invite`).
pub const UNPROVEN_METHODS: &[&str] = &["proveInvite"];

pub fn member_may(method: &str) -> bool {
    MEMBER_METHODS.contains(&method)
}

fn denied(why: &str) -> anyhow::Error {
    NotAllowed(why.to_owned()).into()
}

/// The chat or agent a call names, for the audit log.
pub fn target_of(b: &Value) -> Option<String> {
    ["botId", "entryId", "agent", "inviteId"]
        .iter()
        .find_map(|k| b[*k].as_str().filter(|s| !s.is_empty()).map(str::to_owned))
}

/// Whether `person` may use `agent` right now, asked of kith-auth (the truth) on every call so that taking an agent
/// away cuts access at the next request. Fails closed.
pub async fn may_use(person: &str, agent: &str) -> bool {
    resolve(person, agent).await.is_some_and(|v| v["allowed"].as_bool() == Some(true))
}

/// What kith-auth says `person` gets of `agent` (see `kith-auth resolve`); None when it can't be asked or the person
/// is the owner, who never comes through here.
async fn resolve(person: &str, agent: &str) -> Option<Value> {
    let bin = account::bin().await?;
    let out = crate::channels::hq::output(&bin, &["resolve", agent, "--person", person]).await?;
    serde_json::from_slice::<Value>(&out.stdout).ok().filter(|v| v["owner"].as_bool() != Some(true))
}

/// Who answers the agent's permission prompts in `person`'s chat with `agent`: a member answers their own, everyone
/// else's (a guest's, or any preset that isn't `member`) go to the owner. Asked of kith-auth each time and failing
/// toward the owner.
pub async fn approves_own(person: &str, agent: &str) -> bool {
    resolve(person, agent)
        .await
        .is_some_and(|v| v["allowed"].as_bool() == Some(true) && v["preset"].as_str() == Some("member"))
}

/// The person's chat `bot`, when it is theirs and its agent is still granted to them.
pub async fn own_bot(hub: &Hub, person: &str, bot: &str) -> Result<()> {
    let row = hub
        .store
        .bot(bot)?
        .filter(|r| !r.deleted && r.config.person.as_deref() == Some(person))
        .ok_or_else(|| denied("That chat isn't yours."))?;
    let agent = row.config.hq_agent.as_deref().ok_or_else(|| denied("That chat isn't yours."))?;
    if !may_use(person, agent).await {
        return Err(denied("You no longer have access to that agent."));
    }
    Ok(())
}

/// Checks a call from `person` before it runs. May tighten the body (`b`).
pub async fn guard(hub: &Arc<Hub>, person: &str, proven: bool, method: &str, b: &Value) -> Result<()> {
    if !proven {
        return if UNPROVEN_METHODS.contains(&method) {
            Ok(())
        } else {
            Err(denied("This device hasn't shown its invite yet."))
        };
    }
    if !member_may(method) {
        return Err(denied("This isn't available to guests and members on this computer."));
    }
    match method {
        // Checked by their own handlers, or about no chat at all.
        "hello" | "projects" | "linkCode" | "startChat" => {}
        // A card or message names its chat only through the entry.
        "respondPermission" | "react" | "editHandoff" | "keepConversation" => {
            let id = b["entryId"].as_str().unwrap_or_default();
            let entry = hub.store.entry(id).ok_or_else(|| denied("That chat isn't yours."))?;
            own_bot(hub, person, &entry.bot_id).await?;
            // Only a member answers what their own run asked. A guest's prompts are the owner's to answer, and a
            // card of any other kind (or one a group's bot raised) is not a prompt of their run at all.
            if method == "respondPermission" {
                let agent = hub.store.bot(&entry.bot_id).ok().flatten().and_then(|r| r.config.hq_agent);
                let own = entry.kind == "permission" && entry.data["author"].is_null();
                if !own || !approves_own(person, agent.as_deref().unwrap_or_default()).await {
                    return Err(denied("Only the owner can answer this agent's permission requests for you."));
                }
            }
        }
        _ => own_bot(hub, person, b["botId"].as_str().unwrap_or_default()).await?,
    }
    if method == "send" {
        // A folder on this Mac is the owner's to pick; a project must be one shared with them.
        let text = |k: &str| b[k].as_str().map(str::trim).filter(|s| !s.is_empty());
        if text("folder").is_some() || b["clear"] == true {
            return Err(denied("Folders on this computer can't be picked from this account."));
        }
        if let Some(project) = text("project")
            && !hub.store.person(person).is_some_and(|p| p.projects.iter().any(|x| x == project))
        {
            return Err(denied("That project isn't shared with you."));
        }
    }
    Ok(())
}

/// What an allowed method returns to `person`.
pub fn shape(hub: &Hub, person: &str, method: &str, mut v: Value) -> Value {
    match method {
        "hello" => {
            // Names and keys the apps need to talk to this computer; none of its paths, addresses or screens.
            let keep = ["hostId", "computerId", "signKey", "boxKey", "name", "version", "minApp", "os", "rev"];
            if let Some(o) = v.as_object_mut() {
                o.retain(|k, _| keep.contains(&k.as_str()));
            }
        }
        "projects" => {
            let shared = hub.store.person(person).map(|p| p.projects).unwrap_or_default();
            if let Some(list) = v["projects"].as_array_mut() {
                list.retain(|p| p["id"].as_str().is_some_and(|id| shared.iter().any(|s| s == id)));
                // An id and a name; the folders behind a project are this computer's.
                for p in list.iter_mut() {
                    *p = json!({"id": p["id"], "name": p["id"]});
                }
            }
            // The error text can name this computer's folders.
            if let Some(o) = v.as_object_mut() {
                o.remove("error");
            }
        }
        // Where a chat works on this computer is not theirs to see.
        "history" | "thread" => {
            if let Some(o) = v.as_object_mut() {
                o.remove("folder");
            }
        }
        "kithInfo" => {
            let info = if v["info"].is_object() {
                let pick = ["name", "description", "avatar"].map(|k| (k, v["info"][k].clone()));
                Value::Object(pick.into_iter().filter(|(_, x)| !x.is_null()).map(|(k, x)| (k.to_owned(), x)).collect())
            } else {
                Value::Null
            };
            v = json!({"info": info, "fetchedAt": v["fetchedAt"]});
        }
        _ => {}
    }
    v
}

/// Whose chat a bot is: `Some(None)` is the owner's, `None` an unknown bot.
#[allow(clippy::option_option, reason = "an unknown bot and the owner's chat are different answers")]
fn bot_person(store: &Store, id: &str) -> Option<Option<String>> {
    store.bot(id).ok().flatten().map(|r| r.config.person)
}

/// One live or catch-up event, for the owner (`who` None) or for `person`: the owner never sees an invitee's chats,
/// an invitee sees only their own, and no invitee sees usage, screens or the cloud.
pub fn event_for(store: &Store, who: Option<&str>, v: Value) -> Option<Value> {
    let kind = v["type"].as_str().unwrap_or_default().to_owned();
    let bot = match kind.as_str() {
        "bot" => v["bot"]["id"].as_str().map(str::to_owned),
        "entry" => v["entry"]["botId"].as_str().or_else(|| v["entry"]["bot_id"].as_str()).map(str::to_owned),
        "resync" => return Some(v),
        _ => return who.is_none().then_some(v),
    };
    let owner = bot.as_deref().and_then(|b| bot_person(store, b));
    match (who, owner) {
        // The owner answers the permission prompts of an invitee's runs (a guest's always, a member's when they like);
        // nothing else of the chat reaches them.
        (None, Some(Some(_))) => (kind == "entry" && v["entry"]["kind"] == "permission").then_some(v),
        (None, _) => Some(v),
        (Some(me), Some(Some(p))) if p == me => {
            let agents = store.person(me).map(|p| p.agents).unwrap_or_default();
            let granted =
                store.bot(bot.as_deref()?).ok().flatten()?.config.hq_agent.is_some_and(|a| agents.contains_key(&a));
            if !granted {
                return None;
            }
            Some(shape_bot(v))
        }
        (Some(_), _) => None,
    }
}

/// A bot as an invitee sees it: the agent's folder on this computer is not theirs to see.
pub fn shape_bot(mut v: Value) -> Value {
    if let Some(b) = v["bot"].as_object_mut() {
        b.remove("cwd");
        b.remove("command");
        b.remove("folder");
    }
    v
}

/// The first event of a stream, trimmed for an invitee.
pub fn hello_for(v: &Value) -> Value {
    json!({"type": "hello", "hostId": v["hostId"], "computerId": v["computerId"], "rev": v["rev"]})
}
