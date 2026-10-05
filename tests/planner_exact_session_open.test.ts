import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlannerSessionUrl } from '../src/components/PairView.tsx';

const EXACT = 'https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/c/6ac1a7c4-7b40-83ec-ba40-86180675f217';
const OTHER = 'https://chatgpt.com/g/g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx/c/6ac1362e-bc34-83ee-af03-2f52ee2b88af';

describe('resolvePlannerSessionUrl targets the exact persisted session', () => {
  it('1. preserves /g/{project}/c/{conversation} exactly as stored', () => {
    const url = resolvePlannerSessionUrl(
      { id: 'r1', providerType: 'chatgpt', name: 'n', status: 'available',
        sessionUrl: EXACT, externalSessionId: '6ac1a7c4-7b40-83ec-ba40-86180675f217',
        externalProjectRef: 'https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/project' } as any,
      null,
    );
    assert.equal(url, EXACT);
    assert.ok(url!.includes('/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/'));
  });

  it('2. a different currently-open ChatGPT project cannot alter the target URL', () => {
    const url = resolvePlannerSessionUrl(
      { id: 'r1', providerType: 'chatgpt', name: 'n', status: 'available',
        sessionUrl: EXACT, externalSessionId: '6ac1a7c4-7b40-83ec-ba40-86180675f217',
        externalProjectRef: OTHER } as any,
      { id: 'p', name: 'other', plannerProjectUrl: OTHER } as any,
    );
    assert.equal(url, EXACT);
    assert.ok(!url!.includes('6ab13d0d7a708191ba704a0a5a874b79'));
  });

  it('3. prefers sessionUrl even when externalSessionId is a bare conversation id', () => {
    const url = resolvePlannerSessionUrl(
      { id: 'r1', providerType: 'chatgpt', name: 'n', status: 'available', sessionUrl: EXACT, externalSessionId: 'abc-123' } as any,
      null,
    );
    assert.equal(url, EXACT);
  });

  it('4. never falls back to a bare project page when an exact sessionUrl exists', () => {
    const url = resolvePlannerSessionUrl(
      { id: 'r1', providerType: 'chatgpt', name: 'n', status: 'available', sessionUrl: EXACT, externalSessionId: null } as any,
      { id: 'p', name: 'p', plannerProjectUrl: 'https://chatgpt.com/g/g-p-other/project' } as any,
    );
    assert.equal(url, EXACT);
    assert.ok(!url!.endsWith('/project'));
  });

  it('5. returns null (no generic fallback) when no authoritative identity exists', () => {
    const url = resolvePlannerSessionUrl(
      { id: 'r1', providerType: 'chatgpt', name: 'n', status: 'available', sessionUrl: null, externalSessionId: null, externalProjectRef: null } as any,
      null,
    );
    assert.equal(url, null);
  });

  it('6. reconstructs the project-scoped path from stored refs ONLY when sessionUrl is absent', () => {
    const url = resolvePlannerSessionUrl(
      { id: 'r1', providerType: 'chatgpt', name: 'n', status: 'available', sessionUrl: null,
        externalSessionId: '6ac1a7c4-7b40-83ec-ba40-86180675f217',
        externalProjectRef: 'https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/project' } as any,
      null,
    );
    assert.equal(url, EXACT);
  });
});
