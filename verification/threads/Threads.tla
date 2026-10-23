---------------------------- MODULE Threads ----------------------------
(***************************************************************************)
(* One thread = one Claude session. Who may write to it, and when.         *)
(*                                                                         *)
(* Writers: a terminal `kith <agent>` (its claude process holds the        *)
(* session while it lives), the host's turn actor (an app send, a bot      *)
(* guest's ask, a turn resumed after a restart).                           *)
(*                                                                         *)
(* Since #147 a writer also takes a CLAIM, a file                          *)
(* $KITH_STATE/live/terminal/<sid>.claim, before it checks the others      *)
(* (check-after-claim, Dekker style), and the host checks and starts its   *)
(* turn under one per-thread lock that the kernel's second resolveThread   *)
(* call takes too.                                                         *)
(*                                                                         *)
(* Every action names the code it models. One atomic step in the code is   *)
(* one action here; a check followed later by the act it guards is TWO     *)
(* actions, so another writer can act in between.                          *)
(*                                                                         *)
(* Code (sync refs in .claude/skills/thread-writers/SKILL.md):             *)
(*   K = kernel/bin/kith-sessions, kernel/bin/kith                         *)
(*   C = serve/host/src/terminal/claim.rs                                  *)
(*   R = serve/host/src/terminal/registry.rs                               *)
(*   S = serve/host/src/terminal/sync.rs                                   *)
(*   T = serve/host/src/api/threads.rs, api/bots.rs (send), api/botguests.rs (ask) *)
(*   Q = serve/host/src/agent/bot/{queue,turn,session}.rs                  *)
(*   A = serve/host/src/hub/actors.rs (working_lanes)                      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Terminals,        \* terminal runs that may resume the thread, each run once: {"t1","t2"}
    MaxSends,         \* how many app sends + bot asks one run may make
    StartTerminalBorn,\* TRUE: also start from a thread born in a live terminal (t1)
    \* --- what the code does today (TRUE). FALSE = a broken variant, to show a property can fail.
    \* host: the send gate, S before_send_blocking -> held()
    SendChecksLive,        \* held(): the registry file / the host's copy says the terminal is live
    TakingBlocksSend,      \* held(): a take-over runs (`taking`)
    GateReadsDisk,         \* held(): reads the claim files and the registry file of the lane's session NOW (not only the 3 s copy)
    GateChecksClaim,       \* held(): a terminal's claim or a take-over's claim (claim::holder)
    SyncAtGate,            \* before_send_blocking: sync_one (adopt a fork, import, forget) after the check
    \* host: the turn start and the turn's own claim
    StartGate,             \* Q turn.rs start_turn -> S start_gate: held() again, under the lock, with `begin` inside it
    HostTakesTurnClaim,    \* Q turn.rs claim_for_turn: Kind::App claim on the ACP process for the turn's session
    BusyCountsQueued,      \* S resolve(): hostBusy also counts a send whose entry still says `queued`
    BusyCountsTaking,      \* S resolve(): hostBusy also counts a take-over in progress
    TakeoverClaims,        \* S take_over_inner: holds <sid>.takeover.claim from the check to the import
    TakeoverRefusesBusy,   \* S take_over_inner: Live::Busy -> TerminalBusy
    TakeoverRechecks,      \* S take_over_inner: liveness again just before the signal
    ForgetsCache,          \* S forget_loaded -> Q session.rs forget_loaded: the actor drops its cached session
    ForgetOnImport,        \* S import_locked: an import that brought lines also forgets the cache
    \* kernel
    HostClaims,            \* the host answers resolveThread with "claims": 1 (FALSE: the host of b523caf7, before #147)
    ResumeClaims,          \* K resolve(): takes the writer claim before it asks the host
    ClaimAtomic,           \* K take_claim / C take: temp file linked into place, stale replaced under flock (one step)
    KernelChecksTakeover,  \* K resolve() claim(): refuses while <sid>.takeover.claim is live
    ClaimStartMatches,     \* both sides print procStart in the C locale (FALSE: a live claim of the other language looks stale)
    ResumeChecksHostBusy,  \* K resolve(): refuse while the second resolveThread says hostBusy
    ResumeChecksOpen,      \* K resolve(): refuse while the registry's pid for the session is live
    ProcStartCheck,        \* R liveness/started_as: a reused pid is not the session
    \* --- scope switches
    LaunchIsInstant,       \* TRUE: claude is up the moment resolve passes (no launch gap)
    BotEnabled,            \* a bot guest's ask can reach a thread (T api/botguests.rs ask)
    BotGate,               \* "none": the ask has no terminal gate (code today, TODO(writer claim)); "live": a what-if, the send gate
    \* --- what-ifs: fixes the code does NOT have (FALSE = code today)
    TakeoverAtomic,        \* recheck and signal as one step
    SyncLaneAtStart,       \* the turn start also adopts the registry's session (sync_one in start_gate)
    GateHoldsToSave,       \* the send holds the thread lock from the gate to the saved entry
    ResolveAdopts          \* resolveThread adopts a fork first (sync_one), so it names the last session

VARIABLES
    TS,        \* per terminal: "fresh" "peeked" "claimed" "xclear" "hostclear" "launching" "idle" "busy" "dying" "exiting" "gone"
    tm,        \* per terminal, how resolve reached the session: "none" "claims" (host with claims) "old" (host without) "down" (no host)
    csid,      \* per terminal, the session id it resolved and claimed
    hooked,    \* terminals whose SessionStart hook ran
    ghost,     \* terminals whose claude pid another process now has, sessions/<pid>.json still naming the session
    regPid,    \* the terminal named by the registry file $KITH_STATE/live/terminal/<sid>.json ("none": no file)
    regSid,    \* the session id in that file
    cur,       \* the Claude session id the last writer left (1, or 2 after a fork)
    cf,        \* per session id, who holds <sid>.claim: "none" "t1" "t2" or "host" (the ACP process of a turn)
    xc,        \* the session id whose <sid>.takeover.claim the host wrote (0: none)
    hostUp,    \* the host process runs
    infoPid,   \* the host's copy of the registry (kv terminal.info.<thread>); "none": host-only thread
    lane,      \* the session id the host's lane resumes (kv lane.session...), also the copy's session
    gs,        \* sends past the gate, entry not saved yet (the api call between before_send and add_entry)
    hq,        \* sends with a saved `queued` entry, in the actor's queue
    hr,        \* the host turn marked running (BotStatus::Working): "none" "app" "bot"
    hw,        \* the turn has its claim and writes (or, without turn claims, from the start)
    hs,        \* the session the turn writes
    orph,      \* an agent process of a turn outlived a host crash and still writes
    interr,    \* a turn was cut off by a host crash and resumes on the next start (resume_interrupted)
    taking,    \* the thread is in Terminal.taking
    to,        \* take-over progress: "none" "begun" "inspected" "claimed" "rechecked" "signalled" "finished" "untaking"
    sig,       \* whom the last take-over signalled: "none" "own" "foreign"
    n,         \* sends and asks made
    staleKv,   \* kv terminal.stale.<thread>: a terminal wrote since the host last loaded the session
    forgotten, \* the actor dropped its cached session (conn.loaded, thread_sessions): its next turn loads it again
    dirty      \* a terminal wrote to the session after the actor last loaded it (the cache is out of date)

TermVars  == <<TS, tm, csid, hooked, ghost>>
RegVars   == <<regPid, regSid, cur>>
ClaimVars == <<cf, xc>>
HostVars  == <<hostUp, infoPid, lane>>
QueueVars == <<gs, hq, n>>
TurnVars  == <<hr, hw, hs, orph, interr>>
TakeVars  == <<taking, to, sig>>
CacheVars == <<staleKv, forgotten, dirty>>

vars == <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

Sids == {1, 2}

\* Q session.rs forget_loaded(): "A turn running there is left alone."
Forgets == ForgetsCache /\ hr = "none"

Live == {"idle", "busy", "dying"}                  \* the claude process has the session open
Launched == Live \cup {"launching"}                \* the claude process runs
\* the process the claim names (kith-sessions run, i.e. the launcher shell after exec) runs
Alive == {"claimed", "xclear", "hostclear", "launching", "idle", "busy", "dying", "exiting"}
Holding == {t \in Terminals : TS[t] \in Live}
\* "has the session open or is starting to"
Claiming == {t \in Terminals : TS[t] \in {"claimed", "xclear", "hostclear", "launching", "idle", "busy", "dying"}}

\* R liveness(): pid runs, its session file names the session (and, with procStart, started when claimed).
VisOf(p) ==
    IF p = "none" THEN "closed"
    ELSE IF TS[p] = "busy" THEN "busy"
    ELSE IF TS[p] \in {"idle", "dying"} THEN "idle"
    ELSE IF TS[p] \in {"exiting", "gone"} /\ p \in ghost /\ ~ProcStartCheck THEN "idle"
    ELSE "closed"

\* R pid_runs(): kill(pid, 0).
Runs(p) == p /= "none" /\ (TS[p] \in Launched \/ (TS[p] \in {"exiting", "gone"} /\ p \in ghost))

\* C Claim::is_live(): the claimer's pid runs and started when the claim says. The pid of a terminal's claim is the
\* launcher shell (`$$`, which execs `run`); of the host's claim, the agent process of the turn.
HolderAlive(h) ==
    IF h = "none" THEN FALSE
    ELSE IF h = "host" THEN hw \/ orph
    ELSE TS[h] \in Alive

\* Who judges a claim live. K proc_start / C start_of both run `ps` with LC_ALL=C; if they did not, the other
\* language's text differs and a live claim reads as stale (ClaimStartMatches = FALSE).
KernelSeesLive(s) == cf[s] /= "none" /\ HolderAlive(cf[s]) /\ (ClaimStartMatches \/ cf[s] \in Terminals)
HostSeesLive(s)   == cf[s] \in Terminals /\ HolderAlive(cf[s]) /\ ClaimStartMatches
HostSeesFree(s)   == ~(cf[s] /= "none" /\ HolderAlive(cf[s]) /\ (ClaimStartMatches \/ cf[s] = "host"))
\* The take-over's claim: live while take_over_inner runs.
XcLive(s) == xc = s /\ to \in {"claimed", "rechecked", "signalled", "finished"}

\* R registry::read_one + liveness: the registry file of the session, read from disk now.
RegLive(s) == regPid /= "none" /\ regSid = s /\ VisOf(regPid) /= "closed"
\* the host's copy (kv terminal.info), refreshed by scan
InfoLive == infoPid /= "none" /\ VisOf(infoPid) /= "closed"

TypeOK ==
    /\ TS \in [Terminals -> {"fresh", "peeked", "claimed", "xclear", "hostclear", "launching", "idle", "busy", "dying", "exiting", "gone"}]
    /\ tm \in [Terminals -> {"none", "claims", "old", "down"}] /\ csid \in [Terminals -> Sids]
    /\ regPid \in Terminals \cup {"none"} /\ infoPid \in Terminals \cup {"none"} /\ regSid \in Sids /\ lane \in Sids
    /\ cf \in [Sids -> Terminals \cup {"none", "host"}] /\ xc \in Sids \cup {0}
    /\ hr \in {"none", "app", "bot"} /\ hs \in Sids
    /\ to \in {"none", "begun", "inspected", "claimed", "rechecked", "signalled", "finished", "untaking"}
    /\ sig \in {"none", "own", "foreign"}
    /\ Len(gs) + Len(hq) <= MaxSends /\ n <= MaxSends

-----------------------------------------------------------------------------
Init ==
    /\ n = 0 /\ gs = <<>> /\ hq = <<>> /\ hr = "none" /\ hw = FALSE /\ hs = 1 /\ orph = FALSE /\ interr = FALSE
    /\ taking = FALSE /\ to = "none" /\ sig = "none" /\ ghost = {} /\ cur = 1 /\ lane = 1 /\ regSid = 1
    /\ cf = [s \in Sids |-> "none"] /\ xc = 0 /\ hostUp = TRUE
    /\ tm = [t \in Terminals |-> "none"] /\ csid = [t \in Terminals |-> 1]
    /\ forgotten = FALSE /\ dirty = FALSE
    /\ \/ \* a thread made in the app, or one older than the terminal feature: the host knows no terminal
          /\ TS = [t \in Terminals |-> "fresh"] /\ regPid = "none" /\ infoPid = "none"
          /\ hooked = {} /\ staleKv = FALSE
       \/ \* a thread born in a terminal `kith <agent>` that is open now, hooked and already scanned. A fresh run takes
          \* no claim: its session id is new, nobody can name it before the hook writes the registry file.
          /\ StartTerminalBorn
          /\ TS = [t \in Terminals |-> IF t = "t1" THEN "idle" ELSE "fresh"]
          /\ regPid = "t1" /\ infoPid = "t1" /\ hooked = {"t1"}
          /\ staleKv = TRUE   \* S create_thread: a live terminal thread starts stale

\* ---- the app / bot side ------------------------------------------------

\* S held(): "a terminal (or a take-over) holds the thread, judged on what is on disk now": `taking`; a claim
\* (claim::holder: a terminal's, or a take-over's, not the host's own turn claim) on the lane's session; the registry
\* file of the lane's session, live; the host's copy, live. The reads are ordered claim file, registry file, process,
\* so a terminal that claims in between is seen by a later read or is after the check.
HeldNow ==
    \/ TakingBlocksSend /\ taking
    \/ GateReadsDisk /\ GateChecksClaim /\ (HostSeesLive(lane) \/ XcLive(lane))
    \/ SendChecksLive /\ ((GateReadsDisk /\ RegLive(lane)) \/ InfoLive)

\* T api/bots.rs `send` -> S before_send -> before_send_blocking(): under the thread lock: held() -> 409; else sync_one
\* (the lane's session := a fork the registry names; import; forget_loaded if lines came) and the stale mark. The lock
\* is released here: the entry is saved later (Enqueue), unless GateHoldsToSave.
AppGate ==
    /\ hostUp /\ n < MaxSends /\ ~HeldNow
    /\ IF GateHoldsToSave THEN hq' = Append(hq, "app") /\ gs' = gs ELSE gs' = Append(gs, "app") /\ hq' = hq
    /\ n' = n + 1
    /\ LET adopt == SyncAtGate /\ regPid /= "none"
           seen == adopt \/ infoPid /= "none"       \* before #147: only with a copy of the registry
       IN /\ lane' = IF adopt THEN regSid ELSE lane
          /\ infoPid' = IF adopt THEN regPid ELSE infoPid
          /\ staleKv' = IF seen THEN FALSE ELSE staleKv
          /\ forgotten' = (forgotten \/ (seen /\ (staleKv \/ (ForgetOnImport /\ SyncAtGate /\ dirty /\ regPid /= "none")) /\ Forgets))
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, hostUp, TurnVars, TakeVars, dirty>>

\* T api/botguests.rs `ask`: the entry is saved `queued` and Cmd::Send goes to the actor. No terminal gate
\* (TODO(writer claim) in the code); BotGate = "live" is the what-if of putting the send gate there.
BotAsk ==
    /\ BotEnabled /\ hostUp /\ n < MaxSends /\ (BotGate = "live" => ~HeldNow)
    /\ hq' = Append(hq, "bot") /\ n' = n + 1
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, gs, TurnVars, TakeVars, CacheVars>>

\* api/bots.rs send: `add_entry(... status "queued")`, then send_cmd(Cmd::Send); Q queue.rs on_cmd pushes Queued::User.
\* From the saved entry on, hostBusy counts it (S send_queued).
Enqueue ==
    /\ gs /= <<>>
    /\ hq' = Append(hq, Head(gs)) /\ gs' = Tail(gs)
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, n, TurnVars, TakeVars, CacheVars>>

\* Q queue.rs next_in_queue (or resume_interrupted after a restart) -> turn.rs start_turn -> S start_gate(): under the
\* thread lock, held() -> the turn fails ("liveInTerminal" notice, the message `failed`, the queue goes on); else `begin`
\* marks the runtime Working inside the same lock (A working_lanes sees it). Without turn claims (before #147) the turn
\* writes from here.
StartRefused == StartGate /\ HeldNow
HostStart ==
    /\ hostUp /\ hr = "none" /\ (interr \/ hq /= <<>>)
    /\ LET src == IF interr THEN "app" ELSE Head(hq)
           rest == IF interr THEN hq ELSE Tail(hq)
       IN /\ hq' = rest /\ interr' = FALSE
          /\ IF StartRefused
             THEN /\ UNCHANGED <<hr, hw, hs, lane, infoPid, forgotten, dirty>>
             ELSE /\ hr' = src /\ hw' = ~HostTakesTurnClaim
                  /\ hs' = IF SyncLaneAtStart /\ regPid /= "none" THEN regSid ELSE lane
                  /\ lane' = IF SyncLaneAtStart /\ regPid /= "none" THEN regSid ELSE lane
                  /\ infoPid' = IF SyncLaneAtStart /\ regPid /= "none" THEN regPid ELSE infoPid
                  \* a forgotten cache means this turn loads the session again, and so sees what the terminal wrote
                  /\ IF forgotten THEN forgotten' = FALSE /\ dirty' = FALSE ELSE UNCHANGED <<forgotten, dirty>>
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, hostUp, gs, n, orph, TakeVars, staleKv>>

\* Q turn.rs claim_for_turn: after the session is loaded and before the prompt is sent, a Kind::App claim for the agent
\* process on the turn's session (the lane's session now). A live claim there (a terminal that got in between) fails the
\* turn; a stale one (holder gone) is replaced.
HostClaim ==
    /\ hostUp /\ HostTakesTurnClaim /\ hr /= "none" /\ ~hw
    /\ IF HostSeesFree(lane)
       THEN /\ cf' = [cf EXCEPT ![lane] = "host"] /\ hw' = TRUE /\ hs' = lane /\ UNCHANGED hr
       ELSE /\ hr' = "none" /\ UNCHANGED <<cf, hw, hs>>
    /\ UNCHANGED <<TermVars, RegVars, xc, HostVars, QueueVars, orph, interr, TakeVars, CacheVars>>

\* Q turn.rs finish_turn: release_turn_claim() (only the host's own claim file), then the runtime goes Idle: two steps.
\* A turn that ended before it claimed only goes Idle. Without turn claims (before #147) it is one step.
HostRelease ==
    /\ hostUp /\ HostTakesTurnClaim /\ hr /= "none" /\ hw
    /\ cf' = IF cf[hs] = "host" THEN [cf EXCEPT ![hs] = "none"] ELSE cf
    /\ hw' = FALSE
    /\ UNCHANGED <<TermVars, RegVars, xc, HostVars, QueueVars, hr, hs, orph, interr, TakeVars, CacheVars>>

HostEnd ==
    /\ hostUp /\ hr /= "none"
    /\ IF HostTakesTurnClaim THEN ~hw /\ UNCHANGED hw ELSE hw /\ hw' = FALSE
    /\ hr' = "none"
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, hs, orph, interr, TakeVars, CacheVars>>

\* The host process dies: memory is lost (runtime, queue, taking, the actor's cache); kv (info, lane) stays; queued
\* sends are expired at the next start (store entries.rs). A running turn is recorded as in flight and resumes on the next
\* start. Its agent process may outlive the host (the claim file stays, live as long as that process).
HostDown ==
    /\ hostUp /\ hostUp' = FALSE
    /\ hq' = <<>> /\ gs' = <<>> /\ taking' = FALSE /\ to' = "none"
    /\ interr' = (interr \/ hr /= "none")
    /\ \E o \in (IF hw THEN BOOLEAN ELSE {FALSE}) : orph' = (orph \/ o)
    /\ hr' = "none" /\ hw' = FALSE
    /\ forgotten' = FALSE /\ dirty' = FALSE   \* no actor, no cache: the next turn loads the session
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, infoPid, lane, n, hs, sig, staleKv>>

HostUp ==
    /\ ~hostUp /\ hostUp' = TRUE
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, infoPid, lane, QueueVars, TurnVars, TakeVars, CacheVars>>

\* The orphaned agent process ends (its turn is over or it is killed); its claim file stays, stale.
OrphanEnd ==
    /\ orph /\ orph' = FALSE
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, hr, hw, hs, interr, TakeVars, CacheVars>>

\* ---- the terminal side -------------------------------------------------

\* S resolve(): hostBusy, read under the thread's lock: a turn marked running (A working_lanes), a send whose entry still
\* says `queued` (send_queued), a take-over in progress.
HostBusy == hr /= "none" \/ (BusyCountsQueued /\ hq /= <<>>) \/ (BusyCountsTaking /\ taking)

ModeOk(mode, s) ==
    IF mode = "claims" THEN hostUp /\ HostClaims /\ s = (IF ResolveAdopts /\ regPid /= "none" THEN regSid ELSE lane)
    ELSE IF mode = "old" THEN hostUp /\ ~HostClaims /\ regPid /= "none" /\ regSid = s   \* only a session the registry has
    ELSE ~hostUp /\ s <= cur                                                           \* the host is down: a raw session id

\* Releasing the claims of terminal t: K release_claims(pid) (die() after a claim, `run` at its end).
Gives(t) == [s \in Sids |-> IF cf[s] = t THEN "none" ELSE cf[s]]

\* K bin/kith (--resume, -r ID, the picker, -c all end here) -> kith-sessions resolve(agent, thread, $$): host_call
\* resolveThread names the session (the first answer's hostBusy is not used); an older host (no "claims": 1) or none
\* leaves the thread id as the session id. Then claim(sid) = take_claim: the temp file linked into place, a stale claim
\* replaced under flock, a live one -> exit 1. Without ResumeClaims (before #147) there is no claim.
TermClaim(t) ==
    /\ TS[t] = "fresh"
    /\ \E s \in Sids, mode \in {"claims", "old", "down"} :
        /\ ModeOk(mode, s)
        /\ csid' = [csid EXCEPT ![t] = s] /\ tm' = [tm EXCEPT ![t] = mode]
        /\ IF ResumeClaims
           THEN IF KernelSeesLive(s)
                THEN /\ TS' = [TS EXCEPT ![t] = "gone"] /\ UNCHANGED cf
                ELSE IF ClaimAtomic
                     THEN /\ TS' = [TS EXCEPT ![t] = "claimed"] /\ cf' = [cf EXCEPT ![s] = t]
                     ELSE /\ TS' = [TS EXCEPT ![t] = "peeked"] /\ UNCHANGED cf
           ELSE /\ TS' = [TS EXCEPT ![t] = "claimed"] /\ UNCHANGED cf
        /\ IF mode = "claims" /\ ResolveAdopts /\ regPid /= "none"
           THEN /\ lane' = regSid /\ infoPid' = regPid
           ELSE UNCHANGED <<lane, infoPid>>
    /\ UNCHANGED <<hooked, ghost, RegVars, xc, hostUp, QueueVars, TurnVars, TakeVars, CacheVars>>

\* The broken variant of take_claim (no link-into-place, no flock): the claim is checked in TermClaim and written here.
TermClaimWrite(t) ==
    /\ TS[t] = "peeked"
    /\ cf' = [cf EXCEPT ![csid[t]] = t] /\ TS' = [TS EXCEPT ![t] = "claimed"]
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, xc, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

Die(t) == TS' = [TS EXCEPT ![t] = "gone"] /\ cf' = Gives(t)

\* K resolve() claim(): after the claim is taken, the host's take-over claim (<sid>.takeover.claim) is read.
TermXCheck(t) ==
    /\ TS[t] = "claimed"
    /\ IF KernelChecksTakeover /\ ClaimStartMatches /\ XcLive(csid[t])
       THEN Die(t)
       ELSE TS' = [TS EXCEPT ![t] = "xclear"] /\ UNCHANGED cf
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, xc, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* K resolve(): resolveThread again with the claim held (bin/kith passes the session id): S resolve() answers the session
\* (must be the claimed one, else "the host stopped answering") and hostBusy. Dies and gives the claim back when busy.
\* Only a host with claims is asked.
TermHostCheck(t) ==
    /\ TS[t] = "xclear"
    /\ IF tm[t] = "claims" /\ (~hostUp \/ lane /= csid[t] \/ (ResumeChecksHostBusy /\ HostBusy))
       THEN Die(t)
       ELSE TS' = [TS EXCEPT ![t] = "hostclear"] /\ UNCHANGED cf
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, xc, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* K resolve(): `e = registry_entry(sid)`; `live_pid(e)` -> die (gives the claim back). Then bin/kith starts claude
\* (exec kith-sessions run -- claude); the claim is the launcher's pid until `run` ends.
TermRegCheck(t) ==
    /\ TS[t] = "hostclear"
    /\ IF ResumeChecksOpen /\ regPid /= "none" /\ regSid = csid[t] /\ TS[regPid] \in Live
       THEN Die(t)
       ELSE TS' = [TS EXCEPT ![t] = IF LaunchIsInstant THEN "idle" ELSE "launching"] /\ UNCHANGED cf
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, xc, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* claude starts and writes ~/.claude/sessions/<pid>.json: the session is open.
TermUp(t) ==
    /\ TS[t] = "launching"
    /\ TS' = [TS EXCEPT ![t] = "idle"]
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* K record(): the SessionStart hook writes the registry file (write_atomic, one file per session id: a later
\* terminal replaces the pid in it). A resumed session may be forked: a new id (resumedFrom names the old one).
\* One fork of the thread only.
TermHook(t) ==
    /\ TS[t] \in {"idle", "busy"} /\ t \notin hooked
    /\ \E c \in {csid[t]} \cup (IF csid[t] = 1 /\ cur = 1 THEN {2} ELSE {}) : cur' = c /\ regSid' = c
    /\ hooked' = hooked \cup {t} /\ regPid' = t
    /\ UNCHANGED <<TS, tm, csid, ghost, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* The user types a prompt / the turn ends (claude's own status, read by R liveness: idle vs anything else).
TermPrompt(t) ==
    /\ TS[t] = "idle" /\ t \in hooked
    /\ TS' = [TS EXCEPT ![t] = "busy"] /\ dirty' = TRUE   \* the session now holds what the host's cache lacks
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, staleKv, forgotten>>

TermDone(t) ==
    /\ TS[t] = "busy"
    /\ TS' = [TS EXCEPT ![t] = "idle"]
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* The user quits (or SIGTERM from a take-over): claude exits; `run` is still there with the claim. Or the session file
\* is left behind with the pid reused (ghost).
TermQuit(t) ==
    /\ TS[t] \in Launched
    /\ TS' = [TS EXCEPT ![t] = "exiting"]
    /\ \E g \in BOOLEAN : ghost' = IF g THEN ghost \cup {t} ELSE ghost
    /\ UNCHANGED <<tm, csid, hooked, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* K run(): after the child has exited, release_claims(own pid).
TermRelease(t) ==
    /\ TS[t] = "exiting"
    /\ TS' = [TS EXCEPT ![t] = "gone"] /\ cf' = Gives(t)
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, xc, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* The whole terminal dies (kill -9, power): no release; the claim is stale, its pid dead or reused (procStart differs).
TermCrash(t) ==
    /\ TS[t] \in Alive \cup {"peeked"}
    /\ TS' = [TS EXCEPT ![t] = "gone"]
    /\ \E g \in BOOLEAN : ghost' = IF g /\ TS[t] \in Launched THEN ghost \cup {t} ELSE ghost
    /\ UNCHANGED <<tm, csid, hooked, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, TakeVars, CacheVars>>

\* ---- the take-over (app asks the terminal to let go) ---------------------

KillTS(p) == IF TS[p] \in {"idle", "busy"} THEN [TS EXCEPT ![p] = "dying"] ELSE TS
KillSig(p) == IF TS[p] \in {"exiting", "gone"} THEN "foreign" ELSE "own"

\* S take_over(): taking.insert (a second tap while one runs is a no-op).
TakeBegin ==
    /\ hostUp /\ ~taking /\ to = "none" /\ infoPid /= "none"
    /\ taking' = TRUE /\ to' = "begun"
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, sig, CacheVars>>

\* take_over_inner: liveness of the host's copy: Closed -> no-op, Busy -> TerminalBusy, Idle -> on. (taking is removed by
\* take_over() after the inner function returns: TakeUntake.)
TakeInspect ==
    /\ hostUp /\ to = "begun"
    /\ to' = IF VisOf(infoPid) = "closed" \/ (VisOf(infoPid) = "busy" /\ TakeoverRefusesBusy) THEN "untaking" ELSE "inspected"
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, taking, sig, CacheVars>>

\* take_over_inner: claim::take(sid, Kind::App, host pid, takeover = true) (<sid>.takeover.claim), then the `.taken` note.
TakeClaim ==
    /\ hostUp /\ to = "inspected"
    /\ xc' = IF TakeoverClaims THEN lane ELSE xc
    /\ to' = "claimed"
    /\ UNCHANGED <<TermVars, RegVars, cf, HostVars, QueueVars, TurnVars, taking, sig, CacheVars>>

\* take_over_inner: `liveness(&reg) != Idle || !terminate(reg.pid)`: "Re-checked just before the signal", then
\* registry::terminate (SIGTERM). Two steps in the code: a prompt, or the pid changing hands, fits between.
TakeRecheck ==
    /\ hostUp /\ to = "claimed"
    /\ IF TakeoverRechecks /\ VisOf(infoPid) /= "idle"
       THEN to' = "finished" /\ UNCHANGED <<TS, sig>>
       ELSE IF TakeoverAtomic
            THEN IF Runs(infoPid)
                 THEN /\ TS' = KillTS(infoPid) /\ sig' = KillSig(infoPid) /\ to' = "signalled"
                 ELSE to' = "finished" /\ UNCHANGED <<TS, sig>>
            ELSE to' = "rechecked" /\ UNCHANGED <<TS, sig>>
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, taking, CacheVars>>

TakeSignal ==
    /\ hostUp /\ to = "rechecked"
    /\ IF Runs(infoPid)
       THEN TS' = KillTS(infoPid) /\ sig' = KillSig(infoPid) /\ to' = "signalled"
       ELSE to' = "finished" /\ UNCHANGED <<TS, sig>>
    /\ UNCHANGED <<tm, csid, hooked, ghost, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, taking, CacheVars>>

\* take_over_inner: waits for the process to end (EXIT_WAIT), then up to 2 s for the terminal's own claim to clear (it
\* goes on when the time is up: no guard here), imports the last lines, kv_delete stale + forget_loaded.
TakeFinish ==
    /\ hostUp /\ to = "signalled" /\ ~Runs(infoPid)
    /\ to' = "finished"
    /\ staleKv' = FALSE /\ forgotten' = (forgotten \/ Forgets)
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, taking, sig, dirty>>

TakeTimeout ==
    /\ hostUp /\ to = "signalled" /\ Runs(infoPid)
    /\ to' = "finished"
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, taking, sig, CacheVars>>

\* The ReleaseOnDrop guard of take_over_inner: on every way out the take-over claim is given back ...
TakeRelease ==
    /\ hostUp /\ to = "finished"
    /\ xc' = 0 /\ to' = "untaking"
    /\ UNCHANGED <<TermVars, RegVars, cf, HostVars, QueueVars, TurnVars, taking, sig, CacheVars>>

\* ... and take_over() removes `taking`.
TakeUntake ==
    /\ hostUp /\ to = "untaking"
    /\ taking' = FALSE /\ to' = "none"
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, HostVars, QueueVars, TurnVars, sig, CacheVars>>

\* ---- the host's registry scan (every 3 s) ------------------------------

\* S scan() -> sync_session / mapped / adopt (copy the registry, move the lane to the terminal's session), import_locked
\* (which forgets the cache when lines came) and update_state (`stale` + forget_loaded when a live terminal is seen;
\* skipped while `taking`).
Scan ==
    /\ hostUp
    /\ infoPid' = IF regPid /= "none" THEN regPid ELSE infoPid
    /\ lane' = IF regPid /= "none" THEN regSid ELSE lane
    /\ LET sawLive == ~taking /\ infoPid' /= "none" /\ VisOf(infoPid') /= "closed" /\ ~staleKv
           adopted == (regPid /= "none" /\ regSid /= lane) \/ (ForgetOnImport /\ dirty)
       IN /\ staleKv' = (staleKv \/ sawLive \/ adopted)
          /\ forgotten' = (forgotten \/ ((sawLive \/ adopted) /\ Forgets))
    /\ UNCHANGED <<TermVars, RegVars, ClaimVars, hostUp, QueueVars, TurnVars, TakeVars, dirty>>

Next ==
    \/ AppGate \/ BotAsk \/ Enqueue \/ HostStart \/ HostClaim \/ HostRelease \/ HostEnd
    \/ HostDown \/ HostUp \/ OrphanEnd
    \/ \E t \in Terminals :
          TermClaim(t) \/ TermClaimWrite(t) \/ TermXCheck(t) \/ TermHostCheck(t) \/ TermRegCheck(t)
          \/ TermUp(t) \/ TermHook(t) \/ TermPrompt(t) \/ TermDone(t) \/ TermQuit(t) \/ TermRelease(t) \/ TermCrash(t)
    \/ TakeBegin \/ TakeInspect \/ TakeClaim \/ TakeRecheck \/ TakeSignal \/ TakeFinish \/ TakeTimeout
    \/ TakeRelease \/ TakeUntake
    \/ Scan

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* ======================== PROPERTIES ====================================

\* P1. At most one writer holds the thread: a live terminal session, or a host turn that writes (or an agent process
\* that outlived a host crash and still does).
OneWriter == Cardinality(Holding) + (IF hw THEN 1 ELSE 0) + (IF orph THEN 1 ELSE 0) <= 1

\* P2. A take-over never ends a terminal that is working on a turn.
TakeoverOnlyWhenIdle == [][\A p \in Terminals : ~(TS[p] = "busy" /\ TS'[p] = "dying")]_vars

\* P2b. A take-over never signals a process that is not the session's (a reused pid).
NoForeignSignal == sig /= "foreign"

\* A resume passes its last check (and claude starts).
PassT(t) == TS[t] = "hostclear" /\ TS'[t] \in {"launching", "idle"}
Passes == \E t \in Terminals : PassT(t)

\* P3. `kith <agent> --resume` is refused while the host runs a turn in the thread (or an agent process of an earlier
\* host still writes).
ResumeRefusedWhileTurnRuns == [][Passes => (hr = "none" /\ ~orph)]_vars

\* P3b. ... and while another terminal has the session open (as far as the registry file of that session says).
ResumeRefusedWhileOpen ==
    [][\A t \in Terminals : PassT(t) => ~(regPid /= "none" /\ regSid = csid[t] /\ TS[regPid] \in Live)]_vars

\* P3c. ... and while the app takes the thread over (the terminal is being ended and imported).
ResumeRefusedWhileTakeover == [][Passes => ~taking]_vars

AppAccepted ==
    /\ n' = n + 1
    /\ \/ Len(gs') = Len(gs) + 1 /\ gs'[Len(gs')] = "app"
       \/ GateHoldsToSave /\ Len(hq') = Len(hq) + 1 /\ hq'[Len(hq')] = "app"
BotAccepted == n' = n + 1 /\ gs' = gs /\ Len(hq') = Len(hq) + 1 /\ hq'[Len(hq')] = "bot"

\* P4. A send is refused (409 liveInTerminal) while the host's copy of the registry says the terminal is live
\* or a take-over runs.
SendRefusedWhenHostSeesTerminal ==
    [][AppAccepted => ~(infoPid /= "none" /\ (taking \/ VisOf(infoPid) /= "closed"))]_vars

\* Strict forms: what is TRUE, not what the checks see.
\* S1. A send is never accepted while a terminal has the session open or is starting to.
SendNeverWhileTerminalClaims == [][AppAccepted => Claiming = {}]_vars
\* S2. A terminal never starts resuming while a send is accepted but not finished (past the gate, queued, or running).
ResumeNeverWhileSendPending == [][Passes => (hr = "none" /\ gs = <<>> /\ hq = <<>>)]_vars
\* S3. Two terminals never resume the same session at once.
ResumeNeverWhileOtherTerminal == [][\A t \in Terminals : PassT(t) => (Claiming \ {t}) = {}]_vars

\* P5. A host turn that starts writing, with no terminal holding the thread, writes the session the last writer left.
ContinuesLastSession == [][(~hw /\ hw') => hs' = cur']_vars

\* P5b. `kith <agent> --resume THREAD` resumes the session the last writer left (the thread path, not a raw id).
ResumeContinuesLastSession == [][\A t \in Terminals : PassT(t) /\ tm[t] = "claims" => csid[t] = cur]_vars

\* P7. A host turn never starts on a cached session the terminal has written to since: the actor reloads it.
CacheNeverStale == [][(hr = "none" /\ hr' /= "none" /\ Holding = {} /\ dirty) => forgotten]_vars

\* P8. A message the app accepted is never failed at the turn start (start_gate); the terminal is refused instead.
NoAcceptedMessageFails ==
    [][~(hostUp /\ hostUp' /\ ~interr /\ hq /= <<>> /\ hr = "none" /\ hr' = "none" /\ hq' = Tail(hq))]_vars

\* P6. A bot's ask is refused while the thread is held by a terminal or being taken over. NOT in the code: the ask has
\* no gate (TODO(writer claim) in api/botguests.rs); the turn start refuses it instead.
BotRefusedWhileHeld == [][BotAccepted => (Claiming = {} /\ ~taking)]_vars

\* ---- reachability (each is expected to FAIL: the state it denies can happen, so a pass elsewhere is not vacuous)
NeverHostRuns == hr = "none"
NeverHostWrites == ~hw
NeverBotRuns == hr /= "bot"
NeverTerminalBusy == \A t \in Terminals : TS[t] /= "busy"
NeverTerminalResumes == \A t \in Terminals : TS[t] /= "launching"
NeverTerminalClaims == \A s \in Sids : cf[s] \notin Terminals
NeverHostClaims == \A s \in Sids : cf[s] /= "host"
NeverTookOver == ~(sig = "own" /\ to = "none")
NeverOrphan == ~orph
NeverHostRunsAfterTerminalHeld == ~(hw /\ \E t \in Terminals : TS[t] = "gone")

=============================================================================
