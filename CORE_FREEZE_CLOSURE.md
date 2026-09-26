# Core Freeze Closure — Final Adversarial Resolution
Status: Domain decisions closed; one provider-ground-truth dependency remains; implementation BLOCKED until resolved.
No source / DB / provider / Plan-First modifications.

---

## 1. Assignment ↔ Session Pair Continuity (Model A — revised precise)

### Decision: CONFIRMED (Model A with explicit lineage transition)

**Model A frozen:** `Assignment.pairId` is immutable origin/current execution Pair reference.

### Continuous transition (exact identities — worker-only replacement example)

```text
old Assignment id: A-001
  → pairId: P1-001 (immutable, historical)
  → activeAttemptId: A1-001 (under P1)

old Pair id: P1-001 (planner = P-planner, worker = W1; preserved after replacement)
old Attempt id: A1-001 (sessionPairId = P1-001, workerSessionId = W1-id, externalSessionId = W1-ext)

replacement Pair created: P2-001 (planner = P-planner-2, worker = W2; new Pair, not mutation of P1)

if objective continues after replacement:
  new Assignment id: A-002 (pairId = P2-001, originAssignmentId = A-001)
  new Attempt id: A2-001 (sessionPairId = P2-001, workerSessionId = W2-id, externalSessionId = W2-ext)
  old Assignment A-001 stays with P1-001 + A1-001 (historical preserved)

authority after replacement:
  A-002 / A2-001 frozen to P2-001 / W2-id / W2-ext (not P1, not A1)

history preserved:
  A-001 + P1-001 + A1-001 preserved independently;
  A-002 references A-001 via originAssignmentId (lineage, not identity replacement);
  no silent mutation of A-001.pairId
```

### Tested scenarios (all consistent with frozen rule)

| Scenario | old Assignment | old Pair | new Pair | new Assignment | new Attempt | Authority |
|---|---|---|---|---|---|---|
| Worker only replaced (P1→P2) | A-001 (P1) preserved | P1 preserved; P2 created | P2-002 | A-002 (P2) if adopted | A2-001 | P2 / W2 / W2-ext |
| Planner only replaced (P1→P2) | A-001 (P1) preserved | P1 preserved; P2 created | P2-003 | A-002 (P2) if adopted | A2-002 | P2 / W1 / W1-ext |
| Both replaced | A-001 (P1) preserved | P1 preserved; P2 created | P2-004 | A-002 (P2) if adopted | A2-003 | P2 / W2 / W2-ext |
| Attempt running when P2 created | A-001 (P1); A1-001 running | P1 active; P2 created | P2-005 | None yet (adoption required) | None yet | A1-001 frozen to P1/W1 |
| Attempt interrupted; continues via P2 | A-001 (P1); A1-001 interrupted | P1 preserved; P2 created | P2-006 | A-002 (P2) if adopted | A2-004 | P2 / W2 / W2-ext |
| Old P1 becomes available again | A-001 stays with P1; A1-001 preserved | P1 archived/unarchived available | — | None needed (historical) | — | Historical only |
| Brand-new objective after replace | — | — | P2-007 (current) | A-003 (P2) new | A3-001 | P2 / W2 / W2-ext |

### What "explicit adoption" precisely means

Not a bridge word. It is either:
- **New Assignment A-002 under P2** (recommended; preserves A-001 identity; lineage via `originAssignmentId`), OR
- **Explicit audited update** of A-001.pairId to P2 with full evidence and transition log (not recommended; violates historical identity; requires mutable `pairId` which conflicts with immutable design).

Given `Assignment.pairId` is immutable in entity (current design) and architecture requires historical preservation, **only Option B (new Assignment with lineage) is consistent**.

### Why Model A survives this challenge
- Durable objective identity = assignment ID + lineage reference (not forced mutation of pair reference).
- Historical execution truth preserved (old Pair + old Attempt untouched).
- Replacement authority is explicit (new Attempt under new Pair).
- No second mutable Pair authority pointer introduced.

---

## 2. External Provider Identity Freeze — Minimal Authority Tuple

### Decision: CONFIRMED (with exact tuple defined)

### Minimal exact authority tuple for Attempt (no extra fields)

```
(sessionPairId, workerSessionId, externalSessionId)
```

### Why each component is necessary / sufficient

| Component | Frozen? | Why required / not required |
|---|---|---|
| `sessionPairId` | CONFIRMED | Pair `id` is immutable history-bearing identity; execution must be tied to exact Pair |
| `workerSessionId` | CONFIRMED | Internal RuntimeSession `id`; immutable at record creation; distinguishes attempts |
| `externalSessionId` | CONFIRMED (REVISED — ADD) | RuntimeSession `updateExternalIdentity()` mutable (368-375); same `id` can point to new ChatGPT/OpenCode session; must freeze snapshot |
| `providerType` | REJECTED | Readonly on RuntimeSession (261); never changes for record; redundant with `workerSessionId` |
| `externalProjectRef` / workspace | REJECTED for authority | Repository execution boundary (§11); pairing verifies workspace but execution authority depends on session identity, not workspace |

### Provider-scope uniqueness
- `externalSessionId` is provider-scoped (ChatGPT conversation ID is OpenAI-scoped; OpenCode session ID is workspace-scoped via `externalSessionId`).
- Two different providers could theoretically generate same external ID format; `providerType` + `externalSessionId` together are unambiguous, but since `providerType` is record-immutable, including it in tuple is redundant — however comparing `externalSessionId` alone is sufficient if the record's `providerType` is also verified (but it's impossible for it to change, so equality of `id` + `externalSessionId` is sufficient without explicit `providerType` comparison).
- For defensive parsing: compare `providerType` implicitly via `workerSessionId` lookup.

### Can `externalSessionId` be reused / recreated?
- Yes: a ChatGPT conversation can be recreated with same URL slug but different internal conversation ID; OpenCode session can be adopted/recycled.
- Frozen snapshot distinguishes old from new.

### Can RuntimeSession adoption overwrite external identity?
- Yes: `updateExternalIdentity()`, `adoptOpenCodeSession()`, `finalizeProjectSetup()` all bind or rebind.
- Frozen snapshot on Attempt prevents overwritten identity from advancing old attempt.

### Minimal tuple conclusion
Exactly 3 fields: `sessionPairId`, `workerSessionId`, `externalSessionId`. No more, no less.

---

## 3. Blocker Classification — Corrected

| Reported blocker | Actual classification | Evidence / Reason |
|---|---|---|
| Pair mutation fix | IMPLEMENTATION_REQUIRED | Design resolved (new Pair; old preserved); needs engine transition (replace `updatePair` mutation with creation) |
| `externalSessionId` freeze | RESOLVED_DECISION | Freeze defined; needs Attempt entity/property addition (implementation, not design) |
| `frozenAt` demotion | RESOLVED_DECISION | Design fully specified (audit-only; removed from validation) |
| `execution_epoch` exclusion | RESOLVED_DECISION | Rejected after 9-case adversarial test; no reopening needed |
| `pairId` guard / immutable enforcement | IMPLEMENTATION_REQUIRED | Already `readonly` in entity; needs DB/transition guard and adoption protocol enforcement |
| Dispatch correlation mechanism | REQUIRES_PROVIDER_GROUND_TRUTH | Section 10 explicitly unfrozen; provider-specific external correlation must be established (message marker / session identity / fingerprint / UI evidence) before `recordDispatchIntent()` / `confirmDispatch()` can be fully specified |

### What truly prevents implementation from starting?

Not the resolved design decisions (`frozenAt`, `execution_epoch`, `externalSessionId` freeze, `pairId` immutability concept).

The actual remaining gates:
1. **Provider ground truth for dispatch correlation** (REQUIRES_PROVIDER_GROUND_TRUTH) — blocks dispatch-intent lifecycle design.
2. **Pair mutation elimination** (IMPLEMENTATION_REQUIRED) — must fix `updatePair` / create replacement before any Attempt authority can work correctly.

If (1) is resolved (provider-specific correlation mechanism chosen) and (2) is implemented, Core can proceed.

---

## 4. Dispatch Transaction — Preserved Finding (Not Softened)

### Architectural finding — preserved exactly

> External UI side effect occurs inside a local DB transaction boundary, creating a crash/reconciliation gap.

### Evidence from audited code (`RelayEngine.ts`, line 953–997)

```text
delivery.startDelivering();
await this.repos.deliveries.save(delivery);        // 964: durable DB persistence
assignment.attachDelivery(delivery);
await this.repos.assignments.save(assignment);    // 965
await this.emitEvent(...);                        // 967

// External execution begins here (976):
const result = await provider.deliverInstruction({ ... });

// If crash between 976 (external send succeeds) and 985 (DB result saved):
// → external worker received prompt
// → DB record still shows 'delivering' (or rolls back if transaction span includes 976-985)
// → recovery must reconcile durable dispatch intent vs observable worker evidence
```

### Actual mechanism
- `save()` at 964/965 persists durable dispatch intent (`startDelivering` + idempotency key).
- `provider.deliverInstruction()` at 976 is external UI/side-effect.
- If the repository implementation uses a transaction spanning sequential awaits, the external call could occur inside the DB transaction boundary; whether it does or not, the critical gap is that **external outcome and DB confirmation are separate realities with no guaranteed atomic reconciliation**.
- The architecture requires persistent dispatch intent + reconciliation after restart (section 10), not assumption that DB state equals external reality.

### What must change (design, not transaction fixing)
- `recordDispatchIntent()` must persist durable intent independently of external send.
- `confirmDispatch()` / `markDispatchUncertain()` must record outcome separately.
- Recovery must compare durable intent against external correlation evidence (provider ground truth), not assume DB record is true.

---

## 5. Final Status

| Topic | Final status | Final rule / remaining evidence |
|---|---|---|
| Assignment↔Pair continuity | CLOSED | Model A frozen: `pairId` immutable; continuation = explicit new Assignment A-002 under P2-001 with `originAssignmentId = A-001`; old Pair / old Attempt preserved independently; no "adoption" ambiguity |
| Attempt authority tuple | CLOSED | `(sessionPairId, workerSessionId, externalSessionId)` — exactly 3 fields; `providerType` and workspace excluded; `frozenAt` excluded from validation |
| external provider identity | CLOSED | `externalSessionId` frozen at dispatch; RuntimeSession can update (368-375), adopt (adoptOpenCodeSession), archive/unarchive; frozen snapshot prevents stale authority |
| execution_epoch | CLOSED | REJECTED after 9 cases; Pair mutation (case 3) is Pair-level failure, not missing epoch; identity comparison sufficient |
| frozenAt | CLOSED | REVISED — audit/metadata only; removed from authority validation |
| dispatch transaction problem | CLOSED (design preserved) | Architectural finding preserved: external `deliverInstruction` occurs after durable DB save; crash between send and DB confirmation creates uncertain state; requires durable-intent reconciliation (provider ground truth required to specify mechanism) |
| dispatch correlation | OPEN — REQUIRES_PROVIDER_GROUND_TRUTH | Section 10 explicitly unfrozen; mechanism (message marker / session identity / fingerprint / observable UI evidence) must be established from provider ground truth before `recordDispatchIntent()` / `confirmDispatch()` can be fully designed |

### Final statement

**CORE FREEZE OPEN — provider ground truth required first.**

All domain decisions in the freeze are resolved and consistent. The only open item is the external correlation mechanism for dispatch reconciliation (section 10). Once that mechanism is established from provider ground truth (ChatGPT / OpenCode / adapter reality), the remaining design work (Attempt lifecycle API names, DB mapping, transition guards) can proceed without further domain ambiguity.

Implementation must not begin until:
- Pair mutation is eliminated (engine/design change)
- `externalSessionId` freeze is implemented (entity/property addition)
- Dispatch correlation mechanism is selected (provider ground truth)

No Plan-First, no SQLite migrations, no source changes made in any tranche.
