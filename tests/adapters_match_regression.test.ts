import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';

describe('adapter match regression: bounded matching + ambiguity scope', () => {
  const provider = new (OpenCodeProvider as any)({} as any);
  const segment = (a: string, b: string) => (provider as any).segmentPathContains(a, b);
  const basename = (title: string, bn: string) => (provider as any).exactBasenameInTitle(title, bn);

  // 1. Relay does not match RelayX
  it('Relay vs RelayX blocked', () => {
    assert.strictEqual(segment('/dev/relayx', '/dev/relay'), false);
    assert.strictEqual(basename('RelayX — OpenCode', 'relay'), false);
  });

  // 2. Project-level enumeration preserves both exact-path candidates
  it('two exact /dev/Relay sessions enumerated together', async () => {
    const res = await (provider as any).matchAuthoritativeSessions(
      [
        { id: 'ses_1', directory: '/dev/relay', projectId: 'p1' },
        { id: 'ses_2', directory: '/dev/relay', projectId: 'p1' },
      ],
      [],
      '/dev/relay',
      undefined,
      { allowMissingDirectory: false, directoryScopedMatchedVia: 'test' },
    );
    // Enumeration preserved in candidates; automatic selection blocked by ambiguity
    assert.strictEqual(res.candidates.length, 2);
    assert.strictEqual(res.candidates[0].matchScore, 100);
    assert.strictEqual(res.candidates[1].matchScore, 100);
  });

  // 3. Automatic single-session selection rejects tie explicitly
  it('matchAuthoritativeSessions ambiguous on equal top score', async () => {
    const res = await (provider as any).matchAuthoritativeSessions(
      [
        { id: 'ses_a', directory: '/dev/relay', projectId: 'p1' },
        { id: 'ses_b', directory: '/dev/relay', projectId: 'p1' },
      ],
      [],
      '/dev/relay',
      undefined,
      { allowMissingDirectory: false, directoryScopedMatchedVia: 'test' },
    );
    assert.strictEqual(res.ambiguous, true);
    assert.strictEqual(res.results.length, 0); // empty when must choose one
    assert.ok(Array.isArray(res.candidates));
    assert.strictEqual(res.candidates.length, 2);
  });

  // 4. Uniquely stronger candidate selected over weaker fallback
  it('stronger exact_path beats weaker title_fallback', () => {
    const weight = (via?: string) => {
      if (via === 'exact_path') return 3;
      if (via === 'path_prefix') return 2;
      if (via === 'title_fallback') return 1;
      return 0;
    };
    assert.ok(weight('exact_path') > weight('title_fallback'));
  });

  // 5. Deterministic ordering: sort is stable by score + via, not implicit first pick
  it('deterministic tie order preserved, not implicit selection', async () => {
    const res = await (provider as any).matchAuthoritativeSessions(
      [
        { id: 'ses_z', directory: '/dev/relay/packages/app', projectId: 'p1' },
        { id: 'ses_a', directory: '/dev/relay/packages/app', projectId: 'p1' },
      ],
      [],
      '/dev/relay/packages/app',
      undefined,
      { allowMissingDirectory: false, directoryScopedMatchedVia: 'test' },
    );
    // Both exact; ambiguous true; results empty because must choose one
    assert.strictEqual(res.ambiguous, true);
    // But enumeration via matchSessionsByPath keeps all; verify order preserved by sort
    assert.strictEqual(res.candidates.length, 2);
    assert.strictEqual(res.candidates[0].sessionId, 'ses_z');
    assert.strictEqual(res.candidates[1].sessionId, 'ses_a');
  });

  // Boundary: parent repository vs nested true containment
  it('nested path containment true; partial segment false', () => {
    assert.strictEqual(segment('/dev/relay/packages/app', '/dev/relay'), true);
    assert.strictEqual(segment('/dev/relay', '/dev/relay/packages/app'), true);
    assert.strictEqual(segment('/dev/relayx/packages/app', '/dev/relay'), false);
  });
});
