import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';

describe('CLI-backed OpenCode provider preservation fence (no live calls)', () => {
  it('keeps provider-owned CLI creation message-free and free of manual auth', () => {
    const source = OpenCodeProvider.prototype.createWorkerSession.toString();
    assert.match(source, /api["'],\s*["']POST["'],\s*["']\/api\/session/);
    assert.match(source, /location:\s*\{\s*directory:\s*projectPath\s*\}/);
    assert.match(source, /sessionId\.startsWith\(["']ses_["']\)/);
    assert.doesNotMatch(source, /Authorization|Basic\s|message\s*:/i);
  });

  it('keeps confirmation read-only and exact-session based', () => {
    const source = OpenCodeProvider.prototype.confirmSessionForProject.toString();
    assert.match(source, /api["'],\s*["']GET["']/);
    assert.match(source, /s\?\.id\s*===\s*sessionId/);
    assert.doesNotMatch(source, /api["'],\s*["']POST["']/);
  });
});
