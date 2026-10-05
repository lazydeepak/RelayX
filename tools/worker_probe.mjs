import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { discoverOpenCodeSessionClient } from '../src/relay/providers/opencodeSessionClient.ts';
import { desktopState, activeSessions } from './oc_desktop_state.mjs';

const SHOT_DIR = '/private/var/folders/_w/4wgfpvdd1_55pjmgt2yt99740000gn/T/opencode/relayx/worker-open';
fs.mkdirSync(SHOT_DIR, { recursive: true });
const DB = '/Users/lazydeepak/Library/Application Support/RelayX/relay.sqlite';
const sql = (q) => { try { return execFileSync('/usr/bin/sqlite3', ['-separator', ' | ', DB, q], { timeout: 10000 }).toString().trim(); } catch (e) { return 'SQLERR ' + String(e.message).slice(0, 160); } };
const screencap = (f) => { try { execFileSync('/usr/sbin/screencapture', ['-x', f], { timeout: 25000 }); return path.basename(f); } catch { return 'SCREENFAIL'; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function boundWorker() {
  const row = sql(`select r.id, r.name, r.external_session_id, r.window_title, p.name as pair_name
                    from pairs p join runtime_sessions r on r.id = p.worker_session_id limit 1;`);
  if (!row) return null;
  const [id, name, ext, winTitle, pairName] = row.split(' | ');
  return { runtimeId: id, storedName: name, externalSessionId: ext, windowTitle: winTitle || null, pairName };
}

export async function liveMeta(sessionId) {
  const { discovery, client } = await discoverOpenCodeSessionClient();
  if (discovery.status !== 'available' || !client) return { ok: false, failure: discovery.failure, error: discovery.error };
  try {
    const r = await client.getSession(sessionId);
    return { ok: true, serviceUrl: discovery.registration.url, serviceVersion: discovery.registration.version, title: r.session.title, directory: r.session.directory, updatedAt: r.session.updatedAt };
  } catch (e) { return { ok: false, code: e.code, error: e.message }; }
}

export async function titleIndex(dir) {
  const { discovery, client } = await discoverOpenCodeSessionClient();
  if (discovery.status !== 'available' || !client) return [];
  const r = await client.listSessionsByDirectory(dir, { limit: 200 });
  return r.sessions.map((s) => ({ id: s.sessionId, title: s.title }));
}

export async function captureState(tag) {
  const [d, a] = await Promise.all([Promise.resolve(desktopState()), activeSessions()]);
  return { desktop: d, active: a, screenshot: screencap(`${SHOT_DIR}/${tag}.png`) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bw = boundWorker();
  console.log('BOUND WORKER:', JSON.stringify(bw));
  console.log('LIVE META  :', JSON.stringify(await liveMeta(bw.externalSessionId)));
  console.log('STATE      :', JSON.stringify(await captureState('adhoc')));
  void wait;
}
