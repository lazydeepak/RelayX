import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
