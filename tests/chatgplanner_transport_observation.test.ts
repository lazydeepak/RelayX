import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider, OpenCodeProvider } from '../src/relay/providers/adapters.ts';

describe('ChatGPTProvider exposes exact-session transport observation', () => {
  it('defines all three observation methods (the RelayEngine guard requires them)', () => {
    const p = new ChatGPTProvider() as any;
    assert.equal(typeof p.captureTransportBoundary, 'function',
      'RelayEngine guards on this; absent => every planner boundary is null');
    assert.equal(typeof p.observeSide, 'function');
    assert.equal(typeof p.readExactSessionTurnsForReconciliation, 'function');
  });

  it('parity with OpenCodeProvider, which already worked', () => {
    const oc = new OpenCodeProvider() as any;
    assert.equal(typeof oc.captureTransportBoundary, 'function');
    assert.equal(typeof oc.observeSide, 'function');
  });

  it('returns a null boundary with an honest reason when no externalSessionId (never fabricates)', async () => {
    const p = new ChatGPTProvider() as any;
    const r = await p.captureTransportBoundary({ runtimeSessionId: 'r', externalSessionId: null });
    assert.equal(r.watermark, null);
    assert.match(String(r.failure), /No external session id/);
  });

  it('returns a null boundary with an honest reason when the handle cannot be established', async () => {
    const p = new ChatGPTProvider() as any;
    // Force the handle path to fail without touching a real browser.
    p.openDedicatedWindowAndCaptureId = () => null;
    const r = await p.captureTransportBoundary({
      runtimeSessionId: 'r',
      externalSessionId: '6ac1a7c4-7b40-83ec-ba40-86180675f217',
    });
    assert.equal(r.watermark, null, 'must not fabricate a boundary');
    assert.match(String(r.failure), /BrowserHandle/i);
  });

  it('reports unknown (not absent) when the DOM read fails — weaker fact, never fabricated', async () => {
    const p = new ChatGPTProvider() as any;
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.verifyHandleExists = () => true;
    p.executeHandleJavaScript = () => ({ success: false, error: 'boom' });
    const r = await p.observeSide({ externalSessionId: '6ac1a7c4-7b40-83ec-ba40-86180675f217' });
    assert.equal(r.reachabilityState, 'unknown');
    assert.equal(r.messageEvidenceState, 'unknown');
    assert.match(String(r.reason), /never fabricated/i);
  });

  it('builds a boundary from REAL DOM turns, with an id set and captured_pre_dispatch provenance', async () => {
    const p = new ChatGPTProvider() as any;
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 7, tabId: 3 });
    p.verifyHandleExists = () => true;
    p.readHandleUrl = () => 'https://chatgpt.com/c/6ac1a7c4-7b40-83ec-ba40-86180675f217';
    p.executeHandleJavaScript = () => ({
      success: true,
      output: JSON.stringify({
        ok: true,
        turns: [
          { ref: 'm1', role: 'user', ordinal: 0, text: 'do the thing' },
          { ref: 'm2', role: 'assistant', ordinal: 1, text: 'done' },
        ],
      }),
    });
    const r = await p.captureTransportBoundary({
      runtimeSessionId: 'r',
      externalSessionId: '6ac1a7c4-7b40-83ec-ba40-86180675f217',
    });
    assert.equal(r.failure, null);
    assert.ok(r.watermark, 'boundary must be non-null for a readable exact session');
    assert.equal(r.watermark.messageCount, 2);
    assert.equal(r.watermark.messageIds.length, 2);
    assert.equal(r.watermark.provenance, 'captured_pre_dispatch');
    // Ids are `${role}:${content-addressed-ref}`. The ordinal and the DOM-supplied ref are
    // deliberately NOT in the id: ChatGPT virtualises the transcript, so an ordinal-keyed id
    // would churn the boundary set as the rendered window scrolls.
    assert.match(r.watermark.messageIds[0], /^user:chatgpt_u_[0-9]+_\d+$/);
    assert.match(r.watermark.messageIds[1], /^assistant:chatgpt_a_[0-9]+_\d+$/);
    assert.ok(!r.watermark.messageIds.some((id: string) => /:\d+:/.test(id)), 'no ordinal in ids');
  });

  it('treats a readable but EMPTY conversation as a valid boundary (fresh planner session)', async () => {
    const p = new ChatGPTProvider() as any;
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 7, tabId: 3 });
    p.verifyHandleExists = () => true;
    p.readHandleUrl = () => 'https://chatgpt.com/c/abc';
    p.executeHandleJavaScript = () => ({ success: true, output: JSON.stringify({ ok: true, turns: [] }) });
    const r = await p.captureTransportBoundary({ runtimeSessionId: 'r', externalSessionId: 'abc' });
    assert.equal(r.failure, null, 'empty is a genuine state, not a failure');
    assert.ok(r.watermark);
    assert.equal(r.watermark.messageCount, 0);
  });

  it('distinguishes a selector miss from an empty conversation', async () => {
    const p = new ChatGPTProvider() as any;
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 7, tabId: 3 });
    p.verifyHandleExists = () => true;
    p.readHandleUrl = () => 'https://chatgpt.com/c/abc';
    p.executeHandleJavaScript = () => ({
      success: true,
      output: JSON.stringify({ ok: false, reason: 'no turn nodes matched' }),
    });
    const r = await p.captureTransportBoundary({ runtimeSessionId: 'r', externalSessionId: 'abc' });
    assert.equal(r.watermark, null);
    assert.match(String(r.failure), /selector|no turn nodes/i);
  });
});
