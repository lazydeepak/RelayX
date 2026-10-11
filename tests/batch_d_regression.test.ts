import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('Batch D regression — replay cap after hydration preserves required evidence (#4237106515)', () => {
  const children: ChildProcess[] = []; const directories: string[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGTERM');
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function start(port: number, logPath: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, [resolve('tools/planner-observer/bridge.mjs')], {
      env: { ...process.env, PLANNER_OBSERVER_PORT: String(port), RELAYX_PLANNER_OBSERVER_LOG: logPath },
      stdio: 'ignore',
    });
    children.push(child);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return child;
      } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('bridge did not start');
  }

  it('replay of >5000 observations keeps array bounded and preserves terminal evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relayx-batch-d'));
    directories.push(directory);
    const logPath = join(directory, 'replay.jsonl');
    const port = 18300 + (process.pid % 10000);
    const first = await start(port, logPath);

    // Create arm and complete it (writes finished observation + arm_state)
    const armResp = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-replay', ingressId: 'ingress-replay', note: 'batch-d-replay' }),
    }).then((r) => r.json()) as { armId: string };

    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-replay`);
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: 'finished', conversationId: 'conv-replay', armId: armResp.armId,
        latestCompletedResponse: 'done', completedTurnKey: 'turn-replay',
      }),
    });
    await fetch(`http://127.0.0.1:${port}/consume-arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ armId: armResp.armId }),
    });

    // Kill bridge before it can compact the observation window
    await new Promise<void>((resolveExit) => { first.kill('SIGTERM'); first.once('exit', () => resolveExit()); });
    directories.splice(directories.indexOf(directory), 1); // stop cleanup for restart

    // Append 5001 working observations (simulating large journal before restart)
    for (let seq = 0; seq < 5001; seq++) {
      appendFileSync(logPath, `${JSON.stringify({ state: 'working', conversationId: 'other', seq: seq + 10 })}\n`);
    }

    // Restart bridge — must replay from log without unbounded growth
    const second = await start(port, logPath);

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as {
      observations: number; arms: Array<{ armId: string; consumed: boolean; completed: boolean; recoveryRequired: boolean }>;
    };
    // The array must stay bounded (cap is 5000); protected terminal evidence survives.
    assert.strictEqual(health.observations <= 5000, true, `observations must stay bounded after replay, got ${health.observations}`);
    const replayedArm = health.arms?.find((a) => a.armId === armResp.armId);
    assert.ok(replayedArm, 'replayed completed arm must survive hydration');
    assert.strictEqual(replayedArm.completed, true, 'completed state must survive replay');
    assert.strictEqual(replayedArm.recoveryRequired, false, 'completed acknowledged arm must NOT trigger false gap');

    // No new arm redelivered (read-only /next preserved)
    const nextResponse = await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-replay`).then((r) => r.json());
    assert.strictEqual(nextResponse.armed, false, 'completed arm must not be reissued');
  });

  it('sequence identity remains deterministic after replay (#4237106515 + #4239738797)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relayx-batch-d-seq'));
    directories.push(directory);
    const logPath = join(directory, 'seq.jsonl');
    const port = 18301 + (process.pid % 10000);
    const child = await start(port, logPath);

    // Create arm and record a sequenced working observation (with explicit seq)
    const armResp = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-seq', ingressId: 'ingress-seq', note: 'batch-d-seq' }),
    }).then((r) => r.json()) as { armId: string };
    assert.ok(armResp.armId, 'arm created');

    // Deliver arm
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-seq`);

    // Record observations with explicit sequence numbers
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'working', conversationId: 'conv-seq', armId: armResp.armId, seq: 1 }),
    });
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'working', conversationId: 'conv-seq', armId: armResp.armId, seq: 2 }),
    });

    // Acknowledge arm (sets recoveryConsumed via /consume-arm)
    await fetch(`http://127.0.0.1:${port}/consume-arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ armId: armResp.armId }),
    });

    // Kill bridge (simulates crash/restart before observation cap applied)
    await new Promise<void>((resolveExit) => { child.kill('SIGTERM'); child.once('exit', () => resolveExit()); });
    directories.splice(directories.indexOf(directory), 1);

    // Restart bridge — replay must preserve sequence identity and ordering
    const second = await start(port, logPath);

    // Post additional observation after restart; its sequence must advance monotonically
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'working', conversationId: 'conv-seq', armId: armResp.armId, seq: 3 }),
    });

    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.ok(health.ok, 'health available after replay');

    // Sequence identity: retrieve observations via /all endpoint (health only returns count)
    const allResponse = await fetch(`http://127.0.0.1:${port}/all?conversationId=conv-seq`).then((r) => r.json());
    const observations = allResponse.observations ?? [];
    const sequences = observations.filter((o: any) => o.seq !== undefined).map((o: any) => o.seq);
    const uniqueSequences = [...new Set(sequences)];
    assert.strictEqual(sequences.length, uniqueSequences.length, 'sequence identity preserved: no duplicate sequence numbers (#4239738797)');
    assert.strictEqual(sequences.length >= 3, true, 'replayed observations preserved (at least 3 sequenced records)');

    // The replayed arm must retain its acknowledged/completed state correctly
    const replayedArm = health.arms?.find((a: any) => a.armId === armResp.armId);
    assert.ok(replayedArm, 'replayed arm survives hydration');
    assert.strictEqual(replayedArm.completed === true ? true : false, false, 'replay must not fabricate a false completed state');
  });
});
