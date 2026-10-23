use super::{Audience, Judgement, NoteFacets, Plan, Promote, Roster, Snapshot, audit, judge, set_frontmatter};

fn aud(s: &str) -> Audience {
    Audience::parse(s).unwrap()
}

fn roster() -> Roster {
    Roster::default().with_room("duo", &["owner", "sam"]).with_room("trio", &["sam", "eve"]).with_room("solo", &[])
}

#[test]
fn the_order_allows_only_the_same_readers_or_fewer() {
    // (from, to, allowed)
    let table = [
        ("room:trio", "owner", true),
        ("person:sam", "owner", true),
        ("shared", "owner", true),
        ("shared", "person:sam", true),
        ("shared", "room:trio", true),
        ("shared", "room:unknown", true),
        ("owner", "owner", true),
        ("owner", "person:sam", false),
        ("owner", "shared", false),
        ("owner", "room:solo", true),
        ("owner", "room:duo", false),
        ("person:sam", "person:sam", true),
        ("person:sam", "person:eve", false),
        ("person:sam", "shared", false),
        ("person:sam", "room:duo", true),
        ("person:sam", "room:trio", false),
        ("person:sam", "room:unknown", false),
        ("room:trio", "person:sam", true),
        ("room:trio", "person:bob", false),
        ("room:trio", "room:duo", true),
        ("room:duo", "room:trio", false),
        ("room:trio", "shared", false),
        ("room:unknown", "person:sam", false),
        ("room:unknown", "room:unknown", true),
        ("room:unknown", "owner", true),
    ];
    let r = roster();
    for (from, to, allowed) in table {
        assert_eq!(r.within(&aud(to), &aud(from)), allowed, "{from} -> {to}");
    }
}

fn note(file: &str, audience: &str) -> NoteFacets {
    NoteFacets { file: file.into(), audience: aud(audience), room: String::new(), projects: vec![] }
}

fn retag(file: &str, audience: Option<&str>) -> Promote {
    Promote { file: file.into(), audience: audience.map(Into::into), ..Promote::default() }
}

#[test]
fn retagging_projects_or_room_alone_changes_no_readers() {
    let n = note("people/sam/a.md", "person:sam");
    let want = Promote { projects: Some(vec!["kith".into()]), room: Some("duo".into()), ..retag(&n.file, None) };
    assert!(matches!(judge(&n, &want, &roster()), Ok(Judgement::Allowed(_))));
    assert_eq!(judge(&n, &retag(&n.file, Some("person:sam")), &roster()), Ok(Judgement::Nothing));
    assert!(judge(&n, &retag(&n.file, Some("person:")), &roster()).is_err());
}

#[test]
fn audit_keeps_allowed_and_widening_but_drops_the_rest() {
    let facets = vec![note("a.md", "owner"), note("people/sam/b.md", "person:sam")];
    let snapshot = Snapshot::from_parts("a", false, vec![], vec![], false, "2026-10-17").with_facets(facets, roster());
    let plan = Plan {
        promote: vec![
            retag("people/sam/b.md", Some("owner")),
            retag("a.md", Some("shared")),
            retag("a.md", Some("shared")),
            retag("nope.md", Some("owner")),
            retag("a.md", Some("owner")),
            retag("a.md", Some("everyone")),
        ],
        ..Plan::default()
    };
    let (kept, rejected) = audit(&snapshot, &[], plan);
    assert_eq!(kept.promote.iter().map(|p| p.audience.as_deref().unwrap()).collect::<Vec<_>>(), ["owner", "shared"]);
    assert_eq!(rejected.len(), 4, "{rejected:?}");
    // Memory without facets keeps none.
    let bare = Snapshot::from_parts("a", false, vec![], vec![], false, "2026-10-17");
    let (kept, _) = audit(&bare, &[], Plan { promote: vec![retag("a.md", Some("owner"))], ..Plan::default() });
    assert_eq!(kept.promote, vec![]);
}

#[test]
fn a_note_with_hand_edited_wider_frontmatter_stays_at_its_default() {
    let none = |_: i64, _: &str| false;
    let text = "---\naudience: shared\n---\nx";
    assert_eq!(NoteFacets::read("echo", "MEMORY.md", text, &none).audience, Audience::Owner);
    // A named change only counts when it is vouched for with that very audience.
    let forged = "---\naudience: shared\napproved_change: 7\n---\nx";
    assert_eq!(NoteFacets::read("echo", "MEMORY.md", forged, &none).audience, Audience::Owner);
    let vouched = |id: i64, a: &str| id == 7 && a == "shared";
    assert_eq!(NoteFacets::read("echo", "MEMORY.md", forged, &vouched).audience, Audience::Shared);
    let other = "---\naudience: room:x\napproved_change: 7\n---\nx";
    assert_eq!(NoteFacets::read("echo", "MEMORY.md", other, &vouched).audience, Audience::Owner);
    let f = NoteFacets::read("echo", "people/Sam/a.md", "", &none);
    assert_eq!((f.audience, f.room.as_str()), (aud("person:sam"), "1:1:echo:sam"));
}

#[test]
fn set_frontmatter_edits_in_place_or_creates() {
    let up = [("audience", Some("owner".to_owned())), ("approved_change", None)];
    assert_eq!(set_frontmatter("body\n", &up), "---\naudience: owner\n---\nbody\n");
    let text = "---\ndescription: d\naudience: shared\napproved_change: 3\n---\nbody\n";
    assert_eq!(set_frontmatter(text, &up), "---\ndescription: d\naudience: owner\n---\nbody\n");
}
