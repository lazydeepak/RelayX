import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PlannerObserverClient } from '../src/relay/providers/plannerObserverClient.ts';

describe('Planner observer bridge restart durability', () => {
  const children: ChildProcess[] = []; const directories: string[] = [];
  afterEach(() => { for (const child of children.splice(0)) child.kill('SIGTERM'); for (const directory of directories.splice(0)) rmSync(directory,{recursive:true,force:true}); });
  async function start(port:number,log:string):Promise<ChildProcess> {
    const child=spawn(process.execPath,[resolve('tools/planner-observer/bridge.mjs')],{
      env:{...process.env,PLANNER_OBSERVER_PORT:String(port),RELAYX_PLANNER_OBSERVER_LOG:log},stdio:'ignore'});
    children.push(child);
    for(let attempt=0;attempt<100;attempt++) {
      try { const response=await fetch(`http://127.0.0.1:${port}/health`); if(response.ok)return child; } catch {}
      await new Promise(resolveWait=>setTimeout(resolveWait,10));
    }
    throw new Error('bridge did not start');
  }
  async function stop(child:ChildProcess):Promise<void> {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolveExit=>child.once('exit',()=>resolveExit())); }
    children.splice(children.indexOf(child),1);
  }
  it('reloads exact arm and completion evidence from its append-only ledger', async () => {
    const directory=mkdtempSync(join(tmpdir(),'relayx-observer-')); directories.push(directory);
    const log=join(directory,'observations.jsonl'); const port=18000+(process.pid%10000);
    const first=await start(port,log);
    const armed=await fetch(`http://127.0.0.1:${port}/arm`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({conversationId:'conversation',ingressId:'ingress',note:'bootstrap ingress'})}).then(response=>response.json()) as {armId:string};
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`);
    await fetch(`http://127.0.0.1:${port}/observation`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      state:'finished',conversationId:'conversation',armId:armed.armId,latestCompletedResponse:'done',completedTurnKey:'turn'})});
    await stop(first);
    await start(port,log);
    const health=await fetch(`http://127.0.0.1:${port}/health`).then(response=>response.json()) as {allArms:Array<Record<string,unknown>>};
    assert.deepEqual(health.allArms,[{armId:armed.armId,conversationId:'conversation',deliveryId:null,ingressId:'ingress',completed:true,
      issuedAt:health.allArms[0]!.issuedAt}]);
    const all=await fetch(`http://127.0.0.1:${port}/all?conversationId=conversation`).then(response=>response.json()) as {observations:Array<Record<string,unknown>>};
    assert.equal(all.observations.length,1); assert.equal(all.observations[0]!.armId,armed.armId); assert.equal(all.observations[0]!.state,'finished');
    const next=await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`).then(response=>response.json()) as {armed:boolean;armId:string};
    assert.deepEqual(next,{ok:true,armed:false,armId:armed.armId,reason:'this arm already produced its completion; awaiting the next delivery'});
  });
  it('separates new arm records from a crash-truncated ledger tail', async () => {
    const directory=mkdtempSync(join(tmpdir(),'relayx-observer-')); directories.push(directory);
    const log=join(directory,'observations.jsonl'); const port=18000+(process.pid%10000);
    appendFileSync(log,'{"state":"working","conversationId":"broken');
    const first=await start(port,log);
    const armed=await fetch(`http://127.0.0.1:${port}/arm`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({conversationId:'conversation',ingressId:'ingress'})}).then(response=>response.json()) as {armId:string};
    await stop(first); await start(port,log);
    const health=await fetch(`http://127.0.0.1:${port}/health`).then(response=>response.json()) as {allArms:Array<{armId:string}>};
    assert.deepEqual(health.allArms.map(arm=>arm.armId),[armed.armId],
      'the first post-crash arm remains a separate durable ledger record');
  });
  it('recovers completion when the process dies before its arm-state append', async () => {
    const directory=mkdtempSync(join(tmpdir(),'relayx-observer-')); directories.push(directory);
    const log=join(directory,'observations.jsonl'); const port=18000+(process.pid%10000);
    const arm={armId:'arm_crash_window',conversationId:'conversation',deliveryId:null,ingressId:'ingress',
      issuedAt:new Date().toISOString(),note:null,deliveredAt:new Date().toISOString(),consumed:true,completed:false};
    appendFileSync(log,`${JSON.stringify({ledgerType:'arm',arm})}\n${JSON.stringify({
      state:'finished',conversationId:'conversation',armId:arm.armId,latestCompletedResponse:'done',
      completedTurnKey:'turn',seq:1,receivedAt:new Date().toISOString()})}\n`);
    await start(port,log);
    const health=await fetch(`http://127.0.0.1:${port}/health`).then(response=>response.json()) as {allArms:Array<{completed:boolean}>};
    assert.equal(health.allArms[0]!.completed,true);
    const next=await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`).then(response=>response.json()) as {armed:boolean;reason:string};
    assert.equal(next.armed,false); assert.match(next.reason,/already produced its completion/);
  });
  it('retains an arm completion beyond the rolling observation window', async () => {
    const directory=mkdtempSync(join(tmpdir(),'relayx-observer-')); directories.push(directory);
    const log=join(directory,'observations.jsonl'); const port=18000+(process.pid%10000);
    const arm={armId:'arm_old_completion',conversationId:'conversation',deliveryId:null,ingressId:'ingress',
      issuedAt:new Date().toISOString(),note:null,deliveredAt:new Date().toISOString(),consumed:true,completed:false};
    appendFileSync(log,`${JSON.stringify({ledgerType:'arm',arm})}\n${JSON.stringify({
      state:'finished',conversationId:'conversation',armId:arm.armId,latestCompletedResponse:'done',
      completedTurnKey:'turn',seq:1,receivedAt:new Date().toISOString()})}\n`);
    for(let seq=2;seq<=5002;seq++) appendFileSync(log,`${JSON.stringify({state:'working',conversationId:'other',seq})}\n`);
    await start(port,log);
    const all=await fetch(`http://127.0.0.1:${port}/all?conversationId=conversation`).then(response=>response.json()) as {observations:Array<{armId:string}>};
    assert.deepEqual(all.observations.map(observation=>observation.armId),[arm.armId]);
  });
  it('bounds terminal evidence after RelayX durably consumes its bootstrap arm', async () => {
    const directory=mkdtempSync(join(tmpdir(),'relayx-observer-')); directories.push(directory);
    const log=join(directory,'observations.jsonl'); const port=18000+(process.pid%10000);
    const child=await start(port,log);
    const armed=await fetch(`http://127.0.0.1:${port}/arm`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({conversationId:'conversation',ingressId:'ingress'})}).then(response=>response.json()) as {armId:string};
    await fetch(`http://127.0.0.1:${port}/observation`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      state:'finished',conversationId:'conversation',armId:armed.armId,latestCompletedResponse:'done',completedTurnKey:'turn'})});
    await fetch(`http://127.0.0.1:${port}/consume-arm`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({armId:armed.armId})});
    await stop(child);
    for(let seq=0;seq<5001;seq++) appendFileSync(log,`${JSON.stringify({state:'working',conversationId:'other',seq:seq+2})}\n`);
    await start(port,log);
    const health=await fetch(`http://127.0.0.1:${port}/health`).then(response=>response.json()) as {observations:number};
    assert.equal(health.observations,5000);
  });
  it('does not reissue a consumed-but-uncompleted arm after bridge restart', async () => {
    // Simulate: arm was created and delivered (consumed), but the process died
    // before the observer could report `finished`. On restart, the arm has
    // consumed:true, completed:false. /next must NOT return armed:true.
    const directory=mkdtempSync(join(tmpdir(),'relayx-observer-')); directories.push(directory);
    const log=join(directory,'observations.jsonl'); const port=18001+(process.pid%10000);
    const child=await start(port,log);
    const armed=await fetch(`http://127.0.0.1:${port}/arm`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({conversationId:'conversation',ingressId:'ingress',note:'bootstrap ingress'})}).then(response=>response.json()) as {armId:string};
    // Deliver the arm to the observer (marks consumed=true)
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`);
    await stop(child); // process dies BEFORE observer reports finished

    // Restart bridge
    await start(port,log);
    // /next must return recoveryRequired, not armed=true
    const next=await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`).then(response=>response.json()) as {
      armed:boolean; recoveryRequired:boolean; reason:string; armId:string;
    };
    assert.equal(next.armed,false,'consumed-but-uncompleted arm must not be reissued as armed');
    assert.equal(next.recoveryRequired,true,'must signal recoveryRequired for consumed-but-uncompleted arm');
    assert.match(next.reason,/consumed but never completed/,'reason must explain the recovery gap');
    assert.equal(next.armId,armed.armId,'armId must be returned for identification');

    // Health endpoint must still show the arm with consumed:true, completed:false
    // The 'arms' array (current arms) includes consumed, not 'allArms' (historical)
    const health=await fetch(`http://127.0.0.1:${port}/health`).then(response=>response.json()) as {
      arms:Array<{armId:string;consumed:boolean;completed:boolean}>;
    };
    const armInfo=health.arms.find(a=>a.armId===armed.armId);
    assert.ok(armInfo,'arm must be present in health');
    assert.equal(armInfo.consumed,true,'arm must remain consumed');
    assert.equal(armInfo.completed,false,'arm must not be marked completed');
  });
});

/**
 * RelayX status inspection must be READ-ONLY.
 *
 * `GET /next` is the extension's control-plane poll: it DELIVERS an arm to the browser and
 * persists `consumed: true`. Calling it from `bootstrapStatus()` or `status()` would consume the
 * arm on a mere read, so the extension's own first poll would receive `armed: false` and the
 * turn would never be observed. These tests drive the REAL `PlannerObserverClient` against a
 * REAL bridge process, so the assertion is about the shipped control plane rather than a stub.
 */
describe('Planner observer status inspection never mutates the arm control plane', () => {
  const children: ChildProcess[] = []; const directories: string[] = [];
  afterEach(() => { for (const child of children.splice(0)) child.kill('SIGTERM'); for (const directory of directories.splice(0)) rmSync(directory,{recursive:true,force:true}); });

  /** One bridge per test, on its own port, so no test can observe another's arm state. */
  let nextPort = 19100;
  async function withBridge<T>(run: (ctx: { port: number; log: string; dir: string }) => Promise<T>): Promise<T> {
    const dir=mkdtempSync(join(tmpdir(),'relayx-readonly-')); directories.push(dir);
    const log=join(dir,'observations.jsonl'); const port=nextPort++;
    const child=await start(port,log);
    try { return await run({ port, log, dir }); }
    finally { await stop(child); }
  }
  async function start(port:number,log:string):Promise<ChildProcess> {
    const child=spawn(process.execPath,[resolve('tools/planner-observer/bridge.mjs')],{
      env:{...process.env,PLANNER_OBSERVER_PORT:String(port),RELAYX_PLANNER_OBSERVER_LOG:log},stdio:'ignore'});
    children.push(child);
    for(let attempt=0;attempt<100;attempt++) {
      try { const response=await fetch(`http://127.0.0.1:${port}/health`); if(response.ok)return child; } catch {}
      await new Promise(resolveWait=>setTimeout(resolveWait,10));
    }
    throw new Error('bridge did not start');
  }
  async function stop(child:ChildProcess):Promise<void> {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolveExit=>child.once('exit',()=>resolveExit())); }
    children.splice(children.indexOf(child),1);
  }

  /** Arm the observer exactly the way the engine does, and return the real client. */
  async function armedClient(port: number): Promise<{ client: PlannerObserverClient; armId: string }> {
    const client = new PlannerObserverClient({ baseUrl: `http://127.0.0.1:${port}` });
    const arm = await client.ensureBootstrapArmed('conversation', 'ingress');
    return { client, armId: arm.armId };
  }
  /** The arm row as the bridge reports it, which is the only place consumed is persisted. */
  const armRow = async (port: number, armId: string) => {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()) as {
      arms: Array<{ armId: string; consumed: boolean; completed: boolean; recoveryRequired?: boolean; recoveryReason?: string }>;
      allArms: Array<{ armId: string }>;
    };
    return {
      arm: health.arms.find(a => a.armId === armId),
      armCount: health.allArms.length,
    };
  };

  it('a. bootstrapStatus() does not flip consumed:false to consumed:true', async () => {
    await withBridge(async ({ port }) => {
      const { client, armId } = await armedClient(port);
      assert.equal((await armRow(port, armId)).arm?.consumed, false, 'a freshly minted arm is unconsumed');

      for (let read = 0; read < 5; read++) {
        const status = await client.bootstrapStatus('conversation', armId);
        assert.equal(status.recoveryRequired, false, `read ${read} must not report recovery for a fresh arm`);
        assert.equal((await armRow(port, armId)).arm?.consumed, false,
          `read ${read} is a STATUS read and must not deliver the arm to the extension`);
      }
    });
  });

  it('b. the extension first /next still receives the arm after any number of status reads', async () => {
    await withBridge(async ({ port }) => {
      const { client, armId } = await armedClient(port);
      for (let read = 0; read < 4; read++) await client.bootstrapStatus('conversation', armId);
      await client.bootstrapStatus('conversation', armId);
      assert.equal((await armRow(port, armId)).arm?.consumed, false, 'status reads left the arm undelivered');

      const next = await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`)
        .then(r => r.json()) as { armed: boolean; armId: string };
      assert.equal(next.armed, true, 'the extension still receives the arm on its first poll');
      assert.equal(next.armId, armId, 'and it is the exact arm RelayX recorded');
      assert.equal((await armRow(port, armId)).arm?.consumed, true, 'the extension poll, not the status read, consumed it');
    });
  });

  it('c. after a real stop/restart with consumed:true and completed:false, read-only status reports recoveryRequired', async () => {
    const dir=mkdtempSync(join(tmpdir(),'relayx-readonly-')); directories.push(dir);
    const log=join(dir,'observations.jsonl'); const port=nextPort++;
    const first=await start(port,log);
    const { armId } = await armedClient(port);
    await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`); // extension consumes the arm
    assert.equal((await armRow(port, armId)).arm?.consumed, true, 'the arm was delivered before the crash');
    await stop(first);

    // The bridge restarts against the SAME ledger, before any `finished` observation exists.
    const second=await start(port,log);
    try {
      const client = new PlannerObserverClient({ baseUrl: `http://127.0.0.1:${port}` });
      const row = (await armRow(port, armId)).arm!;
      assert.equal(row.consumed, true, 'hydration restored consumed:true');
      assert.equal(row.completed, false, 'and completed is still false — the restart gap');

      const status = await client.bootstrapStatus('conversation', armId);
      assert.equal(status.recoveryRequired, true, 'the read-only status surfaces the recovery gap');
      assert.match(status.recoveryReason ?? '', /consumed but never completed/i, 'with the bridge reason');

      // And the control plane still refuses to reissue it.
      const next = await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`)
        .then(r => r.json()) as { armed: boolean; recoveryRequired: boolean };
      assert.equal(next.armed, false, 'the consumed arm is never reissued to the extension');
      assert.equal(next.recoveryRequired, true, 'and the control plane reports the same recovery gap');
    } finally { await stop(second); }
  });

  it('d. repeated read-only checks are idempotent and mint nothing', async () => {
    await withBridge(async ({ port }) => {
      const { client, armId } = await armedClient(port);
      await fetch(`http://127.0.0.1:${port}/next?conversationId=conversation`); // consume the arm

      const before = await armRow(port, armId);
      for (let read = 0; read < 6; read++) {
        const status = await client.bootstrapStatus('conversation', armId);
        assert.equal(status.recoveryRequired, true, `read ${read} reports the same recovery gap`);
        assert.equal(status.armId, armId, `read ${read} reports the exact same arm`);
        const deliveryStatus = await client.status('conversation', 'deliv_1');
        assert.equal(deliveryStatus.recoveryRequired, true, `status() read ${read} agrees`);
      }

      const after = await armRow(port, armId);
      assert.equal(after.arm?.consumed, true, 'consumed stays consumed');
      assert.equal(after.arm?.completed, false, 'a read never marks an arm completed');
      assert.equal(after.armCount, before.armCount, 'no new arm was minted by any read');
    });
  });

  it('e. status() on a live arm does not consume it or reissue it', async () => {
    await withBridge(async ({ port }) => {
      const { client, armId } = await armedClient(port);
      for (let read = 0; read < 4; read++) {
        const status = await client.status('conversation', 'deliv_1');
        assert.equal(status.recoveryRequired, false, 'a live arm needs no recovery');
        assert.equal((await armRow(port, armId)).arm?.consumed, false, `status() read ${read} must not consume the arm`);
      }
      assert.equal((await armRow(port, armId)).armCount, 1, 'and it must not mint a replacement arm');
    });
  });
});
