import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { boundWorker } from './worker_probe.mjs';

const SHOT_DIR = '/private/var/folders/_w/4wgfpvdd1_55pjmgt2yt99740000gn/T/opencode/relayx/gate';
mkdirSync(SHOT_DIR, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => { try { execFileSync('/usr/sbin/screencapture', ['-x', `${SHOT_DIR}/${n}.png`], { timeout: 25000 }); } catch {} };
const front = () => { try { return execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 8000 }).toString().trim(); } catch { return '?'; } };

export default async function (page) {
  const log = (s) => console.log(s);
  const bw = boundWorker();

  // Chrome search field the leaked keystrokes used to land in.
  const chromeProbe = () => execFileSync('/usr/bin/osascript', ['-e', `
tell application "Google Chrome"
  set out to ""
  repeat with w in windows
    if (count of tabs of w) > 0 then
      set out to out & (title of active tab of w) & " :: " & (URL of active tab of w) & linefeed
    end if
  end repeat
  return out
end tell`], { timeout: 12000 }).toString().trim();

  log('### Hard-prove the foreground gate aborts instead of leaking keystrokes');
  log('   Chrome is pinned foreground for the whole run by a competing activator.');
  log('');

  const pairs = await page.evaluate(`(async () => { const p = await window.relayApi.listPairs(); return p.map(x=>({id:x.id,op:x.operationalState})); })()`);
  if (pairs.some((p) => p.op !== 'ACTIVE')) {
    await page.evaluate(`(async () => { await window.relayApi.loadAndActivatePair('${pairs[0].id}'); })()`);
    await wait(1500);
  }
  log(`PAIR: ${JSON.stringify(await page.evaluate(`(async () => { const p = await window.relayApi.listPairs(); return p.map(x=>x.operationalState); })()`))}`);
  log(`CHROME BEFORE: ${(await chromeProbe()).split('\n')[0]}`);

  // Pin Chrome foreground aggressively; the gate must therefore never see OpenCode.
  const { spawn } = await import('node:child_process');
  const pin = spawn('/bin/sh', ['-c', 'for i in $(seq 1 90); do osascript -e "tell application \\"Google Chrome\\" to activate" >/dev/null 2>&1; sleep 0.25; done'], { detached: true, stdio: 'ignore' });
  pin.unref();
  await wait(1500);
  log(`foreground now: ${front()}`);

  const res = await page.evaluate(`
    (async () => {
      const rts = await window.relayApi.listRuntimeSessions();
      const w = rts.find(r => r.id === ${JSON.stringify(bw.runtimeId)});
      const t0 = Date.now();
      const r = await window.relayApi.activateRuntime(w.id);
      return JSON.stringify({ result: r, ms: Date.now() - t0 });
    })()`);
  log(`activateRuntime -> ${res}`);

  await wait(2500);
  try { process.kill(-pin.pid); } catch {}
  try { pin.kill('SIGKILL'); } catch {}

  const after = await chromeProbe();
  log(`CHROME AFTER : ${after.split('\n')[0]}`);
  log('');
  const leaked = /test relay oct 5/i.test(after);
  log(`=> session title leaked into Chrome's UI: ${leaked ? 'YES ❌' : 'NO ✅'}`);
  const openedAny = /Ask ChatGPT/i.test(after);
  log(`=> a message was submitted into Chrome's composer: ${openedAny ? 'YES ❌' : 'NO ✅'}`);
  shot('gate-abort');
}
