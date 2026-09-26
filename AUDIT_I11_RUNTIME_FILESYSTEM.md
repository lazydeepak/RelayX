# I11 RUNTIME FAILURE VS FILESYSTEM STATE — Verified (commit 9146719)

## 1. What runtime termination currently changes
- Engine.recoverOnStartup() (line 1435-1495) scans active assignments, probes worker runtime, creates Handoff if complete, updates runtime observation if working/available.
- It does NOT terminate, kill, or roll back the external worker session.
- Runtime termination (provider process exit, browser close) is observed as `inspection.found = false`, leading to `recordObservationFailure()` and suspension — not rollback.

## 2. Whether recovery assumes filesystem rollback
- No rollback mechanism exists in engine, service, or persistence.
- MemoryDB has transaction rollback (memory-only), but SQLite persistence has no rollback on recovery.
- Recovery never calls git reset, file deletion, or mutation reversal.

## 3. How partial worker mutations survive runtime loss
- Worker mutations occur in the real shared session (file system, git working tree, external UI).
- RelayX does not control the worker's filesystem; it only observes via provider.inspectRuntime().
- Partial mutations survive because they are external to RelayX; recovery only records observation failure / suspension, not mutation state.
- No mechanism records "expected writes" vs "actual writes" for recovery comparison.

## 4. How repository state is inspected after runtime loss
- recoverOnStartup() uses provider.inspectRuntime() — which returns evidence, window title, pid, isComplete, isWorking.
- No direct repository inspection (no git status, no file listing, no HEAD comparison) inside recovery loop.
- Repository boundary / verification is handled separately (probably in provider or detail view models), not in recovery.

## 5. How exact filesystem state is communicated to Planner or recovery logic
- Inspection.evidence is passed through to Handoff / events (line 1462, 1472).
- No structured filesystem-state message sent to Planner.
- No "repository reality conflicting with documented assumptions" detection in recovery.
- Planner receives structured updates via events / attention items, but filesystem reality is only visible through provider evidence, not explicitly communicated as a structured state message.

CONFIRMED GAP: Recovery assumes external mutation survival (correct), but does not inspect repository state after loss, does not compare actual vs expected writes, and does not communicate filesystem reality to Planner in a structured way.
