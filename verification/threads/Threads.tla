---------------------------- MODULE Threads ----------------------------
(***************************************************************************)
(* One thread = one Claude session. Who may write to it, and when.         *)
(*                                                                         *)
(* Writers: a terminal `kith <agent>` (its claude process holds the        *)
(* session while it lives), the host's turn actor (an app send), and       *)
(* a bot guest's `kith ask --thread` (DESIGN ONLY: not wired in code yet,  *)
(* behind BotEnabled).                                                     *)
(*                                                                         *)
(* Every action names the code it models. One atomic step in the code is   *)
(* one action here; a check followed later by the act it guards is TWO     *)
(* actions, so another writer can act in between.                          *)
(*                                                                         *)
(* Code (sync refs in .claude/skills/thread-writers/SKILL.md):             *)
(*   K = kernel/bin/kith-sessions, kernel/bin/kith                         *)
(*   R = serve/host/src/terminal/registry.rs                               *)
(*   S = serve/host/src/terminal/sync.rs                                   *)
(*   T = serve/host/src/api/threads.rs, api/bots.rs (send)                 *)
(*   Q = serve/host/src/agent/bot/{queue,turn,session}.rs                  *)
(*   A = serve/host/src/hub/actors.rs (working_lanes)                      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Terminals,        \* terminal runs that may resume the thread, each run once: {"t1","t2"}
    MaxSends,         \* how many app/bot sends one run may make
    StartTerminalBorn,\* TRUE: also start from a thread born in a live terminal (t1)
    \* --- what the code does today (TRUE). FALSE = a broken variant, to show a property can fail.
    SendChecksLive,        \* S before_send_blocking: refuse a send while the terminal is live
    TakingBlocksSend,      \* S before_send_blocking: refuse a send while a take-over runs (`taking`)
    GateNeedsInfo,         \* S before_send_blocking: no `terminal.info.<thread>` -> no check at all
    ResumeChecksHostBusy,  \* K resolve: refuse while resolveThread says hostBusy
    ResumeChecksOpen,      \* K resolve: refuse while the registry's pid is live
    TakeoverRefusesBusy,   \* S take_over_inner: Live::Busy -> TerminalBusy
    TakeoverRechecks,      \* S take_over_inner: liveness again just before the signal
    ProcStartCheck,        \* R liveness/started_as: a reused pid is not the session
    ForgetsCache,          \* S forget_loaded -> Q session.rs forget_loaded: the actor drops its cached session
    \* --- scope switches
    LaunchIsInstant,       \* TRUE: claude is up the moment resolve passes (no launch gap)
    BotEnabled,            \* DESIGN: bots can `kith ask --thread` (docs/kith-bot-guests.md 6.2)
    BotGate,               \* DESIGN: "field" (liveWriter in the summary) or "live" (same gate as a send)
    \* --- what-ifs: fixes the code does NOT have (FALSE = code today)
    ClaimOnResolve,        \* host marks the thread claimed when it answers resolveThread; sends wait
    TakeoverAtomic,        \* recheck and signal as one step
    SyncLaneAtStart,       \* a turn re-reads the registry's session before it starts
    ForgetOnImport         \* an import that brings new terminal lines also forgets the cache, even if the terminal
                           \* was never seen live

VARIABLES
    TS,        \* per terminal: "fresh" "launching" "idle" "busy" "dying" "gone"
    regPid,    \* the terminal named by the registry file $KITH_STATE/live/terminal/<sid>.json ("none": no file)
    regSid,    \* the session id in that file
    hooked,    \* terminals whose SessionStart hook ran
    ghost,     \* gone terminals whose pid another process now has, sessions/<pid>.json still naming the session
    infoPid,   \* the host's copy of the registry (kv terminal.info.<thread>); "none": host-only thread
    cur,       \* the Claude session id the last writer left (1, or 2 after a fork)
    lane,      \* the session id the host's lane resumes (kv lane.session...)
    gs,        \* sends past the gate, not yet queued (the api call between before_send and send_cmd)
    hq,        \* sends in the actor's queue
    hr,        \* the running host turn: "none" "app" "bot"
    taking,    \* the thread is in Terminal.taking
    to,        \* take-over progress: "none" "wrote" "rechecked" "signalled"
    lw,        \* the summary's liveWriter field: "none" "terminal" "app" "bot"
    claimed,   \* WHAT-IF only
    sig,       \* whom the last take-over signalled: "none" "own" "foreign"
    n,         \* sends made
    staleKv,   \* kv terminal.stale.<thread>: a terminal wrote since the host last loaded the session
    forgotten, \* the actor dropped its cached session (conn.loaded, thread_sessions): its next turn loads it again
    dirty      \* a terminal wrote to the session after the actor last loaded it (the cache is out of date)

C == <<staleKv, forgotten, dirty>>

vars == <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, taking, to, lw, claimed, sig, n, C>>

\* Q session.rs forget_loaded(): "A turn running there is left alone."
Forgets == ForgetsCache /\ hr = "none"

Live == {"idle", "busy", "dying"}
Holding == {t \in Terminals : TS[t] \in Live}
Claiming == {t \in Terminals : TS[t] \in Live \cup {"launching"}}

\* R liveness(): pid runs, its session file names the session (and, with procStart, started when claimed).
VisOf(p) ==
    IF p = "none" THEN "closed"
    ELSE IF TS[p] = "busy" THEN "busy"
    ELSE IF TS[p] \in {"idle", "dying"} THEN "idle"
    ELSE IF TS[p] = "gone" /\ p \in ghost /\ ~ProcStartCheck THEN "idle"
    ELSE "closed"

\* R pid_runs(): kill(pid, 0).
Runs(p) == p /= "none" /\ (TS[p] \in Live \cup {"launching"} \/ (TS[p] = "gone" /\ p \in ghost))

TypeOK ==
    /\ TS \in [Terminals -> {"fresh", "launching", "idle", "busy", "dying", "gone"}]
    /\ regPid \in Terminals \cup {"none"} /\ infoPid \in Terminals \cup {"none"}
    /\ hr \in {"none", "app", "bot"} /\ to \in {"none", "wrote", "rechecked", "signalled"}
    /\ lw \in {"none", "terminal", "app", "bot"} /\ sig \in {"none", "own", "foreign"}
    /\ Len(gs) + Len(hq) <= MaxSends /\ n <= MaxSends

-----------------------------------------------------------------------------
Init ==
    /\ n = 0 /\ gs = <<>> /\ hq = <<>> /\ hr = "none" /\ taking = FALSE /\ to = "none"
    /\ sig = "none" /\ claimed = FALSE /\ ghost = {} /\ cur = 1 /\ lane = 1 /\ regSid = 1
    /\ forgotten = FALSE /\ dirty = FALSE
    /\ \/ \* a thread made in the app, or one older than the terminal feature: the host knows no terminal
          /\ TS = [t \in Terminals |-> "fresh"] /\ regPid = "none" /\ infoPid = "none" /\ lw = "none"
          /\ hooked = {} /\ staleKv = FALSE
       \/ \* a thread born in a terminal `kith <agent>` that is open now, hooked and already scanned
          /\ StartTerminalBorn
          /\ TS = [t \in Terminals |-> IF t = "t1" THEN "idle" ELSE "fresh"]
          /\ regPid = "t1" /\ infoPid = "t1" /\ lw = "terminal" /\ hooked = {"t1"}
          /\ staleKv = TRUE   \* S create_thread: a live terminal thread starts stale

\* ---- the app / bot side ------------------------------------------------

\* S before_send_blocking(): reads the host's copy of the registry (info), `taking`, and the live process.
\* Without a copy it returns Ok (GateNeedsInfo). T/bots.rs `send` calls it before saving the message.
CodeRefuses ==
    /\ SendChecksLive
    /\ LET p == IF GateNeedsInfo THEN infoPid ELSE regPid
       IN p /= "none" /\ ((taking /\ TakingBlocksSend) \/ VisOf(p) /= "closed")
Refuses == CodeRefuses \/ (ClaimOnResolve /\ claimed)

\* api/bots.rs send: the gate passed, the message is about to be saved and sent to the actor.
AppGate ==
    /\ n < MaxSends /\ ~Refuses
    /\ gs' = Append(gs, "app") /\ n' = n + 1
    \* ... then, if the terminal wrote since the host loaded: clear stale and forget_loaded (only with a copy of the registry)
    /\ staleKv' = IF infoPid /= "none" THEN FALSE ELSE staleKv
    /\ forgotten' = (forgotten \/ (infoPid /= "none" /\ (staleKv \/ (ForgetOnImport /\ dirty)) /\ Forgets))
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, hq, hr, taking, to, lw, claimed, sig, dirty>>

\* DESIGN (docs/kith-bot-guests.md 5.8 step 5, 6.2): the bot's gate reads the summary's liveWriter, or the live check.
BotRefuses == IF BotGate = "field" THEN lw \in {"terminal", "app"} ELSE Refuses
BotGate_ ==
    /\ BotEnabled /\ n < MaxSends /\ ~BotRefuses
    /\ gs' = Append(gs, "bot") /\ n' = n + 1
    /\ lw' = IF lw = "none" THEN "bot" ELSE lw
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, hq, hr, taking, to, claimed, sig, C>>

\* api/bots.rs send -> hub send_cmd(Cmd::Send) -> Q queue.rs on_cmd: Queued::User pushed.
Enqueue ==
    /\ gs /= <<>>
    /\ hq' = Append(hq, Head(gs)) /\ gs' = Tail(gs)
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, hr, taking, to, lw, claimed, sig, n, C>>

\* Q queue.rs next_in_queue -> turn start: the runtime turns Working (A working_lanes sees it). Nothing re-checks
\* the terminal here. SyncLaneAtStart is a what-if.
HostStart ==
    /\ hr = "none" /\ hq /= <<>>
    /\ hr' = Head(hq) /\ hq' = Tail(hq)
    /\ lane' = IF SyncLaneAtStart THEN regSid ELSE lane
    \* a forgotten cache means this turn loads the session again, and so sees what the terminal wrote
    /\ IF forgotten THEN forgotten' = FALSE /\ dirty' = FALSE ELSE UNCHANGED <<forgotten, dirty>>
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, gs, taking, to, lw, claimed, sig, n, staleKv>>

\* Q turn.rs finish (done, failed or Stop): the turn ends.
HostEnd ==
    /\ hr /= "none"
    /\ hr' = "none"
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, taking, to, lw, claimed, sig, n, C>>

\* The host process restarts: memory is lost (runtime, queue, taking); kv (info, lane, liveWriter) stays.
HostRestart ==
    /\ hr' = "none" /\ hq' = <<>> /\ gs' = <<>> /\ taking' = FALSE /\ to' = "none"
    /\ forgotten' = FALSE /\ dirty' = FALSE   \* no actor, no cache: the next turn loads the session
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, lw, claimed, sig, n, staleKv>>

\* ---- the terminal side -------------------------------------------------

\* K kith-sessions resolve(): asks the host (resolveThread -> S resolve(): hostBusy = A working_lanes, i.e. a turn
\* RUNNING; a queued send does not count), refuses when the registry's pid is live (live_pid), then bin/kith starts claude.
\* The what-if ClaimOnResolve makes the host remember the claim and count queued sends.
TermResolve(t) ==
    /\ TS[t] = "fresh"
    /\ ResumeChecksHostBusy => (hr = "none" /\ (ClaimOnResolve => (gs = <<>> /\ hq = <<>>)))
    /\ ResumeChecksOpen => ~(regPid /= "none" /\ TS[regPid] \in Live)
    /\ ClaimOnResolve => ~claimed
    /\ TS' = [TS EXCEPT ![t] = IF LaunchIsInstant THEN "idle" ELSE "launching"]
    /\ claimed' = IF ClaimOnResolve THEN TRUE ELSE claimed
    /\ UNCHANGED <<regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, taking, to, lw, sig, n, C>>

\* bin/kith -> kith-sessions run -> claude starts and writes ~/.claude/sessions/<pid>.json: the session is open.
TermUp(t) ==
    /\ TS[t] = "launching"
    /\ TS' = [TS EXCEPT ![t] = "idle"]
    /\ UNCHANGED <<regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, taking, to, lw, claimed, sig, n, C>>

\* K record(): the SessionStart hook writes the registry file (write_atomic, one file per session id: a later
\* terminal replaces the pid in it). A resumed session may be forked: a new id (resumedFrom names the old one).
TermHook(t) ==
    /\ TS[t] \in {"idle", "busy"} /\ t \notin hooked
    /\ \E c \in {cur, 2} : cur' = c /\ regSid' = c
    /\ hooked' = hooked \cup {t} /\ regPid' = t
    /\ UNCHANGED <<TS, ghost, infoPid, lane, gs, hq, hr, taking, to, lw, claimed, sig, n, C>>

\* The user types a prompt / the turn ends (claude's own status, read by R liveness: idle vs anything else).
TermPrompt(t) ==
    /\ TS[t] = "idle" /\ t \in hooked
    /\ TS' = [TS EXCEPT ![t] = "busy"] /\ dirty' = TRUE   \* the session now holds what the host's cache lacks
    /\ UNCHANGED <<regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, taking, to, lw, claimed, sig, n, staleKv, forgotten>>

TermDone(t) ==
    /\ TS[t] = "busy"
    /\ TS' = [TS EXCEPT ![t] = "idle"]
    /\ UNCHANGED <<regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, taking, to, lw, claimed, sig, n, C>>

\* The user quits (or it crashes). A crash can leave sessions/<pid>.json behind with the pid reused (ghost).
TermExit(t) ==
    /\ TS[t] \in Live \cup {"launching"}
    /\ TS' = [TS EXCEPT ![t] = "gone"]
    /\ \E g \in BOOLEAN : ghost' = IF g THEN ghost \cup {t} ELSE ghost
    /\ UNCHANGED <<regPid, regSid, hooked, infoPid, cur, lane, gs, hq, hr, taking, to, lw, claimed, sig, n, C>>

\* ---- the take-over (app asks the terminal to let go) ---------------------

KillTS(p) == IF TS[p] \in {"idle", "busy"} THEN [TS EXCEPT ![p] = "dying"] ELSE TS
KillSig(p) == IF TS[p] = "gone" THEN "foreign" ELSE "own"

Abort ==
    /\ taking' = FALSE /\ to' = "none"

\* S take_over(): taking.insert; take_over_inner: liveness of the host's copy: Closed -> no-op, Busy -> TerminalBusy,
\* Idle -> write the .taken note.
TakeBegin ==
    /\ ~taking /\ to = "none" /\ infoPid /= "none"
    /\ \/ VisOf(infoPid) = "closed" /\ taking' = FALSE /\ to' = "none"
       \/ VisOf(infoPid) = "busy" /\ TakeoverRefusesBusy /\ taking' = FALSE /\ to' = "none"
       \/ (VisOf(infoPid) = "idle" \/ (VisOf(infoPid) = "busy" /\ ~TakeoverRefusesBusy))
          /\ taking' = TRUE /\ to' = "wrote"
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, lw, claimed, sig, n, C>>

\* S take_over_inner: "Re-checked just before the signal", then registry::terminate (SIGTERM). Two steps in the code.
TakeRecheck ==
    /\ to = "wrote"
    /\ IF TakeoverRechecks /\ VisOf(infoPid) /= "idle"
       THEN Abort /\ UNCHANGED <<TS, sig>>
       ELSE IF TakeoverAtomic
            THEN IF Runs(infoPid)
                 THEN /\ TS' = KillTS(infoPid) /\ sig' = KillSig(infoPid) /\ to' = "signalled" /\ UNCHANGED taking
                 ELSE Abort /\ UNCHANGED <<TS, sig>>
            ELSE /\ to' = "rechecked" /\ UNCHANGED <<taking, TS, sig>>
    /\ UNCHANGED <<regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, lw, claimed, n, C>>

TakeSignal ==
    /\ to = "rechecked"
    /\ IF Runs(infoPid)
       THEN /\ TS' = KillTS(infoPid) /\ sig' = KillSig(infoPid) /\ to' = "signalled" /\ UNCHANGED taking
       ELSE Abort /\ UNCHANGED <<TS, sig>>
    /\ UNCHANGED <<regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, lw, claimed, n, C>>

\* S take_over_inner: waits for the process to end (EXIT_WAIT), then imports the last lines and sets the writer.
TakeFinish ==
    /\ to = "signalled" /\ ~Runs(infoPid)
    /\ taking' = FALSE /\ to' = "none" /\ lw' = "none"
    \* "The terminal wrote to the session: the actor loads it again" (kv_delete stale, then forget_loaded)
    /\ staleKv' = FALSE /\ forgotten' = (forgotten \/ Forgets)
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, claimed, sig, n, dirty>>

TakeTimeout ==
    /\ to = "signalled" /\ Runs(infoPid)
    /\ Abort
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, infoPid, cur, lane, gs, hq, hr, lw, claimed, sig, n, C>>

\* ---- the host's registry scan (every 3 s) ------------------------------

\* S scan() -> sync_session / mapped / adopt (copy the registry, move the lane to the terminal's session) and
\* update_state (liveWriter), which a take-over in progress skips.
Scan ==
    /\ infoPid' = IF regPid /= "none" THEN regPid ELSE infoPid
    /\ lane' = IF regPid /= "none" THEN regSid ELSE lane
    /\ lw' = IF taking \/ infoPid' = "none" THEN lw
             ELSE IF VisOf(infoPid') /= "closed" THEN "terminal"
             ELSE IF hr /= "none" THEN "app" ELSE "none"
    /\ claimed' = IF ClaimOnResolve THEN Claiming /= {} ELSE claimed
    \* update_state: a live terminal with no stale mark -> mark it and forget_loaded; adopt() of a forked session too.
    /\ LET sawLive == ~taking /\ infoPid' /= "none" /\ VisOf(infoPid') /= "closed" /\ ~staleKv
           adopted == (regPid /= "none" /\ regSid /= lane) \/ (ForgetOnImport /\ dirty)
       IN /\ staleKv' = (staleKv \/ sawLive \/ adopted)
          /\ forgotten' = (forgotten \/ ((sawLive \/ adopted) /\ Forgets))
    /\ UNCHANGED <<TS, regPid, regSid, hooked, ghost, cur, gs, hq, hr, taking, to, sig, n, dirty>>

Next ==
    \/ AppGate \/ BotGate_ \/ Enqueue \/ HostStart \/ HostEnd \/ HostRestart
    \/ \E t \in Terminals : TermResolve(t) \/ TermUp(t) \/ TermHook(t) \/ TermPrompt(t) \/ TermDone(t) \/ TermExit(t)
    \/ TakeBegin \/ TakeRecheck \/ TakeSignal \/ TakeFinish \/ TakeTimeout
    \/ Scan

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* ======================== PROPERTIES ====================================

\* P1. At most one writer holds the thread: a live terminal session, or a running host turn.
OneWriter == Cardinality(Holding) + (IF hr /= "none" THEN 1 ELSE 0) <= 1

\* P2. A take-over never ends a terminal that is working on a turn.
TakeoverOnlyWhenIdle == [][\A p \in Terminals : ~(TS[p] = "busy" /\ TS'[p] = "dying")]_vars

\* P2b. A take-over never signals a process that is not the session's (a reused pid).
NoForeignSignal == sig /= "foreign"

Resolves == \E t \in Terminals : TS[t] = "fresh" /\ TS'[t] /= "fresh"

\* P3. `kith <agent> --resume` refuses while the host runs a turn in the thread.
ResumeRefusedWhileTurnRuns == [][Resolves => hr = "none"]_vars

\* P3b. ... and while another terminal has the session open (as far as the registry file says).
ResumeRefusedWhileOpen == [][Resolves => ~(regPid /= "none" /\ TS[regPid] \in Live)]_vars

Accepted(w) == Len(gs') = Len(gs) + 1 /\ gs'[Len(gs')] = w

\* P4. A send is refused (409 liveInTerminal) while the host's copy of the registry says the terminal is live
\* or a take-over runs.
SendRefusedWhenHostSeesTerminal ==
    [][Accepted("app") => ~(infoPid /= "none" /\ (taking \/ VisOf(infoPid) /= "closed"))]_vars

\* Strict forms: what is TRUE, not what the host's copy says.
\* S1. A send is never accepted while a terminal has the session open or is starting to.
SendNeverWhileTerminalClaims == [][Accepted("app") => Claiming = {}]_vars
\* S2. A terminal never starts resuming while a send is accepted but not finished (queued or past the gate).
ResumeNeverWhileSendPending == [][Resolves => (hr = "none" /\ gs = <<>> /\ hq = <<>>)]_vars
\* S3. Two terminals never resume the same session at once.
ResumeNeverWhileOtherTerminal == [][Resolves => Claiming = {}]_vars

\* P5. A host turn that starts with no terminal holding the thread starts on the session the last writer left.
ContinuesLastSession == [][(hr = "none" /\ hr' /= "none" /\ Holding = {}) => lane' = cur']_vars

\* P7. A host turn never starts on a cached session the terminal has written to since: the actor reloads it.
CacheNeverStale == [][(hr = "none" /\ hr' /= "none" /\ Holding = {} /\ dirty) => forgotten]_vars

\* P6 (DESIGN). A bot's ask is refused while the thread is held by a terminal or being taken over.
BotRefusedWhileHeld == [][Accepted("bot") => (Claiming = {} /\ ~taking)]_vars

\* ---- reachability (each is expected to FAIL: the state it denies can happen, so a pass elsewhere is not vacuous)
NeverHostRuns == hr = "none"
NeverBotRuns == hr /= "bot"
NeverTerminalBusy == \A t \in Terminals : TS[t] /= "busy"
NeverTookOver == ~(sig = "own" /\ to = "none")
NeverHostRunsAfterTerminalHeld == ~(hr /= "none" /\ \E t \in Terminals : TS[t] = "gone")

=============================================================================
