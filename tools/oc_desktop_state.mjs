import { execFileSync } from 'node:child_process';
import { discoverOpenCodeSessionClient } from '../src/relay/providers/opencodeSessionClient.ts';

const APP = 'OpenCode';
function osa(lines) {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', lines], { timeout: 15000 }).toString().trim();
  } catch (e) {
    return 'OSAERR ' + String(e.stderr || e.message).trim().slice(0, 160);
  }
}

export function desktopState() {
  const running = osa(`tell application "System Events" to (name of processes) contains "${APP}"`);
  let front = null;
  let windows = [];
  let focused = null;
  try {
    front = osa(`tell application "System Events" to get name of first process whose frontmost is true`);
  } catch {}
  try {
    windows = osa(`tell application "System Events" to tell process "${APP}" to get {name, subrole} of every window`)
      .split(/,\s*/)
      .filter((s) => s && s !== 'missing value');
  } catch {}
  try {
    focused = osa(`tell application "System Events" to tell process "${APP}" to get name of every window whose value of attribute "AXMain" is true`);
  } catch {}
  const titles = [];
  try {
    const raw = osa(`tell application "System Events" to tell process "${APP}" to get title of every window`);
    titles = raw.split(/,\s*/).filter(Boolean);
  } catch {}
  return { running: running === 'true', frontmost: front, windows, titles, main: focused };
}

export async function activeSessions() {
  const { discovery, client } = await discoverOpenCodeSessionClient();
  if (discovery.status !== 'available' || !client) return { ok: false, discovery };
  try {
    const a = await client.getActiveSessions();
    return { ok: true, byId: a.byId, serviceUrl: discovery.registration.url, pid: discovery.registration.pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function snapshot() {
  const [d, a] = await Promise.all([Promise.resolve(desktopState()), activeSessions()]);
  return { desktop: d, active: a };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await snapshot(), null, 2));
}
