import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('Batch C regression — observer-state semantics and baseline durability', () => {
  const children: ChildProcess[] = []; const directories: string[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGTERM');
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function startBridge(port: number, logPath: string): Promise<ChildProcess> {
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

  it('healthy acknowledged turn is NOT recovery gap (#4236577214)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relayx-c-healthy'));
    directories.push(directory);
    const logPath = join(directory, 'healthy.jsonl');
    const port = 18200 + (process.pid % 10000);
    await startBridge(port, logPath);

    const armResp = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-c-h', ingressId: 'ingress-c-h', note: 'batch-c-healthy' }),
    });
    const armData: { armId: string } = await armResp.json();
    assert.ok(armData.armId);

    // Deliver arm (sets consumed:true via /next)
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-c-h`);

    // Acknowledge via engine-equivalent /consume-arm (sets recoveryConsumed:true)
    await fetch(`http://127.0.0.1:${port}/consume-arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ armId: armData.armId }),
    });

    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
    const armInfo = health.arms?.find((a: any) => a.armId === armData.armId);
    assert.ok(armInfo, 'arm present');
    assert.strictEqual(armInfo.consumed, true, 'delivered');
    assert.strictEqual(armInfo.completed, false, 'not finished');
    assert.strictEqual(armInfo.recoveryRequired, false, 'healthy acknowledged turn must NOT be recovery gap (#4236577214)');
  });

  it('delivered-but-unacknowledged arm with no working evidence is genuine gap (#4236577214 + #4236577211)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relayx-c-gap'));
    directories.push(directory);
    const logPath = join(directory, 'gap.jsonl');
    const port = 18201 + (process.pid % 10000);
    await startBridge(port, logPath);

    const armResp = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-c-g', ingressId: 'ingress-c-g', note: 'batch-c-gap' }),
    });
    const armData: { armId: string } = await armResp.json();

    // Deliver but do NOT acknowledge (simulates crash before /consume-arm)
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-c-g`);

    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
    const armInfo = health.arms?.find((a: any) => a.armId === armData.armId);
    assert.strictEqual(armInfo.recoveryRequired, true, 'delivered-but-unacknowledged gap must be reported as recovery (#4236577214)');
  });

  it('interrupted restart gap: consumed but no acknowledgment + no working observations (#4236577211)', async () => {
    // This verifies that a transient unreadable does not silently block — the gap
    // is surfaced (recoveryRequired:true) rather than hidden, allowing operator action.
    const directory = mkdtempSync(join(tmpdir(), 'relayx-c-interrupt'));
    directories.push(directory);
    const logPath = join(directory, 'interrupt.jsonl');
    const port = 18202 + (process.pid % 10000);
    await startBridge(port, logPath);

    const armResp = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-c-int', ingressId: 'ingress-c-int', note: 'batch-c-interrupt' }),
    });
    const armData: { armId: string } = await armResp.json();

    // Deliver arm; no acknowledgment; no observations produced (simulates unreadable)
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-c-int`);

    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
    const armInfo = health.arms?.find((a: any) => a.armId === armData.armId);
    assert.strictEqual(armInfo.consumed, true);
    assert.strictEqual(armInfo.completed, false);
    assert.strictEqual(armInfo.recoveryRequired, true, 'interrupted arm (no acknowledgment, no working observations) must surface as gap (#4236577211)');
  });
});
