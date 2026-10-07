/**
 * OpenCode working-state detection.
 *
 * ## The defect this pins
 *
 * `isSessionWorking` read a single newest row (`order=desc&limit=1`) and then treated
 * "the first assistant row, else rows[0]" as the session's turn state. OpenCode interleaves
 * rows that carry no turn state into that newest position — `idle` run-outcome markers,
 * `agent-switched` and `model-switched` bookkeeping rows. When one of those was newest,
 * `rows[0]` was evaluated as if it were the assistant turn: it has no `finish`, so
 * `working` became `true` because of a field missing on a row that was never a turn. A
 * session that had genuinely finished reported itself as working forever, which is what
 * freezes the relay at `observe_baton_owner_working` and prevents a handoff.
 *
 * Rows are injected through the client's own `fetchImpl` seam, so the production parsing and
 * selection logic is what runs here — not a re-implementation of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeFixedServerClient } from '../src/relay/providers/opencodeFixedServer.ts';

const SESSION = 'ses_test';

function clientReturning(rows: unknown[]): OpenCodeFixedServerClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return new OpenCodeFixedServerClient({ fetchImpl, timeoutMs: 1000 });
}

const assistant = (over: Record<string, unknown> = {}) => ({ id: 'msg_a', type: 'assistant', ...over });
const tool = (status: string) => ({ type: 'tool', name: 'shell', state: { status } });

describe('OpenCode isSessionWorking — real turn state, never a non-turn row', () => {
  it('an idle run-outcome marker on top means the run ENDED (old rule reported working)', async () => {
    const r = await clientReturning([
      { id: 'row_idle', type: 'idle' },
      assistant({ finish: 'stop', time: { completed: 1 } }),
    ]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
    assert.match(r.reason, /idle run-outcome marker/);
  });

  it('an agent-switched bookkeeping row on top does not become a phantom running turn', async () => {
    const r = await clientReturning([
      { id: 'row_switch', type: 'agent-switched' },
      assistant({ finish: 'stop', time: { completed: 1 } }),
    ]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false, 'finished turn underneath a bookkeeping row is idle');
  });

  it('a model-switched bookkeeping row on top does the same', async () => {
    const r = await clientReturning([
      { id: 'row_model', type: 'model-switched' },
      assistant({ finish: 'stop', time: { completed: 1 } }),
    ]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
  });

  it('a terminated assistant turn with no tool parts is idle', async () => {
    const r = await clientReturning([assistant({ finish: 'stop', content: [{ type: 'text' }] })]).isSessionWorking(
      SESSION,
    );
    assert.strictEqual(r.working, false);
    assert.match(r.reason, /finish=stop/);
  });

  it('an assistant turn with a terminal error finish is idle', async () => {
    const r = await clientReturning([assistant({ finish: 'error' })]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
  });

  it('a streaming assistant turn (no finish) is working', async () => {
    const r = await clientReturning([assistant({ finish: null, content: [{ type: 'reasoning' }] })]).isSessionWorking(
      SESSION,
    );
    assert.strictEqual(r.working, true);
    assert.match(r.reason, /no terminal finish/);
  });

  it('finish=tool-calls CONTINUES the run and is therefore working', async () => {
    const r = await clientReturning([assistant({ finish: 'tool-calls', content: [tool('completed')] })]).isSessionWorking(
      SESSION,
    );
    assert.strictEqual(r.working, true, 'a tool round-trip is not an answer');
  });

  it('a tool part still in flight means working, whatever the finish says', async () => {
    for (const status of ['running', 'pending', '']) {
      const r = await clientReturning([
        assistant({ finish: null, content: [tool(status === '' ? '' : status)] }),
      ]).isSessionWorking(SESSION);
      assert.strictEqual(r.working, true, `tool status "${status}" must read as in flight`);
    }
  });

  it('a completed tool part with a terminal finish is idle', async () => {
    const r = await clientReturning([
      assistant({ finish: 'stop', content: [tool('completed')] }),
    ]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
  });

  it('an empty session reports idle rather than inventing a run', async () => {
    const r = await clientReturning([]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
    assert.match(r.reason, /no message present/);
  });

  it('a window of nothing but bookkeeping rows reports idle, and says so', async () => {
    const r = await clientReturning([
      { id: 'a', type: 'agent-switched' },
      { id: 'b', type: 'model-switched' },
    ]).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
    assert.match(r.reason, /no assistant or idle row/);
  });

  it('an unreadable endpoint does not fabricate a run', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{}', { status: 500 });
    const r = await new OpenCodeFixedServerClient({ fetchImpl, timeoutMs: 1000 }).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
    assert.match(r.reason, /could not read newest message \(500\)/);
  });

  it('reads a window, not a single row, so the real turn is reachable under markers', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input: any) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          data: [{ id: 'idle', type: 'idle' }, assistant({ finish: 'stop' })],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const r = await new OpenCodeFixedServerClient({ fetchImpl, timeoutMs: 1000 }).isSessionWorking(SESSION);
    assert.strictEqual(r.working, false);
    assert.match(seen[0] ?? '', /limit=10/, 'must read a window to find the state-bearing row');
  });
});
