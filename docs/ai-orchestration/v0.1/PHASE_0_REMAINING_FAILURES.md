# Phase 0 remaining failures after repairs

2026-10-09, Linux cloud, Node 24.19.0, clean `npm ci`.

## Current checkpoint

After the discovery fixture, priority contract and Planner Open repairs, the full run reports 1,521 passed, zero test-case failures, one skipped (1,522 tests, 113.38 seconds). The command exits 1 because the historical `bootstrap_regression.test.ts` suite cannot initialize its hardcoded Mac database (`ERR_SQLITE_ERROR`, unable to open database file). It remains unchanged and unexecuted. Build/TypeScript pass; focused UI contracts 104/104 and separately invoked rendered UI invariants 10/10 pass.

## Previous checkpoint inventory

Full suite: 1,522 tests, 1,497 passed, 24 failed, one skipped; 330 suites; 47.58 seconds. The failures remain unmodified. This inventory includes the environment-bound historical Mac database suite. It is not a claim that every remaining failure is environment-specific.

- `tests/assignment_create_shortcuts.test.ts:1:4104` — existing Create & Dispatch contract remains: submit still calls onCreate with the selected pair
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
- `tests/pair_view_dispatch_modal_flow.test.ts:1:4428` — submit continues through existing governed pipeline (handleCreateAssignment → modal onCreate)
- `tests/planner_session_open_browser.test.ts:1:11495` — the planner Open control is labelled "Open" and carries no project handler prop
- `tests/planner_url_legibility.test.ts:1:2900` — the full URL is still what Open targets — elision never feeds the opener
- `tests/recoveryAuthority.invariant.test.ts:1:718` — assertNoSelectableRecoveryDestination passes for PLANNER and rejects others

Next investigation: ChatGPT project discovery fixture/production script mismatch, then UI contract assertions and provider integration status. Keep source assertions distinct from behavioral evidence and preserve the Planner-first guard.
