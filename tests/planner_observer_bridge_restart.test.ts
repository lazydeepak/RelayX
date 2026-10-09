import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
