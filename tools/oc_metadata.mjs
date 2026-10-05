/**
 * Live OpenCode metadata probe, using the SAME production client module the app uses
 * (src/relay/providers/opencodeSessionClient.ts). Read-only: GET /api/session/{id}.
 *
 *   node --import tsx tools/oc_metadata.mjs <sessionId> [...]
 */
import { discoverOpenCodeSessionClient } from '../src/relay/providers/opencodeSessionClient.ts';

const ids = process.argv.slice(2);
const { discovery, client } = await discoverOpenCodeSessionClient();
if (discovery.status !== 'available' || !client) {
  console.log(JSON.stringify({ ok: false, discovery }, null, 2));
  process.exit(1);
}
console.log('service:', JSON.stringify({ url: discovery.registration.url, version: discovery.registration.version, pid: discovery.registration.pid }));

const out = [];
for (const id of ids) {
  try {
    const r = await client.getSession(id);
    out.push({ id, ok: true, title: r.session.title, directory: r.session.directory, updatedAt: r.session.updatedAt, agent: r.session.agent });
  } catch (e) {
    out.push({ id, ok: false, code: e.code, error: e.message });
  }
}
console.log(JSON.stringify(out, null, 2));
