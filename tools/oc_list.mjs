import { discoverOpenCodeSessionClient } from '../src/relay/providers/opencodeSessionClient.ts';

const dir = process.argv[2] || '/Users/lazydeepak/dev/test-project';
const { discovery, client } = await discoverOpenCodeSessionClient();
if (discovery.status !== 'available' || !client) { console.log(JSON.stringify(discovery, null, 2)); process.exit(1); }
const r = await client.listSessionsByDirectory(dir, { limit: 200 });
const rows = r.sessions.map((s, i) => ({ i, id: s.sessionId, title: s.title, dir: s.directory }));
console.log(`service ${discovery.registration.url} v${discovery.registration.version}  sessions in ${dir}: ${rows.length}`);
for (const s of rows) console.log(`${String(s.i).padStart(3)}  ${s.id}  "${s.title ?? ''}"`);

const titles = new Map();
for (const s of rows) {
  const t = (s.title ?? '').trim();
  if (!t) continue;
  titles.set(t, [...(titles.get(t) ?? []), s.id]);
}
console.log('\n--- title collisions ---');
let any = false;
for (const [t, ids] of titles) if (ids.length > 1) { any = true; console.log(`"${t}" -> ${ids.length} sessions: ${ids.join(', ')}`); }
if (!any) console.log('(none)');

const target = process.argv[3];
if (target) {
  console.log('\n--- which entries does Cmd+K fuzzy-matching on this title surface? ---');
  const t = rows.find((x) => x.id === target)?.title;
  console.log(`target ${target} live title = "${t}"`);
  for (const s of rows) {
    const hay = (s.title ?? '').toLowerCase();
    const needle = (t ?? '').toLowerCase();
    if (needle && (hay.includes(needle) || needle.includes(hay))) console.log(`  MATCH ${s.id}  "${s.title}"`);
  }
}
