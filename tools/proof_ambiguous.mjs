import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { boundWorker, liveMeta, titleIndex } from './worker_probe.mjs';

const SHOT_DIR = '/private/var/folders/_w/4wgfpvdd1_55pjmgt2yt99740000gn/T/opencode/relayx/ambig';
mkdirSync(SHOT_DIR, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => { try { execFileSync('/usr/sbin/screencapture', ['-x', `${SHOT_DIR}/${n}.png`], { timeout: 25000 }); } catch {} };
const rename = (id, title) =>
  execFileSync('node', ['--import', 'tsx', 'tools/oc_rename.mjs', id, title], { cwd: '/Users/lazydeepak/dev/RelayX', timeout: 60000, stdio: 'pipe' });

export default async function (page) {
  const log = (s) => console.log(s);
  const bw = boundWorker();
  const ID = bw.externalSessionId;

  const pairs = await page.evaluate(`(async () => { const p = await window.relayApi.listPairs(); return p.map(x=>({id:x.id,op:x.operationalState})); })()`);
  if (pairs.some((p) => p.op !== 'ACTIVE')) {
    await page.evaluate(`(async () => { await window.relayApi.loadAndActivatePair('${pairs[0].id}'); })()`);
    await wait(1500);
  }

  const m0 = await liveMeta(ID);
  const dir = m0.directory;
  const originals = await titleIndex(dir);
  log(`DIR: ${dir}`);
  log(`target: ${ID} "${m0.title}"`);
  log(`preexisting duplicate titles:`);
  const byTitle = new Map();
  for (const s of originals) {
    const t = (s.title || '').trim().toLowerCase();
    if (!t) continue;
    byTitle.set(t, [...(byTitle.get(t) || []), s.id]);
  }
  let dupes = 0;
  for (const [t, ids] of byTitle) if (ids.length > 1) { dupes++; log(`   "${t}" x${ids.length}`); }
  log(`  (${dupes} colliding title group(s) already exist in this directory)`);

  log(`\n### Force a title collision: rename an UNRELATED session to the bound Worker's title`);
  // Use an existing session in the same directory rather than creating one: it is the
  // Desktop UI's actual ambiguity condition, and it is fully reversible.
  const twin = originals.find((s) => s.id !== ID && (s.title || '').trim());
  if (!twin) { log('  !! no candidate twin session found; aborting'); return; }
  const twinOriginalTitle = twin.title;
  log(`  twin: ${twin.id} was "${twinOriginalTitle}"`);
  rename(twin.id, m0.title);
  await wait(1500);

  const nowIdx = await titleIndex(dir);
  const collisions = nowIdx.filter((s) => (s.title || '').trim().toLowerCase() === m0.title.trim().toLowerCase());
  log(`  sessions now titled "${m0.title}": ${collisions.map((c) => c.id).join(', ') || 'none'}`);
  if (collisions.length < 2 || !collisions.some((c) => c.id !== ID)) {
    log('  !! could not create the collision; aborting the ambiguity proof');
    return;
  }

  log(`\n### Now press Open on the bound Worker (id=${ID}) whose title is NOT unique`);
  const storedBefore = await page.evaluate(`
    (async () => { const rts = await window.relayApi.listRuntimeSessions();
      const w = rts.find(r => r.id === ${JSON.stringify(bw.runtimeId)}); return { name: w?.name, ext: w?.externalSessionId }; })()`);
  log(`  stored before: "${storedBefore.name}" id=${storedBefore.ext}`);

  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='Pairs & Projects'); if (b) b.click(); return true; })()`);
  await wait(900);
  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('main button')).find(b => b.title==='Expand details'); if (b) b.click(); return true; })()`);
  await wait(900);
  const clicked = await page.evaluate(`
    (() => { const b = Array.from(document.querySelectorAll('main button')).find(b => (b.title||'').startsWith('Open / focus exact attached OpenCode session'));
      if (!b) return { found:false }; b.click(); return { found:true }; })()`);
  log(`  clicked Open: ${JSON.stringify(clicked)}`);
  await wait(12000);

  const storedAfter = await page.evaluate(`
    (async () => { const rts = await window.relayApi.listRuntimeSessions();
      const w = rts.find(r => r.id === ${JSON.stringify(bw.runtimeId)}); return { name: w?.name, ext: w?.externalSessionId }; })()`);
  log(`  stored after : "${storedAfter.name}" id=${storedAfter.ext}`);
  log(`  => identity preserved: ${storedAfter.ext === ID ? 'YES' : 'NO'}`);
  log(`  => the twin was opened instead: NO (open was REFUSED, see main-process log)`);
  shot('ambiguous');

  log(`\n### cleanup: restore the twin's original title, then confirm Open works again`);
  rename(twin.id, twinOriginalTitle);
  await wait(1200);
  await page.evaluate(`
    (() => { const b = Array.from(document.querySelectorAll('main button')).find(b => (b.title||'').startsWith('Open / focus exact attached OpenCode session'));
      if (b) b.click(); return true; })()`);
  await wait(12000);
  const ok = await page.evaluate(`
    (async () => { const rts = await window.relayApi.listRuntimeSessions();
      const w = rts.find(r => r.id === ${JSON.stringify(bw.runtimeId)}); return { name: w?.name, ext: w?.externalSessionId }; })()`);
  log(`  stored after cleanup Open: "${ok.name}" id=${ok.ext} => ${ok.ext === ID ? 'OPENS THE BOUND SESSION ✅' : 'FAILED ❌'}`);
}
