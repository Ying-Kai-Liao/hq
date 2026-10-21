//! The places a bot talks (its own chat, each thread, each group lane): the keys of their actors, and the turns a
//! previous host process cut off in them.

use crate::store::{Lane, Store, now_ms};

/// An interrupted turn older than this isn't resumed.
const STALE_RESUME_MS: i64 = 60 * 60 * 1000;

/// The runtime and kv name of the actor for `home`: the bot's id for its own chat, `bot|lane` for any other place.
pub fn actor_key(bot: &str, home: &Lane) -> String {
    if home.chat == bot && home.thread.is_none() { bot.to_owned() } else { format!("{bot}|{}", home.key()) }
}

/// The bot an actor key belongs to.
pub fn bot_of(key: &str) -> &str {
    key.split_once('|').map_or(key, |(bot, _)| bot)
}

/// The place an actor key names.
pub fn place_of(key: &str) -> Lane {
    let Some((_, place)) = key.split_once('|') else { return Lane::main(key) };
    match place.split_once('/') {
        Some((chat, root)) => Lane::in_thread(chat, root),
        None => Lane::main(place),
    }
}

/// kv key of the running-turn record of the actor `key`.
pub(super) fn inflight_key(key: &str) -> String {
    format!("turn.inflight.{key}")
}

/// Where the turn the previous host process never finished in `home` talked (crash, update, restart), unless
/// it's stale: an hour-old task is more likely unwanted than awaited (gawkbot's rule).
pub(super) fn interrupted(store: &Store, key: &str, home: &Lane) -> Option<Lane> {
    let v = store.kv_get(&inflight_key(key))?;
    let (started, thread) = v.split_once('\t').unwrap_or((&v, ""));
    let started: i64 = started.parse().ok()?;
    let thread = (!thread.is_empty()).then(|| thread.to_owned()).or_else(|| home.thread.clone());
    (now_ms() - started < STALE_RESUME_MS).then(|| Lane { chat: home.chat.clone(), thread })
}

/// The places besides its own chat where the previous host process cut off one of the bot's turns. Records too old
/// to resume are cleared, so they don't start an actor again on every host start.
pub fn interrupted_places(store: &Store, bot: &str) -> Vec<Lane> {
    let all = inflight_key("");
    let mut places = vec![];
    for key in store.kv_prefix(&inflight_key(&format!("{bot}|"))) {
        let Some(actor) = key.strip_prefix(&all) else { continue };
        let home = place_of(actor);
        if interrupted(store, actor, &home).is_some() {
            places.push(home);
        } else if store.kv_get(&key).is_some_and(|v| !v.is_empty())
            && let Err(error) = store.kv_set(&key, "")
        {
            tracing::warn!(actor, error = format!("{error:#}"), "couldn't clear an old running-turn record");
        }
    }
    places
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_actor_key_names_its_bot_and_place() {
        for home in [Lane::main("b"), Lane::in_thread("b", "root"), Lane::main("group"), Lane::in_thread("group", "r")]
        {
            let key = actor_key("b", &home);
            assert_eq!(bot_of(&key), "b");
            assert_eq!(place_of(&key), home);
        }
        assert_eq!(actor_key("b", &Lane::main("b")), "b", "the bot's own chat is the bot");
    }

    #[test]
    fn only_recent_interrupted_places_resume_and_old_records_are_cleared() {
        let dir = std::env::temp_dir().join(format!("kith-place-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("db.sqlite")).unwrap();
        let recent = actor_key("b", &Lane::in_thread("b", "fresh"));
        let old = actor_key("b", &Lane::main("group"));
        store.kv_set(&inflight_key(&recent), &now_ms().to_string()).unwrap();
        store.kv_set(&inflight_key(&old), &(now_ms() - STALE_RESUME_MS - 1).to_string()).unwrap();
        store.kv_set(&inflight_key(&actor_key("b", &Lane::in_thread("b", "done"))), "").unwrap();

        assert_eq!(interrupted_places(&store, "b"), vec![Lane::in_thread("b", "fresh")]);
        assert_eq!(store.kv_get(&inflight_key(&old)).as_deref(), Some(""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
