# RelayX Read-Only Audit — Project / Pair / Session Relationship

**Verified absolute repo path:** `/Users/lazydeepak/dev/RelayX`
**HEAD commit:** `9146719385c165a7bc30b5d0d14fee6378ca7ca2` (`fix(project-detail): saved-vs-discovered binding identity + verification + badge contrast`)
**`git status --short`:** empty (clean working tree)
**No mutations performed:** no edits, no staging, no commits, no DB writes, no pair changes.

---

## 1. Current Relationship Map (with file:line evidence)

### Entities
- **Project** (`src/relay/domain/entities.ts:36-109`): `id`, `name`, `canonicalPath`, `gitRoot`, `plannerProjectUrl` (optional), `workerWorkspacePath` (optional), `status`, `createdAt`, `updatedAt`.
- **Pair** (`src/relay/domain/entities.ts:112-231`): `id`, `projectId` (immutable), `name`, `plannerSessionId` (optional `RuntimeSessionId`), `workerSessionId` (optional `RuntimeSessionId`), `activeAssignmentId` (optional `AssignmentId`), `status`, `lastSupervisedAt`, `createdAt`, `updatedAt`.
- **RuntimeSession** (`src/relay/domain/entities.ts:233-385`): `id`, `providerType`, `name`, `status`, `externalSessionId`, `externalProjectRef`, `lastEvidence`, etc.
- **Assignment** (`src/relay/domain/entities.ts:636-742`): `id`, `pairId` (immutable), `projectId`, `title`, `instruction`, `status`, `currentAttemptId`, `activeDeliveryId`, `activeHandoffId`, `completedAt`.
- **Attempt** (`entities.ts:573-634`), **Delivery** (`387-492`), **Handoff** (`494-571`), **RelayEvent** (`744-806`), **AttentionItem** (`808-888`).

### Schema (`src/relay/persistence/sqlite/SqliteDatabase.ts:59-282`)
- `projects(id, ..., planner_project_url, worker_workspace_path, ...)`
- `pairs(id, project_id REFERENCES projects(id) ON DELETE CASCADE, planner_session_id REFERENCES runtime_sessions(id), worker_session_id REFERENCES runtime_sessions(id), active_assignment_id, ...)`
- `assignments(id, pair_id REFERENCES pairs(id) ON DELETE CASCADE, project_id REFERENCES projects(id) ON DELETE CASCADE, ...)`
- Triggers (`SqliteDatabase.ts:267-279`): on `runtime_sessions` delete, set `pairs.planner_session_id = NULL` and `pairs.worker_session_id = NULL`.
- Unique partial index (`SqliteDatabase.ts:224`): `CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_extern ON runtime_sessions(provider_type, external_session_id) WHERE external_session_id IS NOT NULL;`
- No DB-level unique constraint on `(pair_id, session_id)`; pairing uniqueness is enforced in code (`RelayEngine.createPair()` checks `alreadyPaired`).

### Service & Engine
- **RelayEngine** (`src/relay/application/RelayEngine.ts`): manages entities via repositories.
  - `createPair()` (line 358-408): creates new `Pair` record. Guards: session must not already be bound to an active non-archived pair (`alreadyPaired` check, lines 370-388).
  - `updatePair()` (line 410-474): updates the **same** `Pair` record (`pair.update(...)`). Throws `ACTIVE_WORK_GUARD` if `pair.activeAssignmentId` exists (line 417-422). Emits `pair.updated`, `runtime.replaced` / `runtime.attached`, `runtime.detached` events.
  - `rebindPairPlanner()` / `rebindPairWorker()` (lines 476-488): delegate to `updatePair()`.
  - `createAssignment()` (line 747-765): creates `Assignment` linked to `pairId` and `pair.projectId`.
  - `deletePair()` (line 581-600): deletes pair; `ON DELETE CASCADE` deletes its assignments, attempts, deliveries, handoffs.
- **RelayApiService** (`src/relay/application/RelayApiService.ts`): service-layer wrapper.
  - `createPair()` (line 329-453): performs cross-project pairing guards using `project.plannerProjectUrl` and `project.workerWorkspacePath` (see section 2). Writes `planner.externalSessionId` / `externalProjectRef` in a transaction only after pair creation succeeds.
  - `updatePair()` (line 455-467): delegates to engine `updatePair()`; does NOT create a new pair.
  - `finalizeProjectSetup()` (line 1524-1616): creates `Project`, writes `plannerProjectUrl` / `workerWorkspacePath` into the project (`project.update()` at line 1556), registers planner/worker runtimes with `updateExternalIdentity()` (lines 1569-1600), then creates a default pair (`engine.createPair()` line 1605).
  - `enumerateChatGPTConversations()` (line 1157-1235): uses `normalizeChatProjectSlug(proj.plannerProjectUrl ?? null)` (line 1162) to scope conversation registry.
  - `enumerateWorkerChoices()` (line 1237-1319): uses `normalizeWorkerProjectPath(proj.workerWorkspacePath ?? null)` (line 1245) and `proj.canonicalPath` (line 1278) to filter registered/discovered worker runtimes.
- **Providers / Adapters** (`src/relay/providers/adapters.ts`, `browserProviders.ts`): `parseChatGPTConversationUrl()`, `normalizeChatProjectSlug()`, `normalizeWorkerProjectPath()`.

### UI / Pair Interaction
- **Project Detail UI** (`src/components/ProjectDetailModal.tsx`, `src/components/detailViewModels.ts`): displays saved bindings (`project.plannerProjectUrl`, `project.workerWorkspacePath`) as authoritative references (`SavedBindingValue` at line 92-102), compares against latest discovered session identity (`buildVerification` at line 728-846), and shows verification badges (`verified`, `mismatch`, `unverified`, `stale`, `ambiguous`, `unavailable`).
- **Pair creation UI contract** (`src/components/pairModalConversation.ts`, lines 1-158): user pastes explicit `plannerConversationUrl`; `buildCreatePairArgs()` forwards it to `relayBridge.createPair()`.
- **Bridge** (`src/services/relayBridge.ts`, lines 36-443): exposes `createPair`, `updatePair`, `rebindPairPlanner`, `rebindPairWorker`, `detachPairRuntime`. No method creates a new pair on session replacement.

---

## 2. Every Path That Treats Either Project Field as Binding Authority

### `plannerProjectUrl` (project-level planner URL)
- **`RelayApiService.createPair()` (line 377)**: `normalizeChatRef(proj.plannerProjectUrl ?? null)` is the project slug used to validate a user-supplied `plannerConversationUrl`. If `projectSlug` is empty, throws (line 378-380). If parsed conversation `projectId` does not match `projectSlug`, throws `Cross-project pairing` (line 381-383).
- **`RelayApiService.createPair()` (line 407-415)**: when no verified `conversationBinding` exists (i.e., no `plannerConversationUrl` provided), the code checks `planner.externalProjectRef` against `proj.plannerProjectUrl`. If either is missing (`!planner.externalProjectRef || !proj.plannerProjectUrl`), throws `Cross-project pairing: planner project ownership cannot be proven` (line 408-410). If normalized refs differ, throws `Cross-project pairing: planner session belongs to different ChatGPT project` (line 413-415).
- **`finalizeProjectSetup()` (line 1556)**: writes `plannerUrl` (trimmed `setup.plannerUrl`) back into `project.update()` as `plannerProjectUrl`, making it the persistent saved binding.
- **`enumerateChatGPTConversations()` (line 1162)**: `normalizeChatProjectSlug(proj.plannerProjectUrl ?? null)` defines the registry scope for all conversation choices returned by the service.
- **`detailViewModels.buildSavedBinding()` (line 428-436)**: reads `project.plannerProjectUrl` as the first-priority saved planner binding (`source: 'project'`).
- **`detailViewModels.buildVerification()` (line 728-846)**: compares discovered planner identity against `savedBinding` derived from `project.plannerProjectUrl`.

### `workerWorkspacePath` (project-level worker workspace)
- **`RelayApiService.createPair()` (line 418-427)**: when `workerSessionId` provided, checks `worker.externalProjectRef` against `proj.workerWorkspacePath`. If either missing (`!worker.externalProjectRef || !proj.workerWorkspacePath`), throws `Cross-project pairing: worker project ownership cannot be proven` (line 418-420). If normalized paths differ, throws `Cross-project pairing: worker session belongs to different workspace` (line 424-427).
- **`finalizeProjectSetup()` (line 1553-1559)**: writes `setup.canonicalPath?.trim()` into `project.update()` as `workerWorkspacePath` (line 1556).
- **`enumerateWorkerChoices()` (line 1245)**: `normalizeWorkerProjectPath(proj.workerWorkspacePath ?? null)` defines the project workspace filter; registered runtimes with mismatched `externalProjectRef` are excluded (line 1258-1261). Discovery is scoped via `proj.canonicalPath` / `proj.workerWorkspacePath` (lines 1278-1316).
- **`createOpenCodeWorkerSession()` (line 1352-1504)**: uses `proj.workerWorkspacePath ?? proj.canonicalPath ?? null` as the workspace path for session creation (`workspacePath`, line 1357) and verifies created session workspace against it (lines 1475-1484).
- **`adoptOpenCodeSession()` (line 1321-1350)**: checks adopted session workspace against `proj.workerWorkspacePath` (`normalizeWorkerProjectPath`, line 1332).
- **`detailViewModels.buildSavedBinding()` (line 439-447)**: reads `project.workerWorkspacePath` as the first-priority saved worker binding.
- **`detailViewModels.buildVerification()` / `workerBindingVerdict()` (lines 647-705)**: compares discovered worker session identity against saved workspace/session binding derived from `project.workerWorkspacePath`.

### Key inference (not a direct code path, but architectural):
- The comments in `RelayApiService.createPair()` (line 400-404) explicitly call `project.plannerProjectUrl` / `project.workerWorkspacePath` the "stored project ref" used in the "UNVERIFIED LEGACY pairing path". When `conversationBinding` is present (verified URL), the stored ref is not required; when absent, it is mandatory. This confirms the fields are treated as **binding authority** in pairing logic.

---

## 3. Pair Replacement and Assignment-History Behavior (including DB constraints)

### Verified current behavior
- **Replacing a session via the implemented API updates the same pair.**
  - `RelayEngine.updatePair()` (line 410-474) calls `pair.update(...)` (line 436), which mutates `pair.plannerSessionId` or `pair.workerSessionId` in place.
  - `RelayApiService.rebindPairPlanner()` (line 469-471) and `rebindPairWorker()` (line 473-475) delegate to `updatePair()`.
  - No method in `RelayEngine`, `RelayApiService`, `relayBridge`, or `pairModalConversation` creates a new `Pair` record when replacing a planner or worker session.
- **Active assignment guard on replacement.**
  - `RelayEngine.updatePair()` throws `RelayDomainError('ACTIVE_WORK_GUARD', ...)` (line 418-422) if `pair.activeAssignmentId` exists. This means you cannot rebind a planner/worker session while an assignment is active on that pair. You must complete/pause work first (or create a new pair independently).
- **Assignment history stays with the same pair.**
  - `Assignment` has `pairId` (immutable in entity, though DB allows updates via `ON CONFLICT` if manually edited). `createAssignment()` (line 747-765) always uses the current `pair.projectId`.
  - `Pair.clearWork()` (line 212-216) clears `pair.activeAssignmentId` but does NOT delete or archive the assignment. The assignment record remains in `assignments` with its original `pairId`.
  - Deleting a pair (`deletePair()`, line 581-600) triggers `ON DELETE CASCADE` on `assignments(pair_id)`, `attempts`, `deliveries`, `handoffs` (`SqliteDatabase.ts:113-125`, `127-166`). Old assignment history is destroyed when the pair is deleted; it remains intact only while the pair exists.
- **No DB constraint enforcing "new pair on replacement".**
  - There is no trigger or foreign key that creates a new pair when a session is replaced. The only DB triggers (`SqliteDatabase.ts:267-279`) null out session references on runtime deletion.
  - There is no `pair_id` versioning or `pair_replacement` table.

### Inference against target model
- The target model states: "Replacing either selected session creates a new pair; old pairs and assignment history remain intact."
- The verified current behavior contradicts this: `updatePair()` updates the **existing** pair in place; it does not create a new one. If the user expects "new pair on replacement", the current implementation is missing that mechanism entirely. There is no user-facing flow (UI or service method) that creates a replacement pair.
- The assignment-history preservation part is partially satisfied: since the same pair is updated, assignment records stay linked to the same `pair_id`. However, if the user deletes the old pair (e.g., to "replace" it), the cascade deletes all assignments. The target's "old pairs and assignment history remain intact" implies the old pair should survive independently; the current `updatePair()` achieves this by not deleting the old pair, but does not create a new one.

---

## 4. Compatibility Risks for Existing Projects and Pairs

### Verified risks
- **Binding authority coupling:** Any existing project with `plannerProjectUrl` or `workerWorkspacePath` set will have pairing validated against those fields (`createPair()` lines 377-428). If a user updates a project to change its binding (e.g., switches planner project URL) without rebinding the runtime session, pairing will fail with `Cross-project pairing`. Changing the fields requires either updating the runtime's `externalProjectRef` or providing a verified `plannerConversationUrl`.
- **Rebinding blocked by active work:** Existing pairs with active assignments (`pair.activeAssignmentId` set) cannot be rebound (`ACTIVE_WORK_GUARD`). The user must complete or cancel the assignment first. This protects in-flight deliveries but may block urgent session replacement.
- **Pair deletion destroys assignment history:** Since `assignments` has `ON DELETE CASCADE` to `pairs`, deleting a pair permanently removes its assignments, attempts, deliveries, and handoffs. The event history (`events`) remains because it references by `resource_id` with no cascade. If a user deletes an old pair after "replacing" it, all assignment history is lost.
- **No session-to-pair uniqueness at DB level:** The `alreadyPaired` check (`RelayEngine.createPair()` lines 370-388) is code-level only. A direct DB insert could violate it. The partial unique index (`idx_runtime_extern`) applies to runtime sessions, not pair bindings.

### Inference / architectural risk
- **Project fields are permanent provider bindings in practice:** Because `finalizeProjectSetup()` writes them into `Project` and `createPair()` treats them as authoritative, users may interpret `plannerProjectUrl` and `workerWorkspacePath` as permanent bindings. The target model says they are "not permanent provider bindings." Changing this interpretation requires decoupling pairing logic from the project fields, which is a breaking change for any existing project that relies on the current pairing behavior.
- **No audit trail for binding changes:** When `project.update()` changes `plannerProjectUrl` or `workerWorkspacePath`, `RelayEngine.updateProject()` (line 88-101) emits `project.updated` with details `{ name, description }` only (line 98). It does NOT include the changed binding fields in the event details. There is no dedicated event type for binding updates, making it harder to audit when a binding authority changed.

---

## 5. Staged Transition Plan

### Verified vs Inference distinction in plan
- **Verified:** `updatePair()` updates same pair. `createPair()` creates new pair. DB cascade deletes assignments with pair. `finalizeProjectSetup()` writes binding fields.
- **Inferred (required for target model):** Need mechanism for "new pair on session replacement"; need binding fields to not be authoritative; need old pairs preserved independently.

### Smallest safe first implementation slice (no mutation yet; proposal only)

**Slice 0 — Focused tests (read-only, safe to add):**
Create `tests/transition_slice_0_pair_behavior.test.ts` that asserts the verified current behavior. This documents the gap without changing code.
- Assert `updatePair()` keeps the same `pair.id` (line 410-474).
- Assert `createPair()` produces a new `pair.id` with different `projectId` allowed but same session IDs blocked by `alreadyPaired`.
- Assert assignment `pair_id` remains unchanged after `updatePair()`.
- Assert `deletePair()` cascades assignments (`SqliteDatabase.ts` schema).
- Assert `finalizeProjectSetup()` writes `plannerProjectUrl` and `workerWorkspacePath` to `projects` table.

**Slice 1 — Introduce explicit replacement pair creation (code change, no data mutation on existing pairs):**
In `src/relay/application/RelayEngine.ts` (around line 410), add a new service-level method `createReplacementPair(projectId, name, plannerSessionId?, workerSessionId?)` that:
- Creates a **new** `Pair` record (`Pair.create()`) with the selected sessions.
- Does NOT modify the old pair.
- Keeps `ACTIVE_WORK_GUARD` only on the new pair creation if needed (but since it's a new pair, no guard needed unless copying active work, which is out of scope).
In `src/relay/application/RelayApiService.ts` (around line 469), expose `createReplacementPair()` via bridge (`src/services/relayBridge.ts`).
This is the smallest safe slice because it does not alter `updatePair()` or `createPair()` behavior; it only adds an alternative path.

**Slice 2 — Decouple pairing authority from project fields:**
In `RelayApiService.createPair()` (lines 377-428), make the `project.plannerProjectUrl` and `project.workerWorkspacePath` checks optional or remove them when a verified `plannerConversationUrl` or authoritative worker session ID is present. The target model requires these fields to be non-authoritative setup records. The smallest change is:
- Modify the `if (!projectSlug)` guard (line 378) to allow pairing when `conversationBinding` is present (already partially true: the code skips stored-ref checks when `conversationBinding` exists at line 405-428, but the `if (!projectSlug)` at line 378 still throws even with `conversationBinding`).
- Fix the `conversationBinding` path so it does not require `projectSlug` at all (`projectSlug` should only be used for cross-check, not as a hard gate).
- Similarly, for worker pairing, allow pairing based solely on `worker.externalProjectRef` and user selection, without requiring `proj.workerWorkspacePath`.
This slice changes pairing logic but preserves existing pairs; it only affects new pairing attempts.

**Slice 3 — Separate setup bindings from persistent project bindings:**
Modify `finalizeProjectSetup()` (`RelayApiService.ts:1524-1616`) to write binding values to a separate table or temporary record (e.g., `binding_setup`) rather than mutating `Project.plannerProjectUrl` / `Project.workerWorkspacePath`. If a new table is too invasive, the smallest slice is to document the fields as temporary (comments in `entities.ts` and `finalizeProjectSetup()`) and stop using them in pairing logic (Slice 2). The target model explicitly states these fields are not permanent provider bindings.

### Focused tests for the transition
- **Pair replacement invariant (`tests/transition_pair_replacement.test.ts`):**
  1. Create pair P1 with planner A and worker B.
  2. Create assignment A1 on P1.
  3. Create replacement pair P2 (new id) with planner C and worker B (or new worker).
  4. Assert P1.id unchanged; P2.id is new; assignment A1.pairId === P1.id; P1.activeAssignmentId unchanged.
  5. Assert old pair P1 is not deleted; its assignments intact.
- **Binding authority decoupling (`tests/transition_binding_decouple.test.ts`):**
  1. Create project with empty `plannerProjectUrl`.
  2. Call `createPair()` with verified `plannerConversationUrl` and planner runtime with `externalProjectRef`.
  3. Assert pairing succeeds without requiring `project.plannerProjectUrl`.
  4. Assert `project.plannerProjectUrl` remains empty (if decoupled in setup).
- **Assignment history preservation (`tests/transition_history_preservation.test.ts`):**
  1. Create pair, dispatch assignment, complete it.
  2. Create replacement pair.
  3. Assert completed assignment record still references original pair id; original pair record exists; events reference original resources.

---

*Audit completed without editing any source file, staging changes, committing, pushing, restarting apps, sending provider messages, or mutating the live database or pair record.*
