# Design Freeze — Session Pair Operations & Prompt Actions

**Status:** FROZEN (design only — no implementation in this tranche)
**Baseline commit:** `ef6185b6f9d57a21e911dee405dd8f2e81273c3f`
**Scope:** Pair operational state, Load & Activate, continuity/checkpoint evidence, Pair Detail Revision 2, editable composer, Prompt Templates.

---

## 0. How to read this document

Every material statement is tagged. The tags are load-bearing; untagged prose is connective only.

| Tag | Meaning |
|---|---|
| `[FROZEN]` | A requirement that has been decided and is binding on all future work. Not open for reinterpretation. |
| `[VERIFIED]` | A fact read directly out of the current RelayX repository. Cited as `path:line`. |
| `[PROPOSED]` | A structure that **does not exist yet**. A design proposal. Names are candidates, not commitments. |
| `[UNRESOLVED]` | A genuine question that requires a human decision. Deliberately not answered here. |

**Warning on `[PROPOSED]` naming.** Every identifier in this document that carries the `[PROPOSED]` tag is invented for the purpose of describing the design. None of these tables, columns, types, methods, or view models exist in the repository today. They must not be cited as current architecture, and implementation slices may rename them freely so long as the frozen invariants they carry are preserved.

---

## 1. Purpose and frozen invariants

### 1.1 Purpose

This document freezes the domain and design direction for five related capabilities in Session Pair operations, so that implementation can proceed later without re-litigating semantics:

1. A persistent **IDLE / ACTIVE** operational state for a Pair.
2. A **Load & Activate** operation that resolves and verifies both sides against live providers.
3. Durable **per-side continuity / checkpoint** evidence.
4. **Pair Detail Revision 2** — a pair-centric detail surface.
5. An editable **Composer** and a first-class **Prompt Template** subsystem.

### 1.2 Frozen invariants

These are the load-bearing rules. Any later implementation that violates one of these is wrong, regardless of how convenient the violation is.

**I-1 — Persistent operational state is exactly two values.** `[FROZEN]`
A Pair's persistent operational state is `IDLE | ACTIVE` and nothing else. Not three values, not four. There is no third persisted value for a transient condition such as "activating", "loading", "checking", or "degraded". Transient condition lives in ephemeral runtime state, never in the persisted column.

**I-2 — IDLE means zero external provider contact.** `[FROZEN]`
While a Pair is IDLE, RelayX makes **no** network calls, no provider probes, no process inspection, no AppleScript execution, and no filesystem reads against external provider surfaces. IDLE is a hard guarantee, not a soft tendency. The only thing IDLE permits is reading RelayX's own database.

**I-3 — IDLE displays persisted evidence only.** `[FROZEN]`
While IDLE, every user-visible value about the external world (session identity, existence, reachability, activity, latest message, readiness) is rendered from the **last persisted observation** with its recorded observation time, and is visibly labelled as last-known. The UI must not present stale persisted data as if it were current fact.

**I-4 — ACTIVE permits, but does not imply, activity.** `[FROZEN]`
ACTIVE means RelayX *is permitted* to observe and interact with external providers. It does **not** mean RelayX is continuously polling, and it does **not** mean execution is underway. An ACTIVE Pair with a stopped supervisor tick is a normal, valid state. ACTIVE is a permission, not an activity level.

**I-5 — Readiness is always derived, never persisted as authority.** `[FROZEN]`
Readiness is computed from current evidence at read time. A previously persisted readiness value is a **cache with a validity window**, and it must never authorize execution once it has gone stale. Stale readiness may be displayed as last-known; it may never gate or permit an action.

**I-6 — Unknown is a distinct value from false.** `[FROZEN]`
Every provider-neutral observation must distinguish "we checked and it is false" from "we did not check / cannot check / the check failed". Collapsing these into a boolean destroys the audit trail and is prohibited.

**I-7 — No cross-provider timestamp ordering.** `[FROZEN]`
RelayX must never order, compare, or derive causality from timestamps that originate in different providers. ChatGPT wall-clock time and OpenCode wall-clock time are separate, unsynchronized clocks on separate hosts-in-effect. No global message ordering, no "latest across both sides", no cross-side sequence reconstruction, and no stale-detection heuristic that compares a ChatGPT timestamp to an OpenCode timestamp.

**I-8 — Both sides advancing while idle must not trigger automatic copying.** `[FROZEN]`
If work advances on both the planner and the worker side while the Pair is IDLE, RelayX must not automatically copy, forward, replicate, or reconcile content between them. Advancing on both sides is a state to be surfaced to the operator, not a condition to be resolved automatically.

**I-9 — Load & Activate is separate from Start Pair.** `[FROZEN]`
`Load & Activate` and `Start Pair` are distinct operations with distinct meanings, distinct prerequisites, and distinct side effects. They must not be merged, aliased, or made to imply one another. See §4.4.

**I-10 — Make Idle stops live observation without destroying state.** `[FROZEN]`
`Make Idle` halts all live observation and all live interaction for the Pair. It must **not** delete, invalidate, or clear bindings, history, checkpoints, cursors, provenance records, or last-known evidence. Make Idle is a suspension of observation, not a teardown.

**I-11 — Shared name is evidence, never identity.** `[FROZEN]`
A human-readable Pair Name applied to both external sessions is **discoverability and recovery evidence only**. It is never authoritative identity. Authoritative identity is always the provider's own external session identifier. RelayX must never report that automatic planner creation or automatic naming succeeded when the provider has not proven it.

**I-12 — The Planner need not always produce another prompt.** `[FROZEN]`
The Planner's next output is executable next work **OR** a structured, machine-readable genuine stop / human-dependency reason. The dangerous invariant "the Planner must always produce another prompt" is explicitly rejected. A genuine stop is a first-class, valid, successful outcome.

**I-13 — Provenance is preserved for every delivered message.** `[FROZEN]`
Three message origins must remain distinguishable forever: (a) messages actually produced by the provider, (b) messages actually delivered by RelayX, (c) operator-edited or operator-authored messages. Operator edits retain immutable provenance of their source. An edited message is a **new** artifact that points at an immutable source; the source is never mutated in place and never overwritten.

**I-14 — Cursors and provenance precede Composer and Templates.** `[FROZEN]`
The durable per-side cursor/checkpoint model and the provenance model are built and proven **before** the Composer, and before Prompt Templates. Composer and Templates consume these models; they do not introduce their own tracking.

**I-15 — Templates are one governed dispatch path.** `[FROZEN]`
Prompt Templates are first-class reusable definitions consumed by **both** human-initiated actions and future engine-initiated actions, through a **single** governed dispatch path. There is exactly one dispatch pipeline. Templates must not grow a second, parallel delivery path.

**I-16 — OpenCode discovery/creation ground truth is protected.** `[FROZEN]`
`OPENCODE_SESSION_DISCOVERY.md` and its regression gates, as of `ef6185b6f9d57a21e911dee405dd8f2e81273c3f`, are protected ground truth. This design **consumes** those capabilities as-is. It does not redesign, weaken, bypass, or gate them off them.

### 1.3 Explicitly not invariant

The following are **not** frozen and remain open: naming of proposed entities, table layout, API surface shape, retention windows, and the eligibility/recovery policy. See §20.

---

## 2. Current architecture findings

All items in this section are `[VERIFIED]` by direct repository inspection.

### 2.1 Pair domain

`src/relay/domain/entities.ts`

- `Pair` exposes `update()`, which mutates the in-place record, including planner and worker runtime references.
- `assignWork()`, `clearWork()`, `pause()`, and `resume()` conflate assignment lifecycle with pair lifecycle in a single set of methods.
- `RuntimeSession` holds a single `lastEvidence` field of type `ObservableEvidence`.
- `Delivery`, `Handoff`, and `Attempt` exist as distinct aggregates.
- `Attempt` authority is frozen as exactly `(sessionPairId, workerSessionId, externalSessionId)`.
- `Assignment.pairId` is immutable.
- `RuntimeProjectAssociation` exists for pre-pair project association.

### 2.2 State unions

`src/relay/domain/types.ts`

```ts
PairStatus = 'idle' | 'active' | 'paused' | 'recovering' | 'blocked' | 'archived'
```

`ObservableEvidence` is the single evidence record type. Branded ID types are in use.

**Finding:** this single `PairStatus` union conflates operational state (`idle`/`active`) with execution and lifecycle state (`paused`/`recovering`/`blocked`/`archived`). There is no separately persisted operational dimension.

### 2.3 Engine

`src/relay/application/RelayEngine.ts`

- `startPair()` is implemented as `pair.resume()` and nothing more. It performs no identity resolution, no session locate/open, no identity verification, no message retrieval, no checkpoint comparison, and no readiness assessment.
- `dispatchAssignment()` follows a three-phase pattern: durable intent written in a transaction, external provider call deliberately **outside** the transaction, then outcome recorded in a second transaction (`RelayEngine.ts:988` — *"Phase 2 --- external provider call, deliberately OUTSIDE the DB transaction"*).
- `assertPrePairAuthoritativeAssociation` guards pre-pair project association.
- `runSupervisionTick` exists.
- `deliverHandoffToPlanner()` (`RelayEngine.ts:1221`) performs a pure state transition plus a `planner.notified` event and makes **no** external provider call. See §9.4.1.

### 2.4 API / view-model assembly

`src/relay/application/RelayApiService.ts`

- `listPairs` and `getPair` assemble view models.
- `createPair` enforces a conversation-URL binding contract.
- `adoptOpenCodeSession`, `createOpenCodeWorkerSession`, `enumerateWorkerChoices`, and `enumerateChatGPTConversations` exist.

### 2.5 Persistence

`src/relay/persistence/sqlite/SqliteDatabase.ts`

- Tables include `pairs`, `attempts` (carrying `session_pair_id`, `worker_session_id`, `external_session_id`), and `runtime_project_associations`.
- `PRAGMA user_version = 3`.
- Migration follows an additive `addColumnIfNeeded(...)` pattern gated on `user_version`.
- The Plan-First migration **refuses to drop legacy tables holding rows**.

**Finding:** `assignments` has `ON DELETE CASCADE` to `pairs`. Deleting a Pair therefore destroys its assignment, attempt, delivery, and handoff history.

### 2.6 Provider capability surface

`src/relay/providers/interfaces.ts`

```ts
export interface DeliveryInstructionRequest {
  runtimeSessionId: RuntimeSessionId;
  instructionText: string;
  idempotencyKey: string;
}
```

`IRuntimeProvider` provides `deliverInstruction`, `inspectRuntime`, `activateRuntime`, `detectWorkingState`, `detectCompletionState`, `captureEvidence`, optional `reconcileDispatch`, optional `confirmSessionForProject`, and optional `createWorkerSession`.

**There is no message-read capability and no message-edit capability on `IRuntimeProvider`.**

### 2.7 OpenCode session client

`src/relay/providers/opencodeSessionClient.ts`

- Read-only GET client. Methods: `listSessionsByDirectory`, `getSession`, `getActiveSessions`, `getSessionStatus`, `getServiceInfo`, `getTranscript`, `getContext`. **No write/send/prompt method exists.**
- `getTranscript()` yields `messageId`, `text`, `role`, `createdAt`.
- Bounded by `MAX_TEXT_CHARS = 2000` and `DEFAULT_TRANSCRIPT_LIMIT = 50`.

### 2.8 Ground-truth documents already frozen

`PROVIDER_DISPATCH_GROUND_TRUTH.md` assigns ChatGPT = **LEVEL 0** (no transcript, no message ID) and OpenCode = **LEVEL 1** (evidence-assisted). **No provider reaches LEVEL 2.** `SESSION_PAIR_REPLACEMENT.md`, `EXECUTION_AUTHORITY.md`, `ATTEMPT_LIFECYCLE.md`, `CORE_FREEZE_CLOSURE.md`, and `DOMAIN_DELTA.md` contain existing frozen rules this design must not contradict.

Notably: `SESSION_PAIR_REPLACEMENT.md` requires that a replacement produce a **new** Pair with the old one preserved. `AUDIT_REPORT.md` §3 documents that current behavior does the opposite.

### 2.9 Reusable UI precedent

- `src/components/detailViewModels.ts` already models `SavedBinding` vs `DiscoveredIdentity` with a `BindingVerificationStatus`. This is the existing precedent for the IDLE-last-known vs ACTIVE-live-observed distinction required by I-3.
- `src/components/pairModalConversation.ts` is a pure-helper/validation precedent for new UI logic.
- `src/components/PairView.tsx` is pair-centric today, showing planner/worker status, assignment/delivery/handoff badges, and Start/Pause/Reconcile/Edit/Archive actions.

### 2.10 Protected baseline

`OPENCODE_SESSION_DISCOVERY.md` plus its regression gates are the protected contract at `ef6185b`. It is verified present and intact at HEAD.

---

## 3. Confirmed architecture conflicts

These are conflicts between the frozen requirements and current code. They are stated, not worked around.

### C-1 — `updatePair()` violates the replacement contract

**Conflict.** `RelayEngine.updatePair()` mutates the same `Pair` record via `pair.update(...)`. `SESSION_PAIR_REPLACEMENT.md` requires that a replacement create a **new** Pair with the old one preserved. `AUDIT_REPORT.md` §3 confirms the in-place mutation is the verified current behavior.

**Impact.** History, provenance, and checkpoint continuity cannot be anchored to a stable Pair identity, because the identity that owns them is mutable.

**Resolution direction.** `[PROPOSED]` Give the Pair a stable identity that survives update, and make replacement an explicit new-record operation. Do not resolve this by adding a compensating field; resolve it by fixing ownership.

### C-2 — Operational state is overloaded onto `PairStatus`

**Conflict.** `PairStatus` carries `idle`/`active` alongside `paused`/`recovering`/`blocked`/`archived`. I-1 requires a dedicated persisted operational dimension that is exactly `IDLE | ACTIVE`. Per I-1, a third persisted value for ACTIVATING is explicitly prohibited.

**Impact.** There is currently nowhere to record "this Pair is operationally ACTIVE but its execution is blocked". These are orthogonal facts collapsed into one column.

**Resolution direction.** `[PROPOSED]` Separate the dimensions. Operational state gets its own two-valued field. Execution and lifecycle state keeps the existing union, minus `idle`/`active`, which migrate to the new field.

### C-3 — No readiness model exists

**Conflict.** There is no readiness concept in the domain at all — no `unknown`/`checking`/`ready`/`attention`/`blocked`. I-5 requires readiness to be derived from current evidence and never to act as persisted authority.

**Impact.** Any readiness shown today would necessarily be a persisted value, which is exactly what I-5 forbids.

### C-4 — No durable per-side continuity or checkpoint model

**Conflict.** The only continuity signal is `RuntimeSession.lastEvidence`, a single overwrite-on-write field. There is no distinction between *neither side advanced*, *planner advanced*, *worker advanced*, *both advanced*, and *unverified*.

**Impact.** I-8 cannot be honoured, because "both sides advanced" is unrepresentable. Nothing survives to tell you what a side looked like at the moment you last knew.

### C-5 — No Load & Activate operation; `startPair()` is not one

**Conflict.** I-9 requires Load & Activate to be a distinct operation. `startPair()` is `pair.resume()` — a status mutation with no identity resolution, no session locate/open, no identity verification, no message retrieval, no checkpoint comparison, no readiness derivation. It cannot be relabelled into Load & Activate without changing what it does, and it must not be.

### C-6 — No Prompt Template subsystem exists

**Conflict.** There is no storage, no key or ID scheme, no target, no category, no body, no variable model, no enabled flag, no built-in-vs-user provenance, and no versioning. I-15 requires a single governed dispatch path that both humans and future engine actions consume; there is no such path to consume yet.

### C-7 — No editable message or composer exists

**Conflict.** There is no immutable-source vs modified-draft distinction, no Reload Source, no operator-authored dispatch record, and no reuse of the governed dispatch pipeline for operator-initiated sends. I-13 and I-15 cannot both be satisfied without this layer.

### C-8 — Provider capability limits bound all of the above

**Conflict.** ChatGPT is LEVEL 0: no transcript, no message ID. After a crash, RelayX **cannot prove** which message, if any, was delivered. OpenCode is LEVEL 1: a transcript exists, but `messageId` is provider-generated, text is truncated at 2000 characters, and the default limit is 50 messages. No provider reaches LEVEL 2.

**Impact.** Any design that promises reliable cross-restart identity, complete message bodies, or per-message diffing is over-promising against the actual provider surface. This bound is permanent and must be reflected honestly in the UI, not papered over.

---

## 4. Pair state and lifecycle

### 4.1 The two dimensions

`[FROZEN]` A Pair carries two **orthogonal** persisted dimensions. Conflating them is C-2.

| Dimension | Values | Meaning |
|---|---|---|
| **Operational state** | `IDLE` \| `ACTIVE` | Is RelayX permitted to contact the external providers for this Pair? |
| **Execution / lifecycle state** | existing union minus `idle`/`active` | Is work flowing, and what is the Pair's lifecycle position? |

`[FROZEN]` Operational state is the authority for I-2 (zero provider contact when IDLE). Nothing else gates provider contact. Execution state is descriptive.

`[FROZEN]` The table above states the **conceptual** post-freeze split. Whether the existing `PairStatus` column physically retains `idle`/`active` as deprecated aliases, or has them removed, is a deferred implementation decision — see §17.2 and §20, U-6. Whichever way U-6 is decided, the outcome must be a **single** source of truth for operational state, because two would violate I-1.

### 4.2 Transitions

```
            ┌──────────────────────── Make Idle ────────────────────────┐
            │                                                          v
      ┌───────────┐                                            ┌───────────┐
      │   IDLE    │ ────── Load & Activate ──────────────────▶ │  ACTIVE   │
      └───────────┘                                            └───────────┘
            ▲                                                          │
            │                                              ┌───────────┴───────────┐
            │                                              │ Make Idle             │
            └──────────────────────────────────────────────┴───────────────────────┘
                                    (all other transitions, e.g. failures, end
                                     at Make Idle; there is no auto-IDLE)
```

`[FROZEN]` Transition rules:

- **IDLE → ACTIVE** occurs only via explicit `Load & Activate` (or a future deliberate equivalent). It is never automatic.
- **ACTIVE → IDLE** occurs via `Make Idle`, or on any terminal failure of a Load & Activate attempt. It is never automatic on a timer.
- There is **no** ACTIVE → ACTIVATING → ACTIVE persisted sub-state. I-1 forbids a third persisted value. The in-flight phase lives in ephemeral runtime state only.
- Execution/lifecycle state changes (paused, blocked, recovering, archived) do **not** change operational state. A Pair may be ACTIVE and blocked, or IDLE and archived.

### 4.3 Side effects of each state

`[FROZEN]` **While IDLE:**

- Zero provider contact of any kind. (I-2)
- All external-world values render from persisted last-known evidence, labelled with observation time. (I-3)
- Readiness renders as last-known and is explicitly marked as non-authorizing if stale. (I-5)
- No dispatch of any kind, human or engine.

`[FROZEN]` **While ACTIVE:**

- Live observation and interaction are permitted. (I-4)
- Continuous polling is **not** implied. An ACTIVE Pair observes when an observation is requested — by an operator action or by a supervision tick when supervision is running. It does not spin.
- Execution still requires its own separate authorization, per `EXECUTION_AUTHORITY.md`. ACTIVE is not permission to dispatch.

### 4.4 Load & Activate vs Start Pair

`[FROZEN]` I-9. These are separate.

| | `Start Pair` | `Load & Activate` |
|---|---|---|
| Meaning | Begins/resumes the execution lifecycle of the Pair. | Begins operational observation of the Pair against its external sessions. |
| Changes operational state | No | Yes: IDLE → ACTIVE |
| Requires provider contact | No | Yes — this is its purpose |
| Requires resolvable identity | No | Yes, on both sides |
| Preconditions | None beyond existing lifecycle legality | Pair exists, both sides bound, provider capabilities present |
| Can be invoked while | any state | IDLE only |

`[FROZEN]` Neither implies the other. A Pair can be ACTIVE without being started, and started without being ACTIVE. `startPair()` remains `pair.resume()` in this tranche; Load & Activate is new work and does not modify it.

### 4.5 Make Idle

`[FROZEN]` I-10. Make Idle:

- **Does:** stop all live observation; stop all live interaction; stop any supervision tick in flight; move operational state to IDLE; record the reason and time.
- **Does not:** delete bindings; delete or invalidate history; clear checkpoints or cursors; clear provenance; clear last-known evidence; archive the Pair; destroy anything.

`[FROZEN]` Make Idle is idempotent. Make Idle on an already-IDLE Pair is a no-op that records the intent.

### 4.6 Existing manual Pair creation

`[FROZEN]` Existing manual Pair creation via `PairModal` and `createPair` is **unchanged** by this design. Its conversation-URL binding contract, its planner URL confirmation flow, and its worker adopt/create flows are all preserved exactly. Load & Activate operates on Pairs created this way and adds no new constraint to their creation.

---

## 5. Provider-neutral observation model

### 5.1 Motivation

`[FROZEN]` Every one of the dimensions below must be observable in a provider-neutral way, so that a Pair is comprehensible regardless of which providers its two sides use — including the case where both sides are the same provider, or a provider combination not yet supported.

### 5.2 The nine dimensions

`[FROZEN]` I-6. An observation record must distinguish each of these independently. None may be collapsed into another, and each must be able to hold the value *unknown* distinctly from *false*.

| # | Dimension | Question it answers | May be *unknown*? | May be *false*? |
|---|---|---|---|---|
| 1 | **Identity** | What external identifier does RelayX believe this side is? | Yes | Yes (no identifier resolved) |
| 2 | **Identity verification** | Has the provider confirmed that identifier corresponds to the intended session? | Yes | Yes (checked, mismatched) |
| 3 | **Existence** | Does the session still exist at the provider? | Yes | Yes (checked, gone) |
| 4 | **Reachability** | Can RelayX currently reach the provider surface at all? | Yes | Yes (checked, unreachable) |
| 5 | **UI presence** | Is the session's surface present and visible? | Yes | Yes (checked, not present) |
| 6 | **Activity state** | Is work in progress right now? | Yes | Yes (checked, idle) |
| 7 | **Message evidence** | What is the latest observable message, if any? | Yes | Yes (checked, none exists) |
| 8 | **Observation source** | Which provider capability produced this observation? | **No — always known** | n/a |
| 9 | **Observation time** | When was this observation taken? | **No — always known** | n/a |

`[FROZEN]` Dimensions 8 and 9 are mandatory and always populated. An observation with no source or no time is invalid and must be rejected, not defaulted.

`[FROZEN]` The observation source must name the **capability** that produced the value, not just the provider. "OpenCode" is not a sufficient source; the specific capability is required, so that LEVEL 0 vs LEVEL 1 evidence is distinguishable downstream. C-8 makes this mandatory.

### 5.3 Tri-state discipline

`[FROZEN]` Each of dimensions 1–7 is a three-state value: a positive value, `false`, or `unknown`. The render and the logic must never treat `unknown` as `false`.

`[FROZEN]` `unknown` is the correct and expected value in at least these cases: the Pair is IDLE (no contact permitted, I-2); the provider capability does not exist; the capability was attempted and failed; the observation is older than its validity window.

### 5.4 Freshness

`[FROZEN]` Every observation carries a timestamp and a capability-specific validity window. An observation older than its window is **stale**. A stale observation may be displayed as last-known (I-3) but may not contribute to authorizing readiness (I-5) or to any action.

`[UNRESOLVED]` The validity window per capability is not decided here. See §20, U-7.

### 5.5 Proposed structure

`[PROPOSED]` A provider-neutral observation record, roughly:

```ts
// [PROPOSED] — does not exist. Candidate shape only.
type TriState<T> = { kind: 'known'; value: T } | { kind: 'false' } | { kind: 'unknown'; reason?: string };

interface SideObservation {
  sideRole: 'planner' | 'worker';
  identity:               TriState<ExternalSessionId>;
  identityVerification:   TriState<'verified' | 'mismatched'>;
  existence:              TriState<true>;
  reachability:           TriState<true>;
  uiPresence:             TriState<true>;
  activityState:          TriState<'working' | 'idle' | 'error'>;
  messageEvidence:        TriState<LatestMessageEvidence>;
  source: { providerType: ProviderType; capability: string };  // always populated
  observedAt: number;                                              // always populated
  validUntil: number;                                              // always populated
}
```

`[PROPOSED]` This extends, and does not replace, the existing `ObservableEvidence` in `src/relay/domain/types.ts`. The design intent is to keep the existing evidence type as the low-level provider evidence artifact, and add a higher-level provider-neutral interpretation layer above it. Whether that layering is a new type or a view over the existing one is an implementation detail.

---

## 6. Continuity/checkpoint model

`[FROZEN]` I-14 — this model is a prerequisite for Composer and Templates, not a consequence of them.

### 6.1 The problem it solves

`[VERIFIED]` C-4: the only current signal is `RuntimeSession.lastEvidence`, a single overwrite-on-write field. Nothing distinguishes *neither advanced*, *planner advanced*, *worker advanced*, *both advanced*, or *unverified*, and nothing survives a restart.

### 6.2 Durable per-side checkpoint

`[FROZEN]` Each Pair side has a **durable** checkpoint. A checkpoint is persisted, survives restart, is never silently overwritten, and records what was true of that side at a specific observation.

`[FROZEN]` A checkpoint is per-side. There is no combined "Pair checkpoint" that merges both sides, because merging would invite cross-provider comparison (I-7).

### 6.3 The five advance states

`[FROZEN]` Comparison of the current observation against the durable checkpoint for a side yields exactly one of:

| State | Meaning |
|---|---|
| `neither-advanced` | Neither side shows change since the checkpoint. |
| `planner-advanced` | Only the planner side shows change. |
| `worker-advanced` | Only the worker side shows change. |
| `both-advanced` | Both sides show change. |
| `unverified` | Change could not be determined. |

`[FROZEN]` I-8: `both-advanced` must be **surfaced to the operator**, never automatically resolved. RelayX must not copy, forward, replicate, or reconcile content between sides in this state. `unverified` is a first-class outcome, not an error to be retried into a guess.

`[FROZEN]` I-7 constrains what "shows change" may mean. For a side whose provider exposes stable message identifiers (OpenCode, `getTranscript().messageId`), change is determined by identifier divergence from the checkpoint. For a LEVEL 0 side (ChatGPT), there are no message identifiers, so change determination is inherently `unverified` — it must degrade honestly to `unverified` rather than falling back to timestamp comparison, which I-7 forbids.

### 6.4 Checkpoint is not auto-updated on observation

`[FROZEN]` Observing a side does **not** advance its durable checkpoint. Checkpoint advancement is a separate, explicit, durable act. This is what makes `both-advanced` detectable at all: if the checkpoint moved on every observation, there would be nothing to compare against.

`[UNRESOLVED]` Who advances the checkpoint — operator, activation, or supervision — is not decided here. See §20, U-8.

### 6.5 Proposed structure

`[PROPOSED]` Candidate shape, not existing:

```ts
// [PROPOSED] — does not exist. Candidate shape only.
interface SideCheckpoint {
  sideRole: 'planner' | 'worker';
  lastKnownMessageRef: ExternalMessageRef | null;  // provider-stable where available
  lastKnownIdentity: ExternalSessionId | null;     // per I-11, evidence only
  capturedAt: number;
  source: { providerType: ProviderType; capability: string };
  determinacy: 'identified' | 'unverified';        // LEVEL 1 vs LEVEL 0 honesty
}

interface PairContinuity {
  planner: SideCheckpoint;
  worker: SideCheckpoint;
  advanceState: 'neither-advanced' | 'planner-advanced' | 'worker-advanced'
              | 'both-advanced' | 'unverified';
  computedAt: number;
}
```

`[FROZEN]` `determinacy` is what makes I-7 and C-8 jointly satisfiable: a LEVEL 0 side is permanently `unverified`, and the UI says so rather than presenting a fabricated comparison.

---

## 7. Provenance/audit model

`[FROZEN]` I-13. Provenance is permanent and append-only.

### 7.1 Three message origins

`[FROZEN]` Every message-bearing artifact carries exactly one of these origins, and they are never conflated:

| Origin | Meaning |
|---|---|
| `provider-produced` | A message the external provider actually produced. |
| `relayx-delivered` | A message RelayX actually delivered to an external session. |
| `operator-authored` | A message a human composed, possibly derived from a provider-produced source. |

### 7.2 Immutable source

`[FROZEN]` An operator-edited message is a **new artifact** that references an immutable source. The source record is never mutated, never overwritten, and never deleted by an edit.

`[FROZEN]` An operator-edited artifact records, durably:

- the immutable source it was derived from (or `null` if authored from scratch),
- the exact edited body,
- the source body as it was at derivation time, retained verbatim,
- the editing actor and the edit time.

`[FROZEN]` **Reload Source** is a read operation that restores the immutable source into the editor. It does not delete the current draft. Discarding a draft is a separate explicit act.

### 7.3 Delivery records preserve the distinction

`[FROZEN]` The `relayx-delivered` origin applies only to messages RelayX actually delivered, and only where the provider **proved** it. Where the provider cannot prove delivery — which per C-8 includes all ChatGPT cases after any interruption — the record must be marked as unproven delivery, not as delivered. `DeliveryInstructionResult` already distinguishes `delivered | ambiguous | failed`; provenance inherits that distinction and never upgrades `ambiguous` to `delivered`.

`[VERIFIED]` This rule is not hypothetical. See §9.4.1: `deliverHandoffToPlanner` records a handoff as delivered to the planner and emits `planner.notified` **without contacting the planner at all**. That is the exact failure this section forbids, present in current code.

### 7.4 No cross-origin inference

`[FROZEN]` RelayX must never infer that a `provider-produced` message corresponds to a `relayx-delivered` message unless the provider returned a stable identifier proving it. Without that proof the correspondence is `unverified`, and the audit record says `unverified`.

### 7.5 Proposed structure

`[PROPOSED]` Candidate shape, not existing:

```ts
// [PROPOSED] — does not exist. Candidate shape only.
interface MessageProvenance {
  origin: 'provider-produced' | 'relayx-delivered' | 'operator-authored';
  immutableSourceId: string | null;   // null only for from-scratch authoring
  sourceBodyAtDerivation: string | null;
  derivedBy: 'operator' | 'engine' | null;
  derivedAt: number | null;
  deliveryProof: 'proven' | 'unverified' | 'not-applicable';
}
```

---

## 8. Derived readiness model

`[FROZEN]` I-5. Readiness is derived, never persisted as authority.

### 8.1 The five readiness levels

`[FROZEN]` Derived readiness is exactly one of:

| Level | Meaning |
|---|---|
| `unknown` | Not enough current evidence to say. The default when the Pair is IDLE. |
| `checking` | A current observation is in flight. |
| `ready` | All current evidence supports proceeding. |
| `attention` | Current evidence is present but something needs operator attention. |
| `blocked` | Current evidence shows a condition that prevents proceeding. |

`[FROZEN]` `checking` is **ephemeral runtime state**. It is never persisted. This is the direct consequence of I-1: `checking` is not a third persisted operational value.

### 8.2 The staleness rule

`[FROZEN]` The central rule of this section:

> A persisted previous readiness value must **never** authorize execution after becoming stale.

Operationally:

- Readiness is recomputed from current evidence at every read that gates an action.
- A cached readiness value carries its observation time. If it is older than its validity window (§5.4), it is stale.
- A stale readiness value may be **displayed**, labelled as last-known.
- A stale readiness value may **never** gate, permit, or enable an action. No code path may read a cached readiness value as an authorization input.

`[FROZEN]` IDLE implies `unknown` readiness, because IDLE permits no contact (I-2) and therefore can never have current evidence.

### 8.3 Readiness is not execution authority

`[FROZEN]` Readiness describes observational sufficiency. It is **not** execution permission. Per `EXECUTION_AUTHORITY.md`, execution authority is governed separately and is unchanged by this design. A `ready` Pair is not thereby authorized to dispatch.

`[FROZEN]` This separation must be visible in the UI: readiness and execution authorization are shown as distinct facts, never as one badge.

---

## 9. Exact-session activation and transport requirements

### 9.1 The central gap

`[FROZEN]` **RelayX can activate a window. RelayX cannot address a conversation.**

`[VERIFIED]` This is confirmed by direct code evidence, and it is the single largest architectural constraint on this entire tranche.

`[VERIFIED]` `DeliveryInstructionRequest` (`src/relay/providers/interfaces.ts:33-37`) carries exactly three fields:

```ts
export interface DeliveryInstructionRequest {
  runtimeSessionId: RuntimeSessionId;
  instructionText: string;
  idempotencyKey: string;
}
```

There is no conversation identifier, no session identifier for the external surface, and no target-message or thread reference.

`[VERIFIED]` `RelayEngine.dispatchAssignment` passes only those three fields (`src/relay/application/RelayEngine.ts:990-994`).

### 9.2 Confirmed gap A — frontmost-window delivery

`[VERIFIED]` Both adapters implement `deliverInstruction` identically in approach. The ChatGPT adapter is at `src/relay/providers/adapters.ts:1291`; the OpenCode adapter is at `src/relay/providers/adapters.ts:2357`. Both do the same four things:

1. Probe the process by name.
2. `tell application "<name>" to activate`, then `set frontmost of (item 1 of procs) to true` (ChatGPT at `adapters.ts:1336`, OpenCode at `adapters.ts:2403`).
3. Set the clipboard, `keystroke "v" using command down`, `key code 36` (Return).
4. Check `every button of window 1 whose name contains "Stop"` and return `"sent::<hasStop>"`.

`[FROZEN]` Consequences, all of which are requirements, not observations:

- Delivery targets **whatever window happens to be frontmost**, not a specific session. `window 1` of the focused process is used unconditionally.
- `runtimeSessionId` is **not** resolved to an external session or conversation before the keystrokes are sent. It is passed but not used to select a target.
- The only post-send verification is the presence of a button whose name contains "Stop". That is a **heuristic UI proxy for activity**, not proof that the message was delivered to the intended conversation.
- Delivery can silently land in the **wrong conversation** and still return `delivered`.
- Any concurrent window focus change between the focus step and the keystroke step redirects the message.

`[UNRESOLVED]` Whether frontmost delivery can be tolerated under a strictly human-driven regime, or whether exact-session transport is a hard prerequisite for Composer, is a human decision. See §20, U-2.

### 9.3 Confirmed gap B — no real Worker-response extraction

`[VERIFIED]` `detectCompletionState` returns an optional `responseSummary` (`src/relay/providers/interfaces.ts:61`). Both adapters populate it, and both populate it with a **synthesized descriptive string**, not extracted content:

- ChatGPT, `adapters.ts:1473`:
  `` responseSummary: `ChatGPT planner generated plan in window "${probe.windowTitle || 'ChatGPT'}"` ``
- OpenCode, `adapters.ts:2585`:
  `` responseSummary: `OpenCode worker finished work in window "${probe.windowTitle || 'OpenCode'}"` ``

`[VERIFIED]` These strings are descriptions of an event, not the response. They contain no message text from the provider.

`[VERIFIED]` `getTranscript` exists and returns real content — `messageId`, `text`, `role`, `createdAt` — but it lives on `OpenCodeSessionClient` (`src/relay/providers/opencodeSessionClient.ts:438`) and is **not exposed on `IRuntimeProvider`**, and is **not used by `RelayEngine`**.

`[FROZEN]` Therefore, at the time of this freeze, RelayX **cannot extract a real worker response** through any provider-neutral path. The transcript capability exists for OpenCode only and is not wired to the engine. Extracting a real worker response requires a new provider capability, not merely enabling an existing one.

### 9.4 Confirmed gap C — no actual Planner-conversation delivery

`[VERIFIED]` There is no provider capability that delivers into a specific conversation. `IRuntimeProvider` (`src/relay/providers/interfaces.ts:52-82`) offers no such method, and `RelayEngine` contains no reference to `plannerConversation`, `getTranscript`, or `conversationUrl` in its dispatch path.

`[VERIFIED]` `OpenCodeSessionClient` is read-only. Its methods are `listSessionsByDirectory`, `getSession`, `getActiveSessions`, `getSessionStatus`, `getServiceInfo`, `getTranscript`, `getContext`. There is **no** send, prompt, or message-creation method.

`[FROZEN]` Therefore, at the time of this freeze, RelayX **cannot deliver into a specific planner conversation** by any exact-session means. Any planner-directed send today would be a frontmost-window keystroke with the same wrong-conversation risk as §9.2.

### 9.4.1 Stronger finding — the existing planner-delivery path contacts nothing

`[VERIFIED]` This was found during final evidence verification and materially strengthens gap C.

`[VERIFIED]` `RelayEngine.deliverHandoffToPlanner(handoffId)` (`src/relay/application/RelayEngine.ts:1221-1235`) is documented in-code as *"Completing a handoff delivers result to planner"* (`RelayEngine.ts:1218`). Its entire body is:

```ts
const handoff = await this.repos.handoffs.findById(handoffId);
if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

handoff.markDeliveredToPlanner();          // pure state transition
await this.repos.handoffs.save(handoff);

await this.emitEvent('handoff', handoff.id, 'planner.notified', {
  actor: 'engine', previousState: 'ready', newState: 'delivered',
});
```

`[VERIFIED]` There is **no** `provider.deliverInstruction(...)` call, no `getProvider(...)` lookup, and no external contact of any kind in this method or in `completeHandoff()` immediately following it. The planner is never actually contacted.

`[VERIFIED]` Despite this, the method emits a `planner.notified` event with `actor: 'engine'`, `previousState: 'ready'`, `newState: 'delivered'`. The event stream therefore **asserts that the planner was notified when nothing was sent**. `planner.notified` is emitted from exactly one place, `RelayEngine.ts:1228`.

`[FROZEN]` This is a live instance of precisely the defect I-13 and the §7 provenance model exist to prevent: an audit record asserting an external fact that was never established. It is recorded here as evidence, and it is the reason §7.3 forbids upgrading an unproven outcome and §7.4 forbids inferring correspondence without provider-stable identifiers.

`[FROZEN]` Consequence for this design: the planner side of the loop has **no** working delivery path at all — neither exact nor frontmost. S11 (exact Planner delivery) is not an improvement to an existing working path; it is the construction of one that does not currently exist.

`[VERIFIED]` The schema anticipates planner-directed work that the code does not implement: `planner_assistances` (`SqliteDatabase.ts:202`) and `planner_action_requests` (`SqliteDatabase.ts:218`), both carrying `planner_session_id` and `planner_external_session_id`, are defined but have no writer in `src/`. These are dormant schema, not a capability.

### 9.5 Consequence for Load & Activate

`[FROZEN]` Load & Activate must be built on the capabilities that **do** exist and must not assume capabilities that do not:

- Identity resolution and verification against a **specific** external session **is** available, via the protected OpenCode discovery capabilities at `OPENCODE_SESSION_DISCOVERY.md` / `ef6185b` (I-16), and via read-only inspection.
- Locating and reading a specific session's messages **is** available for OpenCode via `getTranscript`.
- Neither of these is available for ChatGPT, which is LEVEL 0.
- Activation is a **focus/visibility** operation, and the existing `activateRuntime` capability is appropriate. Activation does not imply addressability.

`[FROZEN]` Load & Activate must therefore be honest about the asymmetry: it can fully verify the OpenCode side and cannot fully verify the ChatGPT side. The UI must show per-side verification capability, not a single pair-level "verified" badge.

### 9.6 Requirements arising

`[FROZEN]` Any future capability that claims to deliver to an **exact** session must:

1. Address the target by the provider's own external session identifier, never by name and never by frontmost window. (I-11)
2. Return proof of target identity at the moment of send, or report `ambiguous` / `failed`. Never return `delivered` without identity proof.
3. Preserve the existing three-phase dispatch discipline from `dispatchAssignment` (`RelayEngine.ts:988`): durable intent in a transaction, external call **outside** the transaction, outcome in a second transaction. An exact-session capability must not be wired inside a DB transaction.
4. Preserve the existing `delivered | ambiguous | failed` outcome contract.
5. Not weaken I-7: no cross-provider timestamp comparison may be introduced as part of target selection or delivery verification.

---

## 10. Persistence/schema delta

`[FROZEN]` **All of this section is `[PROPOSED]`.** None of these tables or columns exist. Current schema is `PRAGMA user_version = 3` with tables `pairs`, `attempts`, `runtime_project_associations`, and others.

### 10.1 Migration constraints

`[FROZEN]` Every change in this section must be:

- **Additive only.** New tables and new columns. No column drops, no type narrowing, no table renames in this tranche.
- **Gated on `PRAGMA user_version`**, following the existing `addColumnIfNeeded(...)` pattern at `src/relay/persistence/sqlite/SqliteDatabase.ts`.
- **Consistent with the Plan-First precedent** of refusing to drop legacy tables holding rows.

`[FROZEN]` No existing table may be dropped or have a column removed in this tranche, regardless of how safe it appears.

### 10.2 Proposed additions to `pairs`

`[PROPOSED]`

| Column | Type | Purpose | Invariant |
|---|---|---|---|
| `operational_state` | `'IDLE' \| 'ACTIVE'` | The two-valued operational dimension (I-1) | Exactly two values. No third value, ever. Default `IDLE`. |
| `stable_pair_id` | text | A Pair identity that survives update (C-1) | Immutable once set. |

`[FROZEN]` `operational_state` is separate from the existing `PairStatus` column, which retains the lifecycle values. `idle`/`active` migrate out of the lifecycle column's role; see §17.2 for the migration concern.

`[FROZEN]` `checking` and every other transient condition is **not** a value of `operational_state`. It is ephemeral runtime state (I-1, §8.1).

### 10.3 Proposed new tables

`[PROPOSED]` Names are candidates. The invariants in the right-hand column are the binding part.

**Side observations** — durable last-known per-side evidence (supports I-3, I-6, C-4).

| Column | Purpose | Invariant |
|---|---|---|
| `id` | Primary key | |
| `session_pair_id` | Owning Pair | Foreign key |
| `side_role` | `'planner' \| 'worker'` | Exactly two values |
| `identity_state`, `identity_value` | Dimension 1 | Tri-state; `unknown` ≠ `false` |
| `identity_verification_state`, `identity_verification_value` | Dimension 2 | Tri-state |
| `existence_state` | Dimension 3 | Tri-state |
| `reachability_state` | Dimension 4 | Tri-state |
| `ui_presence_state` | Dimension 5 | Tri-state |
| `activity_state_value` | Dimension 6 | Tri-state |
| `message_evidence_state`, `message_ref`, `message_role`, `message_text`, `message_truncated` | Dimension 7 | Tri-state; truncation is recorded, not hidden (C-8) |
| `source_provider`, `source_capability` | Dimension 8 | **Always populated** (I-6) |
| `observed_at` | Dimension 9 | **Always populated** |
| `valid_until` | Freshness window | Required for staleness (I-5) |

**Side checkpoints** — durable per-side continuity baseline (I-14, C-4).

| Column | Purpose | Invariant |
|---|---|---|
| `id` | Primary key | |
| `session_pair_id`, `side_role` | Owning Pair and side | |
| `last_known_message_ref` | Provider-stable ref where available | `null` for LEVEL 0 |
| `last_known_identity` | Evidence only | Never authoritative (I-11) |
| `determinacy` | `'identified' \| 'unverified'` | LEVEL 0 is permanently `unverified` (§6.5) |
| `captured_at` | When captured | |
| `source_provider`, `source_capability` | Provenance of the checkpoint | Always populated |

`[FROZEN]` Checkpoints are **append-only**. A new checkpoint is a new row; a prior checkpoint is never updated or deleted. This is what makes advance-state comparison meaningful across restarts.

**Message provenance** — immutable source / derived artifact chain (I-13).

| Column | Purpose | Invariant |
|---|---|---|
| `id` | Primary key | |
| `session_pair_id` | Owning Pair | |
| `origin` | `'provider-produced' \| 'relayx-delivered' \| 'operator-authored'` | Exactly three values |
| `immutable_source_id` | FK to the source record | Never nulled by an edit |
| `source_body_at_derivation` | Verbatim source at derivation | Never updated |
| `body` | Current text of this artifact | |
| `derived_by`, `derived_at` | Edit provenance | |
| `delivery_proof` | `'proven' \| 'unverified' \| 'not-applicable'` | Never upgraded past what the provider proved (§7.3) |

`[FROZEN]` Records in this table are **append-only**. An edit creates a new row referencing the source. The source row is never mutated. Reload Source is a read.

### 10.4 Proposed tables deferred out of this tranche

`[PROPOSED]` **Prompt Templates are deliberately NOT specified as schema in this document.** See §14 and §19. Template storage is specified architecturally in §14, but the concrete table shape is deferred to the Templates implementation slice, because Templates depend on the dispatch path being proven and frozen first. Designing the table now would be designing against an unsettled interface.

### 10.5 The cascade hazard

`[VERIFIED]` `assignments` has `ON DELETE CASCADE` to `pairs`. Deleting a Pair destroys its assignment, attempt, delivery, and handoff history.

`[FROZEN]` Given I-10, the history/audit surfaces in §7 and §12 must not be implemented in a way that invites Pair deletion as a cleanup mechanism, and this design **does not** change the cascade in this tranche.

`[UNRESOLVED]` Whether the cascade should be changed to preserve history is a real question, but it is not decided here. See §20, U-9.

---

## 11. Service/API operations and ownership

`[FROZEN]` **All of this section is `[PROPOSED]`.** None of these operations exist. They are named to describe intent; implementation may rename them so long as the frozen semantics below hold.

### 11.1 Ownership boundary

`[FROZEN]` Load & Activate is an **application-service** operation, not a provider operation and not a domain method. It orchestrates; it does not itself touch a provider.

`[FROZEN]` Provider capability is extended only by adding **new** optional capabilities to `IRuntimeProvider`. Existing required members are not changed, and no existing capability is weakened. This is the concrete form I-16 takes for the provider layer.

### 11.2 Operation set

`[PROPOSED]`

| Operation | State precondition | Provider contact | Changes operational state | Frozen semantics |
|---|---|---|---|---|
| `loadAndActivate(pairId)` | `IDLE` only | Yes | `IDLE` → `ACTIVE` | Resolve identity **independently per side**; verify each side against its provider; retrieve message evidence per side capability; compare against durable checkpoints; derive readiness. Any terminal failure → `IDLE`. |
| `makeIdle(pairId, reason)` | Any | No | `ACTIVE` → `IDLE` | Stop observation and interaction. **Preserve** bindings, history, checkpoints, cursors, provenance, last-known evidence. Idempotent. |
| `observeSide(pairId, sideRole)` | `ACTIVE` | Yes | No | Single observation of one side. Writes a new observation row. Does **not** advance the checkpoint (§6.4). |
| `deriveReadiness(pairId)` | Any | No | No | Pure derivation from current evidence. Never persists an authorizing value. Returns `unknown` when IDLE. |
| `computeContinuity(pairId)` | Any | No | No | Compares current observation to durable checkpoint. Returns one of the five advance states. |
| `captureCheckpoint(pairId, sideRole)` | `ACTIVE` | No | No | Durable, append-only checkpoint advance. Explicit only. |
| `getPairDetail(pairId)` | Any | No | No | Assembles Pair Detail Rev 2 view model from persisted data. Provider-free. |
| `dispatchOperatorMessage(pairId, sideRole, artifactId)` | `ACTIVE` + execution authority | Yes | No | Reuses the **existing** three-phase `dispatchAssignment` path. Does not introduce a parallel path (I-15). |

### 11.3 Per-side independence

`[FROZEN]` `loadAndActivate` resolves and verifies **each side independently**. A failure or capability gap on one side does not abort the other side's resolution. The result is a per-side outcome, not a single pass/fail.

`[FROZEN]` This is a direct consequence of C-8 and §9.5. The OpenCode side can be fully verified while the ChatGPT side remains unverified, and the operation reports exactly that.

`[FROZEN]` A side that cannot be verified is recorded as `unknown` per §5.3 — never as `false`, and never silently omitted.

### 11.4 Idempotency

`[FROZEN]` `loadAndActivate` is idempotent with respect to operational state: calling it on an `ACTIVE` Pair is rejected rather than silently re-running. Re-running a partially failed activation is a distinct explicit retry, not an implicit side effect of calling the operation again.

### 11.5 Provider contact gate

`[FROZEN]` Every provider contact is gated on `operational_state === 'ACTIVE'`. This gate is enforced in the application service, and it is the single enforcement point for I-2. No provider capability may be invoked through any other path while a Pair is IDLE.

---

## 12. Pair Detail Revision 2 view model/actions

`[FROZEN]` **This section is `[PROPOSED]` except for the invariants it carries.** `src/components/PairView.tsx` is pair-centric today; Rev 2 evolves it, and does not replace the pair-centric orientation.

### 12.1 Orientation

`[FROZEN]` Pair Detail Rev 2 is **pair-centric**. The primary object is the Pair and its relationship between two sides. It is not a per-side view with the Pair as a header.

`[FROZEN]` **Latest messages are evidence and secondary inspection.** They are shown to let the operator judge state, and they are clearly subordinate to the pair-level continuity and readiness picture. They are a read surface.

`[FROZEN]` Latest messages are **evidence for inspection only**. They are not an editing surface in Rev 2. The Composer (§13) is a later, separate capability that these messages may eventually feed. Rev 2 does not pre-build that.

### 12.2 Composition

`[FROZEN]` The view model presents, in this order of authority:

1. **Pair identity** — stable identity, human-readable name, and the two bound external identities, with each clearly marked as authoritative-ID vs name-as-evidence (I-11).
2. **Operational state** — `IDLE`/`ACTIVE`, prominently, since it governs what is even possible.
3. **Per-side observation** — the nine dimensions of §5.2, per side, each showing its own tri-state, source, and observation time.
4. **Verification capability asymmetry** — explicitly showing which sides this provider combination can verify at all, per C-8.
5. **Continuity** — the advance state, and the checkpoints it was computed against.
6. **Readiness** — derived, with its staleness status visible, and explicitly separated from execution authority (§8.3).
7. **Latest messages** — secondary, per side, per §12.1.
8. **History and provenance** — access to the audit records of §7.

### 12.3 Staleness is visible

`[FROZEN]` Any value rendered from a stale observation is visually marked as last-known, together with its observation time. I-3 requires this and it is a rendering requirement, not a nicety: an unmarked stale value is indistinguishable from a current one, which would be a correctness failure.

### 12.4 Action set

`[FROZEN]` Rev 2 exposes:

| Action | Availability | Notes |
|---|---|---|
| `Load & Activate` | IDLE only | §11.2 |
| `Make Idle` | ACTIVE only | Idempotent; preserves all state (I-10) |
| `Observe now` | ACTIVE only | Explicit single observation; does not advance checkpoints |
| `Capture checkpoint` | ACTIVE only | Explicit |
| `Refresh` | Any | Provider-free; re-derives from persisted data |
| `Start Pair` | As today | **Unchanged**; distinct from Load & Activate (I-9) |
| `Pause` | As today | Unchanged |
| `Reconcile` | As today | Unchanged; unchanged semantics |
| `Edit` | As today | Unchanged; existing manual editing is not affected by §15 |
| `Archive` | As today | Unchanged |
| `Composer` | **Deferred** | Not in Rev 2; see §18 and §19 |

`[FROZEN]` Rev 2 must not remove any action that exists today. Existing actions keep their existing behaviour.

### 12.5 Implementation note

`[FROZEN]` The IDLE-last-known vs ACTIVE-live-observed distinction must follow the **existing precedent** in `src/components/detailViewModels.ts` (`SavedBinding` vs `DiscoveredIdentity` with `BindingVerificationStatus`), rather than introducing a second, parallel pattern. Pure view-model logic should follow the precedent of `src/components/pairModalConversation.ts`.

---

## 13. Composer/manual dispatch design

`[FROZEN]` **Deferred in implementation order** (§18), but frozen in design here, because Composer must be built on the continuity and provenance models (I-14) and must not invent its own tracking.

### 13.1 Scope

`[FROZEN]` The Composer is an **operator-editable message surface**. It lets an operator compose, edit, and send a message to one side of a Pair.

`[FROZEN]` The Composer is **not** in Rev 2 (§12.1) and does not exist at the time of this freeze (C-7).

### 13.2 Editing semantics

`[FROZEN]` The Composer maintains the immutable-source vs modified-draft distinction required by I-13:

- A draft is derived from an immutable source, or authored from scratch.
- The source is never mutated by editing.
- `Reload Source` restores the immutable source into the editor without discarding the current draft.
- The edited body and the source body at derivation time are both retained durably (§7.5).

### 13.3 Dispatch is the existing governed path

`[FROZEN]` **Critical:** Composer dispatch reuses the existing three-phase `dispatchAssignment` path. It does **not** create a parallel send path. This is the concrete form I-15 takes for the Composer.

`[FROZEN]` Therefore Composer-instantiated sends produce `relayx-delivered` provenance with the same `delivered | ambiguous | failed` outcome contract, the same three-phase transaction discipline, and the same durability guarantees as engine-initiated sends. They differ only in the initiating actor, which is recorded as provenance.

`[FROZEN]` Composer dispatch is subject to I-11 and §9.6. It cannot claim exact-session addressing, because no such capability exists (§9.2, §9.4). This is a **known, frozen limitation** at the time of this freeze and must be surfaced in the Composer UI, not hidden. Whether the Composer may ship at all before exact-session transport exists is a human decision — see §20, U-1. The broader frontmost-delivery risk envelope is a separate question, U-2.

### 13.4 Actor recording

`[FROZEN]` Operator-initiated sends record `derivedBy: 'operator'`. Engine-initiated sends record `derivedBy: 'engine'`. The distinction is durable and permanent (I-13).

---

## 14. Prompt Template storage/render/dispatch architecture

`[FROZEN]` **Deferred in implementation order** (§18), frozen in design here.

### 14.1 First-class definitions

`[FROZEN]` I-15. Prompt Templates are **first-class reusable definitions** — persisted domain objects, not strings embedded in UI code, and not generated on the fly.

### 14.2 Required properties

`[FROZEN]` A template definition must be able to express, at minimum:

| Property | Requirement |
|---|---|
| **Identity/key** | A stable, addressable key. |
| **Target** | Which side(s) it applies to — planner, worker, or both. |
| **Category** | Grouping for operator navigation. |
| **Body** | The template text itself. |
| **Variables** | Declared, named placeholders with declared inputs. |
| **Enabled state** | Whether the template is currently available. |
| **Provenance** | Whether it is a RelayX built-in or operator/user-authored. |
| **Versioning** | Enough history to understand what changed and when. |

`[FROZEN]` Built-in and user templates are **distinguished**, and the distinction is durable. RelayX never represents a user template as a built-in or vice versa.

### 14.3 One governed dispatch path

`[FROZEN]` I-15, restated as the central architectural requirement of this section:

> Templates are consumed by **both** human-initiated actions and future engine-initiated actions, through a **single** governed dispatch path.

Operationally:

- There is exactly one dispatch pipeline. Templates must not add a second, faster, or "template-specific" delivery path.
- Template dispatch and Composer dispatch and engine dispatch all flow through the same three-phase `dispatchAssignment` discipline (§13.3, §9.6).
- Every template-dispatched message produces the same provenance records as any other dispatch (I-13), with the template identity recorded.
- Templates inherit every constraint in this document. A template cannot bypass I-2 (IDLE), I-7 (no cross-provider ordering), I-11 (identity), I-13 (provenance), or §9.6 (delivery proof).

### 14.4 Render

`[FROZEN]` Rendering a template produces a **message artifact with full provenance**, not a bare string. A rendered template carries `origin: 'operator-authored'` (or `'relayx-delivered'` once dispatched), its template identity and version, its variable bindings, and — if derived from a source message — the immutable source reference.

`[FROZEN]` Rendering a template does **not** dispatch. Render and dispatch are distinct steps, so an operator can inspect, edit, and reload source on a rendered template exactly as on any other artifact (§13.2).

### 14.5 Automation eligibility is explicitly deferred

`[FROZEN]` The policy governing **which templates may be applied automatically**, and **how recovery from a failed application behaves**, is **not designed in this tranche**.

`[FROZEN]` What is frozen is only the architectural precondition: the architecture must be able to express an eligibility decision and a recovery decision later, without a schema change and without a second dispatch path. This is achieved by §14.3's single-path requirement — eligibility and recovery are policy inputs to the one path, not new paths.

`[FROZEN]` No eligibility field, no policy engine, and no recovery heuristic is specified here. See §19 and §20, U-5.

### 14.6 Schema deferral

`[FROZEN]` The concrete template table shape is **not** specified in §10, deliberately. Templates are the second-to-last slice (§18) and depend on a proven, frozen dispatch path. Specifying the table earlier would freeze an interface against an unsettled one.

---

## 15. Pair creation: existing/manual vs future New/New

`[FROZEN]` This section covers two clearly separated things: the existing path, which is untouched, and a future path, which is not designed in this tranche.

### 15.1 Existing manual creation — unchanged

`[FROZEN]` Manual Pair creation through `PairModal` and `createPair` is **unchanged**. Its conversation-URL binding contract, planner URL confirmation flow, and worker adopt/create flows are preserved exactly. This design adds no requirement to manual creation.

`[FROZEN]` Load & Activate operates on manually created Pairs. It adds no new precondition to their creation and imposes no new constraint on the binding contract.

`[FROZEN]` Note for the record: `src/components/PairModal.tsx` currently carries pre-existing unstaged modifications unrelated to this design. Those are preserved untouched.

### 15.2 Future New/New creation — architectural constraints only

`[FROZEN]` A future automatic **New/New** creation path is **not designed in this tranche**. Only the constraints it must satisfy are frozen, so that the design does not foreclose it.

`[FROZEN]` **The shared-name constraint.** A future New/New path uses the **same human-readable Pair Name on both external sessions**, so that a human looking at either side can recognize the pairing.

`[FROZEN]` **The name is evidence, never identity.** Per I-11, the shared name is **discoverability and recovery evidence only**. It is never authoritative identity. Authoritative identity is always the provider's own external session identifier.

`[FROZEN]` **No faked success.** RelayX must never report that automatic planner creation or automatic naming succeeded when the provider has not proven it. If the provider cannot prove creation or cannot prove the name, the result is `ambiguous` or `unverified` — never `succeeded`.

`[FROZEN]` **Per-side honesty.** Creation outcomes are per-side, never a single pair-level success flag, consistent with §11.3.

`[FROZEN]` **Capabilities are consumed, not redesigned.** Where the future path touches OpenCode session creation or discovery, it consumes the protected capabilities at `OPENCODE_SESSION_DISCOVERY.md` / `ef6185b` unchanged (I-16).

`[UNRESOLVED]` The New/New path depends on capabilities that do not exist today — chiefly, a way to create a session in a **specific, addressable** conversation and prove the name was applied. See §20, U-3.

### 15.3 Recovery use of the name

`[FROZEN]` Because the shared name is recovery evidence, a future recovery mechanism may use it to **help a human find** a session. It may not use it to **automatically identify** one, and it may not be used as a matching key for automated decisions.

---

## 16. Provider capability boundaries

`[FROZEN]` These boundaries are permanent and must be reflected honestly in the UI and in the domain model. They are not defects to be worked around; they are the shape of the available provider surface.

### 16.1 The LEVEL framework

`[VERIFIED]` `PROVIDER_DISPATCH_GROUND_TRUTH.md` defines the LEVELs. ChatGPT is **LEVEL 0**. OpenCode is **LEVEL 1** (evidence-assisted). **No provider reaches LEVEL 2.**

### 16.2 Per-provider capability matrix

`[VERIFIED]` Combined from the repository inspection in §2:

| Capability | ChatGPT | OpenCode |
|---|---|---|
| Process/window presence | Yes — AppleScript focus, `adapters.ts:1330` | Yes — AppleScript focus, `adapters.ts:2397` |
| Exact-session addressing | **No** | **No** |
| Message read | **No** — LEVEL 0, no transcript | **Yes** — `getTranscript`, `opencodeSessionClient.ts:438` |
| Stable message ID | **No** | **Yes**, provider-generated, `opencodeSessionClient.ts` |
| Message text fidelity | n/a | **Truncated at 2000 chars**, `MAX_TEXT_CHARS` |
| Message history depth | n/a | **50 default**, `DEFAULT_TRANSCRIPT_LIMIT` |
| Real response extraction | **No** — synthesized string, `adapters.ts:1473` | **No** — synthesized string, `adapters.ts:2585` |
| Delivery to the **planner** specifically | **No** — no provider call at all, `RelayEngine.ts:1221-1235` | **No** — same path |
| Delivery proof | Heuristic — "Stop" button presence only | Heuristic — "Stop" button presence only |
| Session discovery | Via UI enumeration | **Yes** — protected, `ef6185b` |
| Session creation | **No** | **Yes** — `createWorkerSession`, protected, `ef6185b` |
| Post-crash message identity | **Cannot prove** | Can prove within the 50/2000 bounds |

### 16.3 Frozen consequences

`[FROZEN]`

1. **No reliable cross-restart identity for ChatGPT.** After an interruption, RelayX cannot prove which message, if any, was delivered. Any such record is `unverified`, permanently.
2. **ChatGPT-side continuity is permanently `unverified`.** Per §6.3, there are no stable identifiers, so change determination cannot proceed, and I-7 forbids the timestamp fallback.
3. **OpenCode-side continuity is bounded.** It is determinable only within the 50-message default limit and 2000-character truncation. Truncation is recorded in provenance, never silently dropped.
4. **"Response extraction" is not a capability either provider has.** Both adapters return a synthesized description. This is a gap to close (§9.3), not a capability to consume.
5. **Delivery proof is a heuristic on both sides.** `delivered` from a LEVEL 0 provider means "a Stop button appeared in the frontmost window", not "your message reached the intended conversation."
6. **LEVEL asymmetry is per-side, not per-pair.** A Pair's verification capability is the intersection of its two sides' capabilities, and must be displayed as such (§12.2, item 4).

---

## 17. Compatibility/migration implications

### 17.1 Additive-only

`[FROZEN]` All changes are additive, gated on `PRAGMA user_version`, following `addColumnIfNeeded(...)`. No drops in this tranche (§10.1).

### 17.2 The `PairStatus` overlap

`[VERIFIED]` `PairStatus` includes `idle` and `active` alongside the lifecycle values.

`[FROZEN]` The new `operational_state` column takes over the meaning of `idle`/`active`. The existing column retains the lifecycle values. This overlap must be resolved explicitly during implementation, not left ambiguous, because two sources of truth for operational state would directly violate I-1.

`[UNRESOLVED]` Whether the existing `idle`/`active` values are retained as deprecated aliases, or removed, is not decided here. The Plan-First precedent of refusing destructive changes suggests retaining them. See §20, U-6.

### 17.3 Backfill of `operational_state`

`[FROZEN]` Existing Pairs must backfill to `operational_state = 'IDLE'`. This is the **only safe default**, because `ACTIVE` would imply a permission to contact providers that cannot be justified for a pre-existing record (I-2).

`[FROZEN]` Backfill to IDLE is safe because IDLE guarantees no provider contact and preserves all last-known evidence (I-2, I-3, I-10). No existing behaviour is broken by backfilling to IDLE, since pre-existing Pairs have no persisted observation to lose.

### 17.4 No checkpoint means `unverified`

`[FROZEN]` Pre-existing Pairs have no durable checkpoints (C-4). Their initial continuity state is `unverified`, not `neither-advanced`. Assuming "neither advanced" would be a false negative claim about the external world, violating I-6.

### 17.5 UI compatibility

`[FROZEN]` Rev 2 must not remove any existing action, and existing actions keep their existing behaviour (§12.4). The existing manual creation flow is untouched (§15.1).

### 17.6 Provider layer

`[FROZEN]` Only **new optional** members may be added to `IRuntimeProvider`. No existing member changes signature, and no existing capability is weakened (I-16).

### 17.7 Dispatch path

`[FROZEN]` The three-phase `dispatchAssignment` discipline is the single governed path. Composer and Templates route through it (§13.3, §14.3). No new transaction boundary is introduced.

### 17.8 The cascade

`[VERIFIED]` `assignments` has `ON DELETE CASCADE` to `pairs` (§2.5, §10.5). This design does not change it in this tranche, and the history surfaces must not invite deletion as cleanup (§10.5).

---

## 18. Implementation slices in dependency order

`[FROZEN]` The dependency chain is binding. Each slice consumes the frozen output of its predecessors. **No slice may begin before its predecessor is proven.** In particular, I-14 forbids Composer or Templates starting before the cursors/provenance slice is complete.

| # | Slice | Depends on | Frozen exit condition |
|---|---|---|---|
| **S0** | **Baseline** | — | `ef6185b` verified intact; `OPENCODE_SESSION_DISCOVERY.md` and its regression gates green and untouched. |
| **S1** | **Pair semantics** | S0 | C-1 and C-2 resolved. Stable pair identity; separate two-valued `operational_state`; no third value exists. |
| **S2** | **Observation** | S1 | All nine dimensions of §5.2 modelled; tri-state enforced; source and time mandatory; `unknown` never collapses to `false`. |
| **S3** | **Cursors / provenance** | S2 | Durable per-side checkpoints; five advance states; message provenance with immutable sources; both append-only. |
| **S4** | **Provider reads** | S2, S3 | Message read available through a provider-neutral capability. Consumes, and does not weaken, protected OpenCode capabilities. |
| **S5** | **Exact activation** | S4 | Per-side identity resolved and verified against a **specific** external session, not frontmost window and not name. |
| **S6** | **Load & Activate / Make Idle** | S5 | Both operations exist and are separate from `Start Pair`. Load & Activate per-side honest. Make Idle preserves all state (I-10). |
| **S7** | **Continuity** | S6 | Advance states computed against durable checkpoints; `both-advanced` surfaced, never auto-resolved (I-8); no cross-provider ordering (I-7). |
| **S8** | **Readiness** | S7 | Readiness derived, never persisted as authority; stale readiness cannot authorize (I-5); `checking` never persisted (I-1). |
| **S9** | **Exact Worker delivery** | S6, S8 | Delivery addresses the target by provider external ID, never frontmost window. Returns identity proof or `ambiguous`/`failed` (§9.6). |
| **S10** | **Real Worker response** | S9, S4 | Worker response actually **extracted** from the provider, not synthesized (§9.3). This closes gap B. |
| **S11** | **Exact Planner delivery** | S10, S9 | Delivery into a **specific planner conversation**, not frontmost window. This closes gap C (§9.4). |
| **S12** | **End-to-end proof** | S11 | A real dispatch reaches the intended session, is proven delivered, and its real response is extracted — end to end, with no frontmost heuristic anywhere in the path. |
| **S13** | **Pair Detail R2** | S12 | Pair-centric detail per §12; all nine dimensions per side; LEVEL asymmetry visible; staleness visible; no action removed. |
| **S14** | **Composer** | S13, S3 | Editable message surface with immutable source, Reload Source, and provenance; dispatch reuses the **existing** governed path (I-15). |
| **S15** | **Templates** | S14 | First-class template definitions (§14.2); single governed dispatch path shared with human and engine actions; automation eligibility **still deferred** (§14.5). |
| **S16** | **New/New creation** | S15 | Future path using the same Pair Name on both sides, name as evidence only (I-11), no faked success, consuming protected capabilities. |
| **S17** | **Recovery eligibility** | S16 | **First point at which the deferred policy of §14.5 is designed.** Everything before this slice is the architecture that makes it expressible. |
| **S18** | **Autonomous supervision** | S17 | Engine-initiated use of templates, only after the eligibility and recovery policy exists. |

`[FROZEN]` Ordering rationale that must not be reordered:

- S2 before S3: continuity is meaningless without observations to compare.
- S3 before S14/S15: **I-14.** Composer and Templates consume cursors and provenance; they do not create them.
- S4 before S5: exact activation is built on provider reads, not on UI focus.
- S5 before S6: Load & Activate requires verified per-side identity, which does not exist before S5.
- S8 before S9: delivery requires readiness that cannot be stale.
- S9 → S10 → S11: exact delivery first, then real response extraction, then the planner side. Response extraction requires exact delivery to know what response to extract.
- **S12 before S13:** Pair Detail R2 is not shown until the underlying path is proven end to end. The UI must not be built on unproven delivery.
- S14 before S15: Templates reuse the Composer-established dispatch-through-existing-path pattern.
- S15 before S17: **§14.5.** Eligibility policy is designed only after the single dispatch path it constrains exists and is proven.
- S17 before S18: no autonomous use before the policy governing it exists.

### 18.1 Placement note for C-1

`[FROZEN]` The `SESSION_PAIR_REPLACEMENT.md` contract conflict (C-1) is not a separate slice. It is resolved inside **S1 (Pair semantics)**, because stable Pair identity is a precondition for anchoring observations, checkpoints, and provenance in S2 and S3. Resolving C-1 later would leave S3 anchoring provenance to a mutable identity, which is the defect C-1 describes.

`[VERIFIED]` **S1 execution note (narrow factual correction, added by the S1 implementation).** The *stable identity* half of C-1 is delivered in S1 as `pairs.stable_pair_id` / `Pair.stableId`, immutable once set and deliberately omitted from the upsert `DO UPDATE` set. The *replacement operation* half — making `updatePair()` create a new Pair — is **fenced, not delivered**, because two existing regression gates assert the current in-place behaviour and re-deciding them is outside S1's authority:

- `tests/pair_mutation_association.test.ts:173` asserts `updated.id === pair.id` after a rebinding. This file is part of the executable preservation map in `OPENCODE_SESSION_DISCOVERY.md` (I-16).
- `tests/management_lifecycle.test.ts:178-182` re-reads the Pair by its **pre-update** `pair.id` after the same call.

`[VERIFIED]` Any implementation that made `updatePair()` return a different row would break both. The fence is therefore explicit rather than silent: `stableId` is the safe prerequisite that stops the in-place mutation from silently moving the ownership of a recorded fact, and the replacement operation itself waits until those two gates are re-decided. See `S1_PAIR_SEMANTICS_IMPLEMENTATION.md` §2.

---

## 19. Explicit non-goals

`[FROZEN]` The following are **explicitly out of scope** for this freeze and for the tranche it governs.

| # | Non-goal | Reason |
|---|---|---|
| N-1 | **Implementing any of this design.** | This document freezes design only. |
| N-2 | **The template automation eligibility policy.** | Explicitly deferred to S17 (§14.5). |
| N-3 | **The template recovery policy.** | Explicitly deferred to S17 (§14.5). |
| N-4 | **Any LEVEL 2 provider capability.** | No provider reaches LEVEL 2 (`PROVIDER_DISPATCH_GROUND_TRUTH.md`). Not achievable here. |
| N-5 | **Reliable post-crash message identity for ChatGPT.** | Structurally impossible at LEVEL 0 (§16.3). |
| N-6 | **Any cross-provider message ordering or global timeline.** | Explicitly forbidden by I-7. |
| N-7 | **Automatic resolution of `both-advanced`.** | Explicitly forbidden by I-8. |
| N-8 | **Any second dispatch path.** | Explicitly forbidden by I-15. |
| N-9 | **Changing OpenCode discovery/creation capabilities.** | Protected ground truth, I-16. |
| N-10 | **Changing `Attempt` frozen authority.** | Frozen as exactly `(sessionPairId, workerSessionId, externalSessionId)`. |
| N-11 | **Introducing `execution_epoch`.** | Explicitly rejected previously. `frozenAt` remains audit-only. |
| N-12 | **Mutating `Assignment.pairId`.** | Immutable. Continuation across a replacement Pair requires a **new** Assignment with `originAssignmentId` lineage. |
| N-13 | **Making the shared Pair Name authoritative.** | Explicitly forbidden by I-11. |
| N-14 | **Dropping tables or columns in this tranche.** | Additive-only, §10.1 and §17.1. |
| N-15 | **Changing the `assignments` cascade.** | Out of scope; hazard documented at §10.5, decision deferred (U-9). |
| N-16 | **Changing `startPair()` semantics.** | It stays `pair.resume()`. Load & Activate is separate (I-9). |
| N-17 | **Changing manual Pair creation.** | Unchanged, §15.1. |
| N-18 | **Merging `Load & Activate` with `Start Pair`.** | Explicitly forbidden by I-9. |
| N-19 | **Adding a third persisted operational state.** | Explicitly forbidden by I-1. |
| N-20 | **Building the Composer into Pair Detail Rev 2.** | Separate later slice, S14. |
| N-21 | **Using persisted readiness to authorize execution.** | Explicitly forbidden by I-5. |
| N-22 | **Any form of destructive migration.** | Additive-only; Plan-First precedent preserved. |
| N-23 | **Modifying `ef6185b` or its regression gates.** | Preservation baseline, I-16. |
| N-24 | **Fabricating cross-side correspondence.** | Without provider-stable IDs, correspondence is `unverified` (§7.4). |

---

## 20. Genuine unresolved human decisions

`[UNRESOLVED]` These are **not** answerable from the repository and are **not** decided by this document. Each needs a human decision. None may be silently defaulted in implementation.

### U-1 — May Composer ship before exact-session transport exists?

`[FROZEN]` The Composer would be built on frontmost-window delivery (§9.2), which can silently land a message in the wrong conversation. Exact-session transport arrives only at S9, long after the Composer at S14 — but the Composer *follows* S9 in the chain, so the ordering permits shipping it.

**The question:** is the frontmost-window risk acceptable for an operator-only Composer, with the limitation surfaced in the UI, or must exact-session transport be a hard prerequisite? This is a product risk decision, not a technical one. It determines whether the Composer can ever be used in a multi-conversation scenario.

### U-2 — What is the acceptable risk envelope for frontmost delivery generally?

**The question:** does the human accept that an operator message may be delivered to the wrong ChatGPT conversation, with no way to detect it post-hoc at LEVEL 0? If not, frontmost delivery is unusable for anything but supervised, single-conversation operation, which changes what several slices are allowed to claim.

### U-3 — Can New/New creation be built at all given the capability gaps?

`[FROZEN]` §15.2 requires the same Pair Name on both sessions and forbids faked success. But no provider exposes a way to create a session in a specific addressable conversation and prove the name was applied.

**The question:** is New/New creation acceptable as a "create then discover, with unproven naming shown honestly as unproven" flow, or does it require a new provider capability that may not be achievable at LEVEL 0/1? If the latter, S16 may be blocked indefinitely.

### U-4 — What is the retention policy for observations, checkpoints, and provenance?

`[PROPOSED]` §10.3 proposes append-only records with no retention limit, which grows without bound.

**The question:** what retention window applies to each record class, and does expiry conflict with I-13's permanence requirement for provenance? Provenance and observations may warrant very different retention. This is a human decision because it trades audit value against unbounded growth.

### U-5 — What are the template eligibility and recovery criteria?

`[FROZEN]` Explicitly deferred to S17 (§14.5). **No policy is proposed here.** The question is deliberately left open: which templates may be applied automatically, under what preconditions, and how a failed application recovers without violating I-8's no-automatic-copying rule and I-12's genuine-stop rule.

### U-6 — How is the `PairStatus` idle/active overlap resolved?

`[FROZEN]` §17.2 requires the overlap to be resolved explicitly. The question of **retain-as-deprecated-alias vs remove** is undecided. The Plan-First precedent favours retention, but that is an inference, not a decision.

### U-7 — What is the validity window per observation capability?

`[FROZEN]` §5.4 requires a per-capability window but does not set values. The window directly determines how quickly readiness goes stale (I-5) and therefore how aggressive supervision must be. Setting it too short makes readiness useless; too long risks authorizing on stale data — the precise failure I-5 forbids.

### U-8 — Who advances a durable checkpoint?

`[FROZEN]` §6.4 requires checkpoint advancement to be explicit but does not say who may do it.

**The question:** operator only, Load & Activate only, or supervision as well? If supervision auto-advances, `both-advanced` becomes harder to detect, which threatens I-8. This is a genuine tension between observability and automation, and the tradeoff is a human call.

### U-9 — Should the `assignments` cascade be changed to preserve history?

`[FROZEN]` §10.5 documents the hazard; §17.8 defers the decision. The question is whether deleting a Pair should destroy its assignment, attempt, delivery, and handoff history, given that I-10 requires Make Idle to preserve state and that Rev 2 exposes history and provenance surfaces. Deletion remains a legitimate operation; the question is only what it should destroy.

### U-10 — What is the honest minimum verification bar for a "verified" Pair?

`[FROZEN]` §11.3 and §16.3 require per-side honesty, but the product question of what a human should be told when one side is permanently unverifiable is open. Should such a Pair be allowed to dispatch at all, given that I-5 and §8.3 keep readiness separate from execution authority but do not forbid dispatching from an unverified side? This determines whether LEVEL 0 sides are usable for anything but inspection.

---

## Appendix A — Evidence index

`[VERIFIED]` Primary code citations used in this document:

| Fact | Citation |
|---|---|
| `DeliveryInstructionRequest` has no conversation/session target | `src/relay/providers/interfaces.ts:33-37` |
| `IRuntimeProvider` has no message read/edit capability | `src/relay/providers/interfaces.ts:52-82` |
| `responseSummary` declared optional | `src/relay/providers/interfaces.ts:61` |
| ChatGPT frontmost delivery | `src/relay/providers/adapters.ts:1291`, focus at `:1330-1341`, `frontmost` at `:1336`, paste/Return at `:1362-1380` |
| OpenCode frontmost delivery | `src/relay/providers/adapters.ts:2357`, focus at `:2397-2408`, `frontmost` at `:2403`, paste/Return at `:2430-2449` |
| ChatGPT synthesized `responseSummary` | `src/relay/providers/adapters.ts:1473` |
| OpenCode synthesized `responseSummary` | `src/relay/providers/adapters.ts:2585` |
| Three-phase dispatch, external call outside transaction | `src/relay/application/RelayEngine.ts:988-994` |
| OpenCode read-only client, no send method | `src/relay/providers/opencodeSessionClient.ts:350-450` |
| `getTranscript` returns `messageId`/`text`/`role`/`createdAt` | `src/relay/providers/opencodeSessionClient.ts:438` |
| `deliverHandoffToPlanner` makes no provider call yet emits `planner.notified` | `src/relay/application/RelayEngine.ts:1221-1235`, event at `:1228` |
| `planner_assistances` / `planner_action_requests` defined with no writer in `src/` | `src/relay/persistence/sqlite/SqliteDatabase.ts:202`, `:218` |
| `createWorkerSession` has exactly one implementor (OpenCode only) | `src/relay/providers/adapters.ts:3020` |
| `startPair()` is `pair.resume()` plus save and event | `src/relay/application/RelayEngine.ts:1384-1390` |
| `assignments.pair_id` has `ON DELETE CASCADE` to `pairs` | `src/relay/persistence/sqlite/SqliteDatabase.ts:136` |
| `Pair.update/assignWork/clearWork/pause/resume` exist and mutate in place | `src/relay/domain/entities.ts:170`, `:207`, `:213`, `:219`, `:224` |
| `MAX_TEXT_CHARS = 2_000`, `DEFAULT_TRANSCRIPT_LIMIT = 50` | `src/relay/providers/opencodeSessionClient.ts:265`, `:267` |
| `MAX_TEXT_CHARS = 2000`, `DEFAULT_TRANSCRIPT_LIMIT = 50` | `src/relay/providers/opencodeSessionClient.ts` |
| `PairStatus` union | `src/relay/domain/types.ts` |
| `ObservableEvidence` | `src/relay/domain/types.ts` |
| `PRAGMA user_version = 3`, `addColumnIfNeeded` pattern | `src/relay/persistence/sqlite/SqliteDatabase.ts` |
| `SavedBinding` / `DiscoveredIdentity` precedent | `src/components/detailViewModels.ts` |
| Pure-helper UI precedent | `src/components/pairModalConversation.ts` |
| Current pair-centric surface and action set | `src/components/PairView.tsx` |
| LEVEL 0 / LEVEL 1 assignments, no LEVEL 2 | `PROVIDER_DISPATCH_GROUND_TRUTH.md` |
| Replacement requires a new Pair | `SESSION_PAIR_REPLACEMENT.md` |
| In-place update confirmed as current behavior | `AUDIT_REPORT.md` §3 |
| Protected OpenCode discovery/creation contract | `OPENCODE_SESSION_DISCOVERY.md` at `ef6185b6f9d57a21e911dee405dd8f2e81273c3f` |

## Appendix B — Pre-existing working-tree state at time of freeze

`[VERIFIED]` Three files carried pre-existing unstaged modifications, unrelated to this design and preserved untouched:

- `src/components/PairModal.tsx`
- `src/relay/application/RelayApiService.ts`
- `tests/planner_conversation_binding.test.ts`

`[FROZEN]` This document is the **only** file created by this freeze. No production code, schema, test, or UI file is modified. Nothing is staged, committed, or pushed.
