//! Inviting people to this computer, and the owner's view of them: invites, people, what each may use, revoking, the
//! audit log. The owner-only methods are simply absent from `roles::MEMBER_METHODS`; `startChat` is the one method here
//! an invited person calls.
//!
//! kith-auth is the truth about who may use which agent; this module only calls it. The cloud is told about the invite
//! and learns of memberships back through `remote::members`.

use super::devices::{Caller, NotAllowed, Principal, principal};
use super::{roles, str_arg};
use crate::LockExt;
use crate::hub::Hub;
use crate::remote::{account, cloud, crypto};
use crate::store::{Invite, PersonRow, now_ms};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::ops::ControlFlow;
use std::path::Path;
use std::sync::Arc;

/// An invite's link stays good this long.
const INVITE_MS: i64 = 24 * 60 * 60 * 1000;
/// Dollars a month an invited person's runs of one agent may cost, until the owner changes it.
const BUDGET: &str = "20";

/// kith-auth rewrites auth.json whole on every change: one writer at a time.
static AUTH_WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) async fn call(hub: &Arc<Hub>, caller: &Caller, method: &str, b: Value) -> Result<ControlFlow<Value, Value>> {
    Ok(ControlFlow::Break(match method {
        "createInvite" => create_invite(hub, &b).await?,
        "invites" => json!({"invites": hub.store.invites()?}),
        "revokeInvite" => revoke_invite(hub, str_arg(&b, "inviteId")?).await?,
        "people" => people(hub)?,
        "setPersonAccess" => set_person_access(hub, &b).await?,
        "revokePerson" => revoke_person(hub, str_arg(&b, "personId")?).await?,
        "audit" => json!({"audit": hub.store.audit_list(b["since"].as_i64().unwrap_or(0), b["personId"].as_str())?}),
        "startChat" => start_chat(hub, caller, &b).await?,
        _ => return Ok(ControlFlow::Continue(b)),
    }))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// A person id from a name: lowercase letters, digits and dashes, starting with a letter (kith-auth's rule).
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_owned();
    match out.chars().next() {
        Some(c) if c.is_ascii_lowercase() => out,
        Some(_) => format!("p-{out}"),
        None => "guest".to_owned(),
    }
}

fn roles_of(b: &Value) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for (agent, role) in b.as_object().ok_or_else(|| anyhow!("`agents` is required, like {{\"house\": \"member\"}}"))? {
        match role.as_str() {
            Some(r @ ("member" | "guest")) => out.insert(agent.clone(), r.to_owned()),
            _ => bail!("{agent}: the role is `member` or `guest`"),
        };
    }
    Ok(out)
}

/// kith-auth, or why not.
async fn auth_bin() -> Result<std::path::PathBuf> {
    account::bin().await.ok_or_else(|| anyhow!("kith-auth wasn't found on this computer, so people can't be invited."))
}

async fn person_exists(bin: &Path, id: &str) -> bool {
    account::run(bin, &["people", id]).await.is_ok()
}

async fn grant(bin: &Path, person: &str, agent: &str, role: &str, fresh: bool) -> Result<()> {
    let preset = format!("preset={role}");
    let mut args = vec!["member", agent, person, preset.as_str()];
    // A first grant carries the default budget; a changed role keeps whatever budget the owner set since.
    let budget = format!("budget={BUDGET}");
    if fresh {
        args.push(&budget);
    }
    account::run(bin, &args).await.map(drop)
}

/// What a failed `createInvite` puts back.
#[derive(Default)]
struct Undo {
    person: Option<String>,
    agents: Vec<(String, String)>,
}

impl Undo {
    async fn run(self, hub: &Hub, bin: &Path) {
        for (person, agent) in &self.agents {
            account::run(bin, &["member", agent, person, "--rm"]).await.ok();
        }
        if let Some(p) = &self.person {
            account::run(bin, &["person", p, "--rm"]).await.ok();
            hub.store.delete_person(p).ok();
        }
    }
}

async fn create_invite(hub: &Arc<Hub>, b: &Value) -> Result<Value> {
    if hub.cloud.status().owner.is_none() {
        bail!("Sign in to a Kith account on this computer first: invites need it to be claimed.");
    }
    if cloud::url(&hub.store).is_none() {
        bail!("The Kith cloud is off on this computer, so an invite can't be sent.");
    }
    let agents = roles_of(&b["agents"])?;
    let bin = auth_bin().await?;
    account::person_of(&bin, &Principal::Owner).await?;
    let _w = AUTH_WRITES.lock().await;

    let mut undo = Undo::default();
    let outcome = make_invite(hub, &bin, b, &agents, &mut undo).await;
    if outcome.is_err() {
        undo.run(hub, &bin).await;
    }
    outcome
}

async fn make_invite(
    hub: &Arc<Hub>,
    bin: &Path,
    b: &Value,
    agents: &BTreeMap<String, String>,
    undo: &mut Undo,
) -> Result<Value> {
    let person = match (b["personId"].as_str().filter(|s| !s.is_empty()), b["name"].as_str().map(str::trim)) {
        (Some(id), _) => {
            if !person_exists(bin, id).await {
                bail!("There is no person `{id}` in kith-auth.");
            }
            if account::who(bin, "-").await.owner_id.as_deref() == Some(id) {
                bail!("That is you: the owner doesn't need an invite.");
            }
            hub.store.put_person(id, id)?;
            id.to_owned()
        }
        (None, Some(name)) if !name.is_empty() => {
            let base = slug(name);
            let mut id = base.clone();
            let mut n = 1;
            // The same name again is the same person; another person's id is never taken over.
            while person_exists(bin, &id).await && hub.store.person(&id).is_none_or(|p| p.name != name) {
                n += 1;
                id = format!("{base}-{n}");
            }
            if !person_exists(bin, &id).await {
                let arg = format!("name={name}");
                account::run(bin, &["person", &id, &arg]).await?;
                undo.person = Some(id.clone());
            }
            hub.store.put_person(&id, name)?;
            id
        }
        _ => bail!("Give the person's `name`, or the `personId` of someone kith already knows."),
    };
    for (agent, role) in agents {
        let had = roles::may_use(&person, agent).await;
        grant(bin, &person, agent, role, !had).await.with_context(|| format!("giving {person} {agent}"))?;
        if !had {
            undo.agents.push((person.clone(), agent.clone()));
        }
    }
    let token = crypto::b64(&crypto::random::<32>());
    let invite_id = format!("inv_{}", hex(&crypto::random::<12>()));
    let now = now_ms();
    let invite = Invite {
        invite_id: invite_id.clone(),
        person_id: person.clone(),
        token_hash: hex(&crypto::sha256(&[token.as_bytes()])),
        agents: agents.clone(),
        created_at: now,
        expires_at: now + INVITE_MS,
        used_at: None,
        revoked_at: None,
    };
    hub.store.put_invite(&invite)?;
    let body = json!({"inviteId": invite_id, "tokenHash": invite.token_hash, "expiresAt": invite.expires_at});
    if let Err(e) = cloud::post(hub, "/v1/host/invites", &body).await {
        hub.store.delete_invite(&invite_id).ok();
        return Err(e.context("The Kith cloud didn't take the invite, so none was made"));
    }
    // Only now: a refused invite leaves the mirror as it was.
    let mut mirror = hub.store.person(&person).map(|p| p.agents).unwrap_or_default();
    mirror.extend(agents.clone());
    hub.store.set_person_agents(&person, &mirror)?;
    let link = format!("kith://invite?c={}&i={}&t={}", hub.identity.computer_id(), invite_id, token);
    Ok(json!({"inviteId": invite_id, "link": link, "expiresAt": invite.expires_at, "personId": person}))
}

async fn revoke_invite(hub: &Arc<Hub>, id: &str) -> Result<Value> {
    let revoked = hub.store.revoke_invite(id)?;
    let mut in_cloud = false;
    if revoked {
        match cloud::post(hub, &format!("/v1/host/invites/{id}/revoke"), &json!({})).await {
            Ok(_) => in_cloud = true,
            // Accepted there already: the membership is the thing to revoke, and this host won't honour it.
            Err(e) if cloud::refused_with(&e, 404) || cloud::refused_with(&e, 409) => {}
            Err(e) => tracing::warn!(error = format!("{e:#}"), invite = id, "couldn't revoke an invite in the cloud"),
        }
    }
    Ok(json!({"revoked": revoked, "cloud": in_cloud}))
}

fn people(hub: &Arc<Hub>) -> Result<Value> {
    let now = now_ms();
    let connected = hub.connected.locked().clone();
    let memberships = hub.store.memberships()?;
    let invites = hub.store.invites()?;
    let rows: Vec<Value> = hub
        .store
        .people()?
        .into_iter()
        .map(|p: PersonRow| {
            let devices: Vec<Value> = hub
                .store
                .devices_of(&p.person_id)
                .unwrap_or_default()
                .into_iter()
                .map(|d| {
                    json!({"key": d.key, "name": d.name, "platform": d.platform, "lastSeenAt": d.last_seen_at,
                    "connected": connected.contains_key(&d.key)})
                })
                .collect();
            let joined = memberships.iter().find(|m| m.person_id == p.person_id);
            let waiting = invites.iter().filter(|i| i.person_id == p.person_id && i.open(now)).count();
            json!({
                "personId": p.person_id, "name": p.name, "agents": p.agents, "projects": p.projects,
                "joined": joined.is_some(), "userId": joined.map(|m| m.user_id.clone()),
                "membershipId": joined.map(|m| m.membership_id.clone()),
                "openInvites": waiting, "devices": devices, "createdAt": p.created_at,
            })
        })
        .collect();
    Ok(json!({"people": rows}))
}

fn invited_person(hub: &Hub, id: &str) -> Result<PersonRow> {
    hub.store.person(id).ok_or_else(|| anyhow!("`{id}` isn't someone you invited"))
}

async fn set_person_access(hub: &Arc<Hub>, b: &Value) -> Result<Value> {
    let id = str_arg(b, "personId")?;
    let person = invited_person(hub, id)?;
    let bin = auth_bin().await?;
    let _w = AUTH_WRITES.lock().await;
    if !b["agents"].is_null() {
        let want = roles_of(&b["agents"])?;
        for (agent, role) in &want {
            let had = person.agents.contains_key(agent) && roles::may_use(id, agent).await;
            grant(&bin, id, agent, role, !had).await.with_context(|| format!("giving {id} {agent}"))?;
        }
        for agent in person.agents.keys().filter(|a| !want.contains_key(*a)) {
            account::run(&bin, &["member", agent, id, "--rm"]).await?;
        }
        hub.store.set_person_agents(id, &want)?;
    }
    if !b["projects"].is_null() {
        let projects: Vec<String> =
            serde_json::from_value(b["projects"].clone()).context("`projects` is a list of project ids")?;
        hub.store.set_person_projects(id, &projects)?;
    }
    Ok(json!({"person": hub.store.person(id)}))
}

async fn revoke_person(hub: &Arc<Hub>, id: &str) -> Result<Value> {
    let person = invited_person(hub, id)?;
    let bin = account::bin().await;
    {
        let _w = AUTH_WRITES.lock().await;
        if let Some(bin) = &bin {
            for agent in person.agents.keys() {
                account::run(bin, &["member", agent, id, "--rm"]).await?;
            }
        } else if !person.agents.is_empty() {
            bail!("kith-auth wasn't found, so {id}'s agents can't be taken away.");
        }
    }
    hub.store.set_person_agents(id, &BTreeMap::new())?;
    for invite in hub.store.invites()?.into_iter().filter(|i| i.person_id == id && i.open(now_ms())) {
        revoke_invite(hub, &invite.invite_id).await?;
    }
    crate::remote::members::end_access(hub, bin.as_deref(), id).await?;
    for m in hub.store.memberships()?.into_iter().filter(|m| m.person_id == id) {
        hub.store.remove_membership(&m.membership_id)?;
        crate::remote::members::revoke_in_cloud(hub, &m.membership_id).await;
    }
    Ok(json!({"revoked": true}))
}

/// `startChat`: an invited person's own chat with an agent granted to them (one per agent), made from the owner's bot
/// of that agent so it works in the agent's own folder with the agent's own prompt.
async fn start_chat(hub: &Arc<Hub>, caller: &Caller, b: &Value) -> Result<Value> {
    let Principal::Member(person) = principal(&hub.store, caller) else {
        bail!("Your chat with an agent is the one on the home screen.");
    };
    let agent = str_arg(b, "agent")?;
    let granted = hub.store.person(&person).is_some_and(|p| p.agents.contains_key(agent));
    if !granted || !roles::may_use(&person, agent).await {
        return Err(NotAllowed(format!("You don't have access to {agent}.")).into());
    }
    let rows = hub.store.bots()?;
    let mine = |r: &&crate::store::BotRow| r.config.hq_agent.as_deref() == Some(agent) && !r.deleted;
    if let Some(row) = rows.iter().filter(mine).find(|r| r.config.person.as_deref() == Some(person.as_str())) {
        return Ok(roles::shape_bot(json!({"bot": hub.bot_json(row)})));
    }
    let template = rows
        .iter()
        .filter(|r| r.config.hq_agent.as_deref() == Some(agent) && r.config.person.is_none())
        .max_by_key(|r| !r.deleted)
        .ok_or_else(|| anyhow!("{agent} isn't set up on this computer."))?;
    let c = &template.config;
    let cfg = serde_json::from_value(json!({
        "id": "", "name": c.name, "description": c.description, "backend": "claude", "cwd": c.cwd,
        "hqAgent": agent, "permission": "ask", "tasks": false, "connectors": [], "skills": [], "person": person,
    }))
    .expect("a valid bot");
    let hub = hub.clone();
    let bot = tokio::task::spawn_blocking(move || hub.create_bot(cfg)).await??;
    Ok(roles::shape_bot(json!({"bot": bot})))
}
