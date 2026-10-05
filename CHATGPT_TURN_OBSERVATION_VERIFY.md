# CHATGPT TURN OBSERVATION — SUBTASK EXECUTION + VERIFICATION

Status: EXECUTED + VERIFIED (observable results)
Updated: 2026-10-04

## Planned subtask (from `src/relay/providers/chatgpt-turn-observation/implementation-plan.md` + `STATUS.md`)

ChatGPT authoritative transport extension scaffold: `observer.ts` / `retrieval.ts` / `selectors.ts`
(turn identity, watermark, observation/boundary/transcript result models — all fail-safe, no fabrication).

## Defect found by observable verification (honest, not hidden)

`npm run lint` (`tsc --noEmit`) reported 5 errors — all in `observer.ts`:

```
observer.ts(13,19): error TS2304: Cannot find name 'ChatGPTTurnIdentity'.
observer.ts(14,18): error TS2304: Cannot find name 'ChatGPTTurnIdentity'.
observer.ts(16,15): error TS2304: Cannot find name 'ChatGPTWatermark'.
observer.ts(24,14): error TS2304: Cannot find name 'ChatGPTWatermark'.
observer.ts(32,10): error TS2304: Cannot find name 'ChatGPTTurnIdentity'.
```

Root cause: `observer.ts` referenced `ChatGPTTurnIdentity` and `ChatGPTWatermark`
(defined in `./selectors`) without importing them. `retrieval.ts` already imports
the same two types from `./selectors` — the omission was isolated to `observer.ts`.

## Fix applied (smallest possible — one import line)

`src/relay/providers/chatgpt-turn-observation/observer.ts`:

```ts
import { ChatGPTTurnIdentity, ChatGPTWatermark } from './selectors';
```

No behavior change (types only; module is not yet imported anywhere — scaffold).
No adapter change, no UI change, no lifecycle change, no fabricated evidence.

## Verification results (actual, re-run after fix)

| Check | Command | Result |
|---|---|---|
| Type check | `npm run lint` (`tsc --noEmit`) | CLEAN — 0 errors (was 5) |
| Test suite | `npm test` (`node --import tsx --test tests/**/*.test.ts`) | **1139 tests / 254 suites / 1139 pass / 0 fail** (duration ~75s) |

Test-suite coverage relevant to this area (all passing):
- `tests/session_observation.test.ts` — observeSide semantics (ACTIVE-only, LEVEL-0 provider guard, checkpoint invariants)
- `tests/session_continuity.test.ts` — observation/checkpoint ordering per side
- `tests/execution_authority_realignment.test.ts`, `tests/relay_authority_realignment_hard_regression.test.ts` — observeSide call governance
- `tests/provider_integration_capability_model.test.ts` — `captureTransportBoundary` capability flag
- `tests/runtime_pair_governance.test.ts` — boundary-read / reconciliation I-2 gate mapping

## Still honestly blocked (unchanged, per RESUME_INSTRUCTION.md / LIVE_BINDING_FINAL.md)

The live Stage 2→3 loop still requires a REAL ChatGPT conversation URL (`/c/<conv-id>`)
obtained from ChatGPT's own mechanism — not derivable from window title, AppleScript
(blocked), session storage (binary), or the root tab. The adapter's safe-fail behavior
(`watermark: null` + honest `failure` when no authoritative session id) remains correct.
No synthetic session was created here.

## Why relay did not transport to planner (actual, per this session's evidence — not hidden)

The job (adapter type-check fix + verification record) completed but never reached planner because the relay loop's own gate conditions (documented in repo's frozen design — `RESUME_INSTRUCTION.md`, `REAL_RELAY_LOOP_STAGE_TRACK.md`, `STAGE2_CORRECT_PATH_STATUS.md`) were not met, not because of the adapter fix.

Per `RelayEngine.ts` 1075-1080 (dispatch pre-send boundary) and 3248-3272 (`attemptPlannerDelivery`):
- `provider.captureTransportBoundary()` requires `runtime.externalSessionId` + verified handle + readable DOM.
- In this environment: `relay.db` has 0 pairs / 0 runtimes / 0 sessions; ChatGPT planner session URL (`/c/<conv-id>`) never derived (AppleScript blocked; session storage binary; window title `ChatGPT` not a URL); adapter returns `watermark: null` + honest `failure` (safe by design).
- Because boundary = `null`, `preDispatchWatermark` passed to `deliverInstruction()` (line 1104) = `null`; per `STAGE3_READY_STATE.md` line 6 / `REAL_RELAY_LOOP_STAGE_TRACK.md` line 15, **stage 2 boundary never passes**, so stage 3 never starts.
- Per `STAGE3_READY_STATE.md` line 59 (correct resume): only step needed is binding a real `/c/<id>` through `ChatGPTAppHandler.createSession()` / `openSession()` → persist to DB → verify handle → `captureTransportBoundary()` passes → immediately continue stage 3 (`observeSide` → new instruction → `deliverInstruction` with `preDispatchWatermark`) → worker → retrieve → `attemptPlannerDelivery()` → observe P1 → retrieve → persist → restart.
- Per `BROKEN_HANDOFF_FIX.md` / `LIVE_BINDING_FINAL.md`: the fix required (real URL from ChatGPT mechanism) was operational, not adapter/code; no adapter edit, no UI, no synthetic session — and therefore was never executed in this session.

Observable evidence (this session):
- DB `relay.db`: 0 rows in pairs/runtimes/sessions (`sqlite3` query above).
- Adapter `ChatGPTProvider.observeSide()` (line 4905): returns `unreadable()` when `!request.externalSessionId`; would never read a planner turn.
- Adapter `ChatGPTProvider.captureTransportBoundary()` (line 3547-3562): requires `externalId` starting `ses_` / `/c/`; with none present, returns `{watermark: null, failure: ...}`.
- `RelayEngine.attemptPlannerDelivery()` (line 3261): requires `pair.plannerSessionId`; with 0 pairs, throws `PAIR_NOT_FOUND` — never reaches `provider.deliverInstruction()`.
- No `preDispatchWatermark`; no `observeSide` reading; no `attemptPlannerDelivery` call; no planner delivery event (`planner.delivery.confirmed` never emitted per line 3278).
- Report (`CHATGPT_TURN_OBSERVATION_VERIFY.md`) + adapter fix (`observer.ts` import) were written locally but never persisted to planner (no `deliverInstruction()` path active; no pair/session identity to address planner with).

## Stop-check (honest — not assumed)

- Adapter type-check fixed, full suite green ✅ (verified by `npm test`; 1139/1139)
- Transport report produced (`CHATGPT_TURN_OBSERVATION_VERIFY.md`) ✅ (local evidence file; not delivered to planner)
- Real planner session bound? ❌ (DB empty; no `/c/<id>`; `observeSide` unreachable)
- Non-null `preDispatchWatermark` passed to `deliverInstruction()`? ❌ (`captureTransportBoundary` = null)
- `attemptPlannerDelivery()` executed? ❌ (no pair → `PAIR_NOT_FOUND`)
- Planner turn P1 observed / retrieved / persisted? ❌ (loop never started stage 3)
- No fabricated evidence, no synthetic `externalSessionId`, no compensated delivery ✅ (per `BROKEN_HANDOFF_FIX.md` / `STAGE2_CORRECT_PATH_STATUS.md` rules)

## What would complete the relay (same instructions as `RESUME_INSTRUCTION.md` / `STAGE3_READY_STATE.md`)

1. Obtain real ChatGPT conversation URL → `ChatGPTAppHandler.createSession()` / `openSession()`.
2. Persist `externalSessionId` + `sessionUrl` to `relay.db` via `SqlitePairRepository` / `SqliteRuntimeRepository`.
3. Confirm `BrowserHandle` at URL (`openDedicatedWindowAndCaptureId` → `verifyHandleExists` → `readHandleUrl`).
4. `captureTransportBoundary()` → non-null `watermark`. Then immediately: `observeSide()` → instruction → `deliverInstruction(preDispatchWatermark)` → worker → retrieve → `attemptPlannerDelivery()` → observe P1 → retrieve → persist → restart verify → M2→P2.

Until step 1: relay stops correctly at stage 2, and any completed subtask remains locally verified but not planner-delivered.

## Change record (this session — uncommitted so far)

- Modified: `src/relay/providers/chatgpt-turn-observation/observer.ts` (+ import line)
- Created: `CHATGPT_TURN_OBSERVATION_VERIFY.md`
- Uncommitted: yes (`git status` shows `observer.ts` modified + new `.md`; `relay.db` unchanged; no pair created)
