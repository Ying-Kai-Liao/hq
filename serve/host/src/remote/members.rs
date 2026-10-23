//! Invited people, from the cloud's side: which accounts it lists as members of this computer. The cloud only records
//! who accepted which invite; this host decides. It honours a membership only when its invite is one this host made
//! and still has open, binds the account to that invite's kith-auth person, and drops the person's devices when the
//! cloud stops listing the membership.

use super::account;
use crate::hub::Hub;
use crate::store::{Membership, Store, now_ms};
use anyhow::Result;
use serde::Deserialize;
use serde_json::json;
use std::path::Path;

/// kv: membership ids the cloud has not yet confirmed as revoked (JSON array).
const PENDING_REVOKES: &str = "membership_revokes";

/// One active membership of `GET /v1/host/state`.
#[allow(clippy::struct_field_names, reason = "wire names")]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub membership_id: String,
    pub user_id: String,
    pub invite_id: String,
}

/// Applies the cloud's membership list. `None` (an older cloud that doesn't list them) changes nothing. Never fails
/// the pull: a problem is logged and the next pull tries again.
pub async fn sync(hub: &Hub, listed: Option<&[Listed]>, owner_uid: Option<&str>) {
    let Some(listed) = listed else { return };
    let bin = account::bin().await;
    if let Err(e) = apply(hub, bin.as_deref(), listed, owner_uid).await {
        tracing::warn!(error = format!("{e:#}"), "couldn't apply the cloud's memberships");
    }
    if let Err(e) = hub.store.audit_prune(now_ms()) {
        tracing::warn!(error = format!("{e:#}"), "couldn't prune the audit log");
    }
}

/// A Kith account id as kith-auth takes it. Anything else the cloud sends is not an account.
fn valid_user_id(id: &str) -> bool {
    id.strip_prefix("user_").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

pub async fn apply(hub: &Hub, bin: Option<&Path>, listed: &[Listed], owner_uid: Option<&str>) -> Result<()> {
    let known = hub.store.memberships()?;
    for m in listed.iter().filter(|m| !known.iter().any(|k| k.membership_id == m.membership_id)) {
        if !valid_user_id(&m.user_id) || owner_uid == Some(m.user_id.as_str()) {
            tracing::warn!(
                membership = m.membership_id,
                "ignoring a membership with an invalid or the owner's account"
            );
            continue;
        }
        let Some(invite) = hub.store.invite(&m.invite_id).filter(|i| i.open(now_ms())) else {
            // Not ours (or used up, revoked, expired): nothing here grants it, so it stays a name in the cloud.
            tracing::debug!(membership = m.membership_id, "ignoring a membership this computer didn't invite");
            continue;
        };
        if hub.store.membership_of_user(&m.user_id).is_some() {
            tracing::warn!(membership = m.membership_id, "this account is already a member under another invite");
            continue;
        }
        let Some(bin) = bin else {
            tracing::warn!("kith-auth not found; can't bind an invited account to its person");
            continue;
        };
        if let Err(e) = account::run(bin, &["handle", &invite.person_id, "kith", &m.user_id]).await {
            tracing::warn!(error = format!("{e:#}"), person = invite.person_id, "couldn't bind the invited account");
            continue;
        }
        if !hub.store.use_invite(&invite.invite_id, now_ms())? {
            // Revoked or used between the check and now.
            account::run(bin, &["handle", &invite.person_id, "kith", "--rm"]).await.ok();
            continue;
        }
        hub.store.add_membership(&Membership {
            membership_id: m.membership_id.clone(),
            user_id: m.user_id.clone(),
            person_id: invite.person_id.clone(),
            invite_id: invite.invite_id,
            created_at: now_ms(),
        })?;
        tracing::info!(person = invite.person_id, "an invited account joined");
    }
    for gone in known.iter().filter(|k| !listed.iter().any(|m| m.membership_id == k.membership_id)) {
        tracing::info!(person = gone.person_id, "membership gone from the cloud; removing the person's devices");
        hub.store.remove_membership(&gone.membership_id)?;
        end_access(hub, bin, &gone.person_id).await?;
    }
    Ok(())
}

/// Ends a person's access once a membership of theirs is gone (and already removed from the store). With no membership
/// left, every device goes and the account is unbound; with another still active, its handle is kept (pointed at it) and
/// the gone account's devices fall with their grants. Their agents' memberships and memory stay.
pub async fn end_access(hub: &Hub, bin: Option<&Path>, person: &str) -> Result<()> {
    let remaining: Vec<Membership> = hub.store.memberships()?.into_iter().filter(|m| m.person_id == person).collect();
    let Some(still) = remaining.first() else {
        for d in hub.store.devices_of(person)? {
            hub.revoke_device(&d.key)?;
        }
        // Their bot guests lose their owner with the last membership.
        crate::api::botguests::revoke_owned_by(hub, person, "person").await;
        if let Some(bin) = bin
            && let Err(e) = account::run(bin, &["handle", person, "kith", "--rm"]).await
        {
            tracing::warn!(error = format!("{e:#}"), person, "couldn't remove an invited account's handle");
        }
        return Ok(());
    };
    if let Some(bin) = bin
        && let Err(e) = account::run(bin, &["handle", person, "kith", &still.user_id]).await
    {
        tracing::warn!(error = format!("{e:#}"), person, "couldn't keep an invited account's handle");
    }
    Ok(())
}

fn pending(store: &Store) -> Vec<String> {
    store.kv_get(PENDING_REVOKES).and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn set_pending(store: &Store, ids: &[String]) {
    let saved = serde_json::to_string(ids).map_err(anyhow::Error::from).and_then(|v| store.kv_set(PENDING_REVOKES, &v));
    if let Err(e) = saved {
        tracing::warn!(error = format!("{e:#}"), "couldn't remember a membership to revoke");
    }
}

/// Tells the cloud a membership ended here; a failure is retried on later pulls (local access is already gone).
pub async fn revoke_in_cloud(hub: &Hub, membership_id: &str) {
    let mut ids = pending(&hub.store);
    if !ids.iter().any(|i| i == membership_id) {
        ids.push(membership_id.to_owned());
        set_pending(&hub.store, &ids);
    }
    retry_revokes(hub).await;
}

pub async fn retry_revokes(hub: &Hub) {
    let ids = pending(&hub.store);
    if ids.is_empty() {
        return;
    }
    let mut left = vec![];
    for id in ids {
        match super::cloud::post(hub, &format!("/v1/host/memberships/{id}/revoke"), &json!({})).await {
            Ok(_) => {}
            Err(e) if super::cloud::refused_with(&e, 404) => {}
            Err(e) => {
                tracing::warn!(error = format!("{e:#}"), membership = id, "couldn't revoke a membership in the cloud");
                left.push(id);
            }
        }
    }
    set_pending(&hub.store, &left);
}
