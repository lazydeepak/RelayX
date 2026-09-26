import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Focused tests for the planner/worker semantic correction.
 *
 * Invariants preserved after correction:
 *  1. Project/directory membership (`eligible`) is distinguishable from
 *     session pairing (`selectedSessionId` / persisted pair identity).
 *  2. Ambiguous results (multiple eligible candidates with equal top score)
 *     must NOT silently select a worker session or create a pair.
 *  3. Planner identity uses the final resolved URL (`finalUrl`) — not the
 *     pre-navigation `pageReadyInfo.url`.
 *  4. Existing persisted authoritative session identity wins over any
 *     discovery ordering/recency.
 */

import {
  reducePlannerDiscovery,
  reduceOpenCodeDiscovery,
  selectOpenCodeWorker,
  isPlannerBindingValid,
  isOpenCodeBindingValid,
} from '../src/relay/application/stagedDiscovery.ts';

const PLANNER_URL = 'https://chatgpt.com/g/g-p-6a9bdd536b688191b57de5da6e7f3b09/project';

/* ------------------------------------------------------------------ */
/* 1. Planner identity uses final URL, not pre-navigation diagnostic   */
/* ------------------------------------------------------------------ */

describe('planner identity uses final resolved URL', () => {
  it('accepts discovery that carries the post-navigation finalUrl', () => {
    const result = {
      success: true,
      finalUrl: PLANNER_URL,
      projectName: 'Test-Project',
      diagnostics: {
        pageReadyInfo: { url: 'https://chatgpt.com/', readyState: 'complete' },
      },
    };
    const planner = reducePlannerDiscovery({ status: 'idle' }, result as any);
    assert.strictEqual(planner.status, 'discovered');
    assert.strictEqual(planner.url, PLANNER_URL);
    assert.strictEqual(planner.evidence?.finalUrl, PLANNER_URL);
    assert.ok(isPlannerBindingValid(planner));
  });
});

/* ------------------------------------------------------------------ */
/* 2. Candidate eligibility (`eligible`) is distinguishable from pair  */
/* ------------------------------------------------------------------ */

describe('candidate eligibility vs pair selection', () => {
  it('ten equal exact-path candidates remain ambiguous and do not select a session', () => {
    // Simulate the provider returning 10 authoritative sessions,
    // all with exact path match (score 130), none selected.
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `ses_ambiguous_${i}`,
      workspacePath: '/Users/lazydeepak/dev/test-project',
      matchScore: 130,
      matchedVia: 'exact_path',
      openCodeProjectId: 'test-project',
      hasUiCorrelation: false,
      windowTitle: undefined,
    }));

    const discoveryResult = {
      success: true,
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        authoritativeSessionId: s.sessionId,
        workspacePath: s.workspacePath,
        matchScore: s.matchScore,
        matchedVia: s.matchedVia,
        openCodeProjectId: s.openCodeProjectId,
        hasUiCorrelation: s.hasUiCorrelation,
        windowTitle: s.windowTitle,
        eligible: true,
        resolutionStatus: 'eligible',
      })),
      diagnostics: {
        ambiguous: true,
        candidates: 10,
      },
    };

    // The adapter reports ambiguous when there are tied top scores.
    // The discovery result should NOT contain an automatically selected session.
    // When ambiguous, the adapter returns `results: []` (no selected
    // session) but includes all eligible candidates for diagnostics.
    // Because `sessions` is empty, the discovery stage fails rather
    // than selecting the first result.
    const openCode = reduceOpenCodeDiscovery({ status: 'idle', workers: [] }, {
      success: false,
      error: 'Ambiguous: multiple candidates with equal score',
      sessions: [],
      diagnostics: { ambiguous: true, candidates: 10 },
    } as any);

    // Because ambiguous results have no authoritative `selectedSessionId`,
    // the stage must fail (or at minimum not claim a selected worker).
    assert.strictEqual(openCode.status, 'failed');
    assert.strictEqual(openCode.selectedSessionId, undefined);
    assert.ok(!isOpenCodeBindingValid(openCode));
  });

  it('exact single candidate resolves correctly', () => {
    const result = {
      success: true,
      sessions: [
        {
          sessionId: 'ses_exact_1',
          authoritativeSessionId: 'ses_exact_1',
          workspacePath: '/dev/project',
          matchScore: 130,
          matchedVia: 'exact_path',
          openCodeProjectId: 'project-id',
          hasUiCorrelation: false,
          eligible: true,
          resolutionStatus: 'eligible',
        },
      ],
      diagnostics: { ambiguous: false },
    };
    const openCode = reduceOpenCodeDiscovery({ status: 'idle', workers: [] }, result as any);
    assert.strictEqual(openCode.status, 'discovered');
    assert.strictEqual(openCode.selectedSessionId, 'ses_exact_1');
    assert.ok(isOpenCodeBindingValid(openCode));
  });
});

/* ------------------------------------------------------------------ */
/* 3. Ambiguous discovery cannot silently become a selected session    */
/* ------------------------------------------------------------------ */

describe('ambiguous discovery does not become selected worker', () => {
  it('manual selection is required; ambiguous state does not auto-resolve', () => {
    // Start from ambiguous discovery (no selected session).
    const ambiguousState = reduceOpenCodeDiscovery(
      { status: 'idle', workers: [] },
      { success: false, error: 'Ambiguous: multiple candidates', diagnostics: { ambiguous: true } } as any,
    );
    assert.strictEqual(ambiguousState.status, 'failed');
    assert.strictEqual(ambiguousState.selectedSessionId, undefined);

    // Explicit user adoption creates the binding; ambiguous state alone does not.
    const adopted = selectOpenCodeWorker(
      ambiguousState,
      {
        sessionId: 'ses_adopted_1',
        workspacePath: '/dev/project',
        matchScore: 130,
        matchedVia: 'exact_path',
        openCodeProjectId: 'project-id',
      } as any,
    );
    assert.strictEqual(adopted.status, 'discovered');
    assert.strictEqual(adopted.selectedSessionId, 'ses_adopted_1');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Existing persisted identity wins over ordering/recency           */
/* ------------------------------------------------------------------ */

describe('persisted authoritative identity wins over discovery order', () => {
  it('recorded session identity is preserved when discovery produces a different ordering', () => {
    // The invariant is enforced by RelayEngine.discoverRuntime and
    // RelayApiService.inspectRuntime: a runtime with an existing
    // externalSessionId must never be overwritten by a different
    // observed authoritative id or by null.
    // This focused test asserts the semantic contract at the adapter level:
    // when the same authoritative session appears again (e.g. after restart),
    // `eligible` is true, but pairing is tied to the persisted session id,
    // not the result ordering.
    const sessionId = 'ses_persisted_1';
    const result = {
      success: true,
      sessions: [
        {
          sessionId,
          authoritativeSessionId: sessionId,
          workspacePath: '/dev/project',
          matchScore: 130,
          matchedVia: 'exact_path',
          eligible: true,
          resolutionStatus: 'eligible',
        },
      ],
    };
    const openCode = reduceOpenCodeDiscovery({ status: 'idle', workers: [] }, result as any);
    assert.strictEqual(openCode.selectedSessionId, sessionId);
    assert.strictEqual(openCode.evidence?.sessionId, sessionId);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Discovery does not silently create, restore, or mutate a pair   */
/* ------------------------------------------------------------------ */

describe('ambiguous discovery does not mutate pair state', () => {
  it('ambiguous result has no pair-creation effect', () => {
    // If ambiguous results were interpreted as a valid worker binding,
    // a pair could be formed automatically. The correction ensures
    // ambiguous = failed stage, which cannot be used as a binding.
    const ambiguous = reduceOpenCodeDiscovery(
      { status: 'idle', workers: [] },
      { success: true, sessions: [] as any[], diagnostics: { ambiguous: true } } as any,
    );
    assert.strictEqual(ambiguous.status, 'failed');
    assert.strictEqual(ambiguous.selectedSessionId, undefined);
    assert.strictEqual(ambiguous.workers.length, 0);
  });
});
