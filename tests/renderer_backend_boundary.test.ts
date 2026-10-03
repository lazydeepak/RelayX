import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('renderer/backend module boundary', () => {
  it('keeps the renderer bridge on IPC or the browser-only preview API', () => {
    const source = readFileSync(new URL('../src/services/relayBridge.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /RelayEngine|RelayApiService|MemoryRelayDatabase|providers\/adapters/);
    assert.match(source, /window\.relayApi/);
    assert.match(source, /browserPreviewApi/);
  });

  it('keeps the browser preview free of Node and backend imports', () => {
    const source = readFileSync(new URL('../src/services/browserPreviewApi.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /node:|child_process|RelayEngine|RelayApiService|providers\/adapters/);
  });

  it('uses the browser-safe conversation URL parser from renderer components', () => {
    const source = readFileSync(new URL('../src/components/pairModalConversation.ts', import.meta.url), 'utf8');
    assert.match(source, /providers\/chatgptConversationUrl/);
    assert.doesNotMatch(source, /providers\/adapters/);
  });
});
