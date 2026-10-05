import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { boundWorker, liveMeta } from './worker_probe.mjs';

const SHOT_DIR = '/private/var/folders/_w/4wgfpvdd1_55pjmgt2yt99740000gn/T/opencode/relayx/final';
mkdirSync(SHOT_DIR, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => { try { execFileSync('/usr/sbin/screencapture', ['-x', `${SHOT_DIR}/${n}.png`], { timeout: 25000 }); } catch {} };
const front = () => { try { return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 8000 }).toString().trim(); } catch { return '?'; } };
const ocTitle = async () => (await liveMeta(boundWorker().externalSessionId)).title;

export default async function (page) {
  const log = (s) => console.log(s);
  const bw = boundWorker();
  const ID = bw.externalSessionId;

  const stored = () => page.evaluate(`
    (async () => { const rts = await window.relayApi.listRuntimeSessions();
      const w = rts.find(r => r.id === ${JSON.stringify(bw.runtimeId)}); return { name: w?.name, ext: w?.externalSessionId }; })()`);

  const activatePair = async () => {
    const pairs = await page.evaluate(`(async () => { const p = await window.relayApi.listPairs(); return p.map(x => ({id:x.id,op:x.operationalState})); })()`);
    if (pairs.some((p) => p.op !== 'ACTIVE')) {
      await page.evaluate(`(async () => { await window.relayApi.loadAndActivatePair('${pairs[0].id}'); })()`);
      await wait(1500);
      const after = await page.evaluate(`(async () => { const p = await window.relayApi.listPairs(); return p.map(x => ({id:x.id,op:x.operationalState})); })()`);
      log(`  pair -> ${JSON.stringify(after)}`);
    }
  };

  /** The Worker Open button lives in the folded Pair card, so expand it first. */
  const expandCard = () => page.evaluate(`
    (() => { const b = Array.from(document.querySelectorAll('main button')).find(b => b.title==='Expand details' || b.title==='Fold details');
      if (b && b.title==='Expand details') b.click(); return true; })()`);

  const clickOpen = async () => {
    await page.evaluate(`
      (() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='Pairs & Projects'); if (b) b.click(); return true; })()`);
    await wait(900);
    await expandCard();
    await wait(900);
    return page.evaluate(`
      (() => { const b = Array.from(document.querySelectorAll('main button')).find(b => (b.title||'').startsWith('Open / focus exact attached OpenCode session'));
        if (!b) return { found:false, visible: Array.from(document.querySelectorAll('main button')).map(x=>x.title).filter(Boolean).slice(0,12) };
        b.click(); return { found:true }; })()`);
  };
  const toast = () => page.evaluate(`(() => { const t = document.querySelector('div.fixed.top-4'); return t ? t.textContent.trim() : null; })()`);

  log(`BOUND WORKER : ${ID}`);
  await activatePair();

  /* ---------------- 1. repeated opens ---------------- */
  log(`\n### STEP 1-3: open, navigate away, repeat  (6 presses)`);
  let consistent = 0;
  for (let i = 1; i <= 6; i++) {
    const live = await ocTitle();
    const r = await clickOpen();
    await wait(10000);
    const s = await stored();
    const t = await toast();
    const good = s.ext === ID && s.name === live;
    if (good) consistent++;
    log(`  press ${i}: clicked=${r.found} live="${live}" stored="${s.name}" id=${s.ext} ${good ? '✅' : '❌'}`);
    log(`           toast="${t}"`);
    shot(`step1-${i}`);
    // navigate away in OpenCode so the next press must genuinely re-open
    await page.evaluate(`(async () => { await window.relayApi.activateRuntime(${'"' + bw.runtimeId + '"'}).catch(()=>{}); })()`).catch(()=>{});
    await execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to tell process "OpenCode" to keystroke "b" using {command down}'], { timeout: 10000 });
    await wait(800);
  }
  log(`  => ${consistent}/6 presses kept the id AND refreshed the title`);

  /* ---------------- 2. rename, then open ---------------- */
  log(`\n### STEP 4-6: rename the SAME session in OpenCode, then press Open again`);
  const before = await ocTitle();
  const beforeStored = await stored();
  log(`  BEFORE: id=${ID} live="${before}" stored="${beforeStored.name}"`);
  const NEW = `${before} R2`;
  execFileSync('node', ['--import', 'tsx', 'tools/oc_rename.mjs', ID, NEW], { cwd: '/Users/lazydeepak/dev/RelayX', timeout: 60000, stdio: 'pipe' });
  const afterRename = await ocTitle();
  if (afterRename !== NEW) {
    log(`  !! rename did not take effect (live="${afterRename}" wanted "${NEW}") — aborting this step`);
  }
  log(`  RENAMED in OpenCode -> live="${afterRename}"`);
  log(`  stored title is now STALE on purpose: "${(await stored()).name}"`);
  await clickOpen();
  await wait(11000);
  const post = await stored();
  log(`  AFTER Open: stored="${post.name}" id=${post.ext}`);
  log(`  => identity unchanged: ${post.ext === ID ? '✅' : '❌'}`);
  log(`  => title refreshed to live value: ${post.name === afterRename ? '✅' : '❌'} ("${post.name}" vs "${afterRename}")`);
  log(`  toast="${await toast()}"`);
  shot('step2-after-rename-open');

  /* ---------------- 3. focus thief ---------------- */
  log(`\n### STEP 7-9: press Open while another app steals focus (3 presses)`);
  let silentOpens = 0;
  for (let i = 1; i <= 3; i++) {
    const { spawn } = await import('node:child_process');
    const t = spawn('/bin/sh', ['-c', 'for i in $(seq 1 14); do osascript -e "tell application \\"Google Chrome\\" to activate" >/dev/null 2>&1; sleep 0.55; done'], { detached: true, stdio: 'ignore' });
    t.unref();
    await wait(250);
    const r = await clickOpen();
    await wait(17000);
    const s = await stored();
    const toastText = await toast();
    log(`  press ${i}: clicked=${r.found} foreground=${front()} stored="${s.name}" id=${s.ext}`);
    log(`           toast="${toastText}"`);
    shot(`step3-thief-${i}`);
    const claimedSuccess = /Opened the exact attached session/.test(toastText || '');
    if (claimedSuccess) silentOpens++;
    await wait(2000);
  }
  log(`  => presses that reported success despite a competing foreground app: ${silentOpens}/3`);

  /* ---------------- 4. restart RelayX ---------------- */
  log(`\n### STEP 10: restart RelayX and press Open again`);
  const pre = await stored();
  log(`  stored BEFORE restart: "${pre.name}" id=${pre.ext}`);
  await page.evaluate(`location.reload(); 1`).catch(() => {});
  await wait(6000);
  await activatePair();
  const postRestart = await stored();
  log(`  stored AFTER restart : "${postRestart.name}" id=${postRestart.ext}`);
  await clickOpen();
  await wait(11000);
  const fin = await stored();
  log(`  after Open: stored="${fin.name}" id=${fin.ext} toast="${await toast()}"`);
  shot('step4-after-restart');
  log(`  => identity survived restart: ${fin.ext === ID ? '✅' : '❌'}`);
}
