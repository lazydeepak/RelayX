import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('Bounded observer liveness regression', () => {
  const children: ChildProcess[] = []; const directories: string[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGTERM');
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function start(port: number, logPath: string, extraEnv?: Record<string, string>): Promise<ChildProcess> {
    const child = spawn(process.execPath, [resolve('tools/planner-observer/bridge.mjs')], {
      env: { ...process.env, PLANNER_OBSERVER_PORT: String(port), RELAYX_PLANNER_OBSERVER_LOG: logPath, ...extraEnv },
      stdio: 'ignore',
    });
    children.push(child);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return child; } catch {}
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('bridge did not start');
  }

  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    }
    children.splice(children.indexOf(child), 1);
  }

  it('heartbeat timeout records durable observer_unconfirmed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayx-liveness-'));
    directories.push(dir);
    const logPath = join(dir, 'liveness.jsonl');
    const port = 19100 + (process.pid % 10000);
    const bridge = await start(port, logPath, { RELAYX_PLANNER_OBSERVER_HEARTBEAT_MS: '100' });
    const armed = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-liveness', ingressId: 'ingress', note: 'liveness' }),
    }).then((r) => r.json()) as { armId: string };
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-liveness`);
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'working', conversationId: 'conv-liveness', armId: armed.armId, observerInstanceId: 'inst_liveness' }),
    });
    await new Promise((r) => setTimeout(r, 250));
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as {
      arms: Array<{ armId: string; recoveryRequired: boolean; observerUnconfirmedAt?: string | null; observerInstanceId?: string | null }>
    };
    const armRow = health.arms.find((a) => a.armId === armed.armId);
    assert.ok(armRow, 'arm present');
    assert.strictEqual(armRow.recoveryRequired, true);
    assert.ok(armRow.observerUnconfirmedAt, 'durable observer_unconfirmed recorded');
    assert.strictEqual(armRow.observerInstanceId, 'inst_liveness');
    await stop(bridge);
  });
});
