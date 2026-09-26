import { test, describe } from 'node:test';
import assert from 'node:assert';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';

describe('CLI-backed OpenCode provider correction', () => {
  test('createWorkerSession via CLI returns ses_* with directory', async () => {
    const provider = new OpenCodeProvider();
    const result = await provider.createWorkerSession('/tmp/relay-test-cli-backend');
    assert.strictEqual(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.startsWith('ses_'), `expected ses_*, got ${result.sessionId}`);
    assert.strictEqual(typeof result.workspaceDir, 'string');
    assert.strictEqual(result.error, undefined);
    // Clean only workspace dir; do not delete provider session
  });

  test('confirmSessionForProject via CLI verifies authoritativeSessionId', async () => {
    const provider = new OpenCodeProvider();
    const sessionId = 'ses_f27199e88ffeJskCa6vADCM5Jg'; // existing verified session
    const result = await provider.confirmSessionForProject(sessionId, '/tmp/relay-disposable-workspace');
    assert.strictEqual(result.confirmed, true);
    assert.strictEqual(result.externalSessionId, sessionId);
    assert.ok(result.evidence);
  });
});
