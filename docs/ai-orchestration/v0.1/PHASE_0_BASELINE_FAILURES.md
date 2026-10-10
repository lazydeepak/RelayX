# Phase 0 baseline failures

Baseline `241a4d5`, Linux, Node 24.19.0; `npm test` on 2026-10-09.

1,518 tests: 1,473 passed, 44 failed, one skipped; 330 suites; 54.96 seconds. Dependencies installed with `npm install --package-lock=false`, so this is not a locked-install baseline. These are observed failures, not root-cause classifications. Source locations below come from the test runner and may reference transformed positions.

- `tests/assignment_create_shortcuts.test.ts:1:4104` — existing Create & Dispatch contract remains: submit still calls onCreate with the selected pair
- `tests/bootstrap_idempotency.test.ts:1:4882` — tick 1: exactly one ingress and one Assignment, carrying the exact post-arm text
- `tests/bootstrap_idempotency.test.ts:2:923` — ticks 2 and 3: still exactly one ingress and one Assignment
- `tests/bootstrap_idempotency.test.ts:2:1266` — restart: a NEW engine over the SAME database materialises nothing further
- `tests/bootstrap_idempotency.test.ts:2:2034` — restart after the arm was retired: the retired-arm completion is honoured, exactly once
- `tests/bootstrap_regression.test.ts:1:147` — RelayIngress bootstrap — live pair verification
- `tests/chatgpt_provider.test.ts:1:7692` — opens /projects, enters the project name, Tab x 7 + Return, then reads the URL
- `tests/chatgpt_provider.test.ts:1:10334` — the RelayX project name is pasted into the Projects search, verbatim
- `tests/chatgpt_provider.test.ts:1:11274` — the result-navigation stage performs Tab x 7 then Return
- `tests/chatgpt_provider.test.ts:1:12093` — the Tab count is driven by the configured integration script, not hardcoded
- `tests/chatgpt_provider.test.ts:1:12981` — the final Project URL is captured through the existing URL-reading mechanism
- `tests/chatgpt_provider.test.ts:1:14226` — reports PROJECT_SEARCH_INPUT_FAILED when the Projects search field cannot be focused
- `tests/chatgpt_provider.test.ts:1:14918` — waits on the filtered results settling before walking focus (live-verified)
- `tests/chatgpt_provider.test.ts:1:16028` — reports PROJECT_SEARCH_SUBMIT_FAILED when the filtered results never settle
- `tests/chatgpt_provider.test.ts:1:16844` — reports PROJECT_SEARCH_SUBMIT_FAILED when the search never accepts the project name
- `tests/chatgpt_provider.test.ts:1:17453` — reports PROJECT_RESULT_NAVIGATION_FAILED when the tab+enter keystrokes cannot execute
- `tests/chatgpt_provider.test.ts:1:18174` — reports PROJECT_OPEN_FAILED when Tab x 7 + Return never leaves the Projects route
- `tests/chatgpt_provider.test.ts:1:18776` — reports PROJECT_ID_PARSE_FAILED and binds nothing for a conversation-only URL
- `tests/chatgpt_provider.test.ts:1:20267` — diagnostics report the failed stage without leaking raw script internals
- `tests/chatgpt_provider.test.ts:1:21027` — auto-enables the Chrome JS-from-Apple-Events gate once, then completes discovery
- `tests/chatgpt_provider.test.ts:1:21885` — reports a precise Chrome JS gate diagnostic under the OPEN_PROJECTS_PAGE_FAILED stage
- `tests/chatgpt_provider.test.ts:1:22600` — reports permission-needed when the auto-enable lacks Accessibility access
- `tests/create_and_dispatch_atomic.test.ts:1:6540` — pre-claim refusal keeps the modal open with title/instruction/pair preserved
- `tests/create_and_dispatch_atomic.test.ts:1:9093` — exposes the precise engine operation and the application command at each layer
- `tests/electron_bridge.test.ts:1:1459` — Truthful provider integration status reporting
- `tests/handoff_retry_schedule.test.ts:5:1315` — 1: a definite failure produces NO retry before 10 seconds, across many ticks
- `tests/handoff_retry_schedule.test.ts:5:2127` — 2: the first eligible retry happens at 10 seconds, and re-arms the ladder at 20
- `tests/handoff_retry_schedule.test.ts:5:2677` — 3: the next retry is only eligible after 20 seconds
- `tests/handoff_retry_schedule.test.ts:5:3181` — 4: the next retry is only eligible after 1 minute
- `tests/handoff_retry_schedule.test.ts:5:3722` — 5: the next retry is only eligible after 5 minutes, and exhausting the ladder raises no Attention yet
- `tests/handoff_retry_schedule.test.ts:5:4900` — 6: failure of the 5-minute retry opens exactly one deduplicated Attention item
- `tests/handoff_retry_schedule.test.ts:5:5878` — 7: automation continues and the next retry occurs 30 minutes after the exhausted failure
- `tests/handoff_retry_schedule.test.ts:5:6683` — 8: sustained failures retry every 30 minutes without creating duplicate Attention items
- `tests/handoff_retry_schedule.test.ts:5:7794` — 9: a confirmed delivered Delivery stops retries and resolves the Attention item
- `tests/handoff_retry_schedule.test.ts:5:9020` — 10: an ambiguous Delivery causes zero blind resend and raises Attention immediately
- `tests/handoff_retry_schedule.test.ts:5:11775` — 12: PAUSE prevents scheduled retries, and RUNNING resumes them
- `tests/handoff_retry_schedule.test.ts:5:12890` — 13: Assignment and Handoff stay unique across the entire retry chain
- `tests/handoff_retry_schedule.test.ts:5:14192` — the retry schedule survives a restart, because it is derived from the record
- `tests/handoff_transfer_requires_delivery.test.ts:1:5648` — 2: derived Assignment + failed Delivery => transferred=false, and the existing Assignment is retried
- `tests/handoff_transfer_requires_delivery.test.ts:1:13077` — the failed intent and its reason survive the retry, and reconciliation evidence is not weakened
- `tests/pair_operational_state.test.ts:1:16311` — backfills pre-existing Pairs to IDLE and gives each a stable identity, preserving their rows
- `tests/pair_view_dispatch_modal_flow.test.ts:1:4428` — submit continues through existing governed pipeline (handleCreateAssignment → modal onCreate)
- `tests/planner_session_open_browser.test.ts:1:11495` — the planner Open control is labelled "Open" and carries no project handler prop
- `tests/planner_url_legibility.test.ts:1:2900` — the full URL is still what Open targets — elision never feeds the opener
- `tests/recoveryAuthority.invariant.test.ts:1:718` — assertNoSelectableRecoveryDestination passes for PLANNER and rejects others
