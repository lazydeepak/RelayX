import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('P1 observer lifecycle identity — both findings corrected', () => {
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

  // Helpers to simulate observations with specific observer instance identities.
  function makeWorkingObservation(armId: string, instanceId: string, epoch?: string, receivedAt?: string) {
    const payload: any = {
      state: 'working',
      armId,
      conversationId: 'conv-p1',
      observerInstanceId: instanceId,
    };
    if (epoch) payload.observerEpoch = epoch;
    if (receivedAt) payload.receivedAt = receivedAt;
    return payload;
  }

  it('4239779819 — historical working observations do not survive a bridge restart as current liveness', async () => {
    // Set up a bridge, arm it, deliver it, and record a working observation.
    const dir = mkdtempSync(join(tmpdir(), 'relayx-p1-4239779819-'));
    directories.push(dir);
    const logPath = join(dir, 'observations.jsonl');
    const port = 19000 + (process.pid % 10000);

    const first = await start(port, logPath);
    const armed = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-p1', ingressId: 'ingress', note: 'p1-historical' }),
    }).then((r) => r.json()) as { armId: string };

    // Deliver the arm (sets consumed=true and observerEpoch to current bridge epoch)
    const nextResp = await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-p1`).then((r) => r.json()) as { observerEpoch?: string };
    const deliveredEpoch = nextResp.observerEpoch ?? String(process.env.RELAYX_PLANNER_OBSERVER_EPOCH ?? 'epoch_old');

    // Content script sends a working observation (simulated with the instance identity)
    const instanceA = 'a1b2c3d4e5f6';
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeWorkingObservation(armed.armId, instanceA, deliveredEpoch)),
    });

    await stop(first);

    // Restart bridge (new process, new observerEpoch) against same ledger.
    const second = await start(port, logPath);

    // The replayed arm must have the same observer instance identity from the ledger.
    const healthAfterRestart = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as {
      arms: Array<{ armId: string; consumed: boolean; completed: boolean; recoveryRequired: boolean; observerInstanceId?: string }>
    };
    const replayedArm = healthAfterRestart.arms.find((a) => a.armId === armed.armId);
    assert.ok(replayedArm, 'replayed arm exists after bridge restart');
    assert.strictEqual(replayedArm.consumed, true, 'arm remains consumed');
    assert.strictEqual(replayedArm.completed, false, 'arm not completed');
    // Because the working observation's observerInstanceId matches the arm's identity,
    // but the bridge epoch is now different, the correlation must fail.
    assert.strictEqual(replayedArm.recoveryRequired, true, 'must signal recovery gap: working evidence from previous bridge epoch must not prove current liveness');
    assert.strictEqual(replayedArm.observerInstanceId, instanceA, 'arm retains the observer instance identity from the original observation');

    await stop(second);
  });

  it('4239840843 — content-script restart (new observer instance) is detected independently of bridge restart', async () => {
    // Single bridge process: arm delivered, working observation from instance A.
    // Then a new observation arrives with a different observerInstanceId (simulating
    // a content-script restart: new tab load, extension reload, or re-injection).
    const dir = mkdtempSync(join(tmpdir(), 'relayx-p1-4239840843-'));
    directories.push(dir);
    const logPath = join(dir, 'observations.jsonl');
    const port = 19001 + (process.pid % 10000);

    const bridge = await start(port, logPath);
    const armed = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-p1', ingressId: 'ingress', note: 'p1-independent' }),
    }).then((r) => r.json()) as { armId: string };

    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-p1`);

    const instanceA = 'inst_a_001';
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeWorkingObservation(armed.armId, instanceA)),
    });

    // Before restart: healthy active observer.
    const healthBefore = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as {
      arms: Array<{ armId: string; recoveryRequired: boolean }>
    };
    const beforeArm = healthBefore.arms.find((a) => a.armId === armed.armId);
    assert.strictEqual(beforeArm?.recoveryRequired, false, 'healthy observer before content-script restart');

    // Simulate independent content-script restart: a new working observation arrives
    // with a DIFFERENT observerInstanceId but the same armId and same bridge epoch.
    const instanceB = 'inst_b_002';
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeWorkingObservation(armed.armId, instanceB)),
    });

    const healthAfter = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as {
      arms: Array<{ armId: string; recoveryRequired: boolean; observerInstanceId?: string }>
    };
    const afterArm = healthAfter.arms.find((a) => a.armId === armed.armId);
    assert.ok(afterArm, 'arm still present');
    // Because the observation's instance identity (B) does not match the arm's stored
    // identity (A), the bridge must consider the previous working evidence stale and
    // report a recovery gap.
    assert.strictEqual(afterArm.recoveryRequired, true, 'new observer instance must trigger recovery gap');
    assert.strictEqual(afterArm.observerInstanceId, instanceA, 'arm identity retains original instance after restart');

    await stop(bridge);
  });

  it('no duplicate arm, delivery, or completion during healthy lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relayx-p1-no-duplicate-'));
    directories.push(dir);
    const logPath = join(dir, 'observations.jsonl');
    const port = 19002 + (process.pid % 10000);

    const bridge = await start(port, logPath);
    const armed = await fetch(`http://127.0.0.1:${port}/arm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv-p1', ingressId: 'ingress', note: 'no-duplicate' }),
    }).then((r) => r.json()) as { armId: string };

    await fetch(`http://127.0.0.1:${port}/next?conversationId=conv-p1`);

    const instanceId = 'inst_healthy';
    await fetch(`http://127.0.0.1:${port}/observation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeWorkingObservation(armed.armId, instanceId)),
    });

    // Only one arm exists.
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as { allArms: Array<{ armId: string }>; arms: Array<{ armId: string; consumed: boolean; completed: boolean; recoveryRequired: boolean }> };
    const currentArms = health.arms.filter((a) => a.armId === armed.armId);
    assert.strictEqual(currentArms.length, 1, 'exactly one current arm');
    assert.strictEqual(currentArms[0].recoveryRequired, false, 'no false recovery during healthy in-flight work');

    // No new arm was minted by any observation.
    assert.strictEqual(health.allArms.length, 1, 'no duplicate arm created');

    await stop(bridge);
  });
});
