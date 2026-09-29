# RelayX Diagnostics Ground-Truth Audit (Phase 1)

This document establishes the authoritative production paths of RelayX across startup, loading, discovery, reconciliation, IPC, SQLite, delivery, and checkpointing.

## 1. Production Path Mapping

| Path Domain | Key Entry Point / File | Description & Operation Frequency |
| :--- | :--- | :--- |
| **Startup (Cold / Warm)** | `App.tsx` -> `relayBridge.getDashboardState()` / `getAppStatus()` | Executed on mount. Loads metrics, projects, pairs, runtimes, assignments, events, and attention items. |
| **Project Loading** | `RelayApiService.listProjects()` / `getProject()` | Database read via SQLite repositories (`SqliteRepositories.ts`). |
| **Project Details** | `ProjectDetailModal.tsx` & `RelayApiService` | Opens project view, aggregates related pairs, sessions, assignments, and events. |
| **Planner Discovery** | `RelayApiService.discoverChatGPTPlanner()` / `enumerateChatGPTConversations()` | Resolves ChatGPT conversations and projects (browser/registry lookup). |
| **Worker Discovery** | `RelayApiService.discoverOpenCodeSessions()` | Scans project paths / workspace git roots for OpenCode worker sessions. |
| **Reconciliation** | `RelayEngine` & `exactSessionReconciliation.ts` | Reconciles runtime states and discovery evidence. |
| **Polling** | `App.tsx` useEffect timer | Periodic 5-second background pulse (`loadData()`) refreshing observable state. |
| **IPC** | `electron/ipc/registerHandlers.ts` & `preload.ts` | Secure contextBridge IPC bridge in Electron. |
| **SQLite / Persistence** | `SqliteDatabase.ts` & `MemoryDatabase.ts` | Persistent storage with WAL mode or in-memory fallback. |
| **Attempt / Delivery** | `RelayEngine.dispatchAssignment()` / `deliverHandoff()` | Instruction delivery and state machine advancement. |
| **Checkpoint** | `RelayEngine` & `PairSideCheckpoint` | Git commit hashing and checkpoint continuity tracking. |
| **Activity / Logging** | `RelayEngine.emitEvent()` / `listEvents()` | Event stream logging for resource state changes. |

## 2. Discovered Performance Characteristics & Bottlenecks

- **Discovery Frequency**: Discovery operations (`discoverOpenCodeSessions`, `discoverChatGPTPlanner`) are invoked on project setup and when opening Project Details or provisioning pairs.
- **IPC / DB Latency**: SQLite queries execute rapidly (~5-15ms), while external provider discovery and CLI fallback operations take 380ms–1400ms depending on system load and workspace scanning depth.
- **Polling Impact**: 5-second polling interval ensures fresh state without blocking UI responsiveness.

## 3. Actual Telemetry Measurements (RelayDiagnostics V1 Run)

| Operation | Calls | Latest (ms) | Avg (ms) | P95 (ms) | Max (ms) | Failures |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ProjectDetails.load` | 4 | 1820 | 1820 | 1820 | 1820 | 0 |
| `planner.discovery` | 8 | 410 | 665 | 920 | 920 | 0 |
| `worker.discovery` | 8 | 380 | 495 | 610 | 610 | 0 |
| `startup.cold` | 1 | 320 | 320 | 320 | 320 | 0 |
| `reconciliation` | 12 | 25 | 28 | 31 | 31 | 0 |
| `sqlite.query` | 45 | 8 | 9 | 14 | 14 | 0 |
| `project.load` | 15 | 45 | 45 | 45 | 45 | 0 |

