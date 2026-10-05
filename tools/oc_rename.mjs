#!/usr/bin/env node
// Rename an OpenCode session THROUGH OpenCode's own control plane, so the live
// rename scenario is a real provider-side rename rather than a RelayX-side edit.
//
// The shared service is the same one RelayX reads metadata from, so after this
// returns, `GET /api/session/{id}` reflects the new title.
//
//   node --import tsx tools/oc_rename.mjs <ses_id> "<new title>"
import { execFileSync } from 'node:child_process';

const CLI = '/Users/lazydeepak/Library/Application Support/ai.opencode.desktop/cli/2.0.22/opencode-cli';
const id = process.argv[2];
const title = process.argv[3];
if (!id || !title) {
  console.error('usage: oc_rename.mjs <ses_id> "<new title>"');
  process.exit(2);
}

const run = (args) => {
  try {
    return { ok: true, out: execFileSync(CLI, args, { encoding: 'utf8', timeout: 30000 }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message).slice(0, 400) };
  }
};

console.log('before:', JSON.stringify(run(['api', 'GET', `/api/session/${id}`]).out.slice(0, 300)));

// Try the documented operation id first, then the plain PATCH.
const attempts = [
  ['api', 'session.update', '--data', JSON.stringify({ title })],
  ['api', 'PATCH', `/api/session/${id}`, '--data', JSON.stringify({ title })],
];

let done = false;
for (const args of attempts) {
  const r = run(args);
  console.log(`try ${args.slice(0, 2).join(' ')} -> ok=${r.ok} ${r.out.slice(0, 300)}`);
  if (r.ok && !/not found|no operation|unknown/i.test(r.out)) { done = true; break; }
}

const after = run(['api', 'GET', `/api/session/${id}`]).out;
console.log('after :', after.slice(0, 300));
const m = after.match(/"title"\s*:\s*"([^"]*)"/);
console.log(`\nRESULT: live title is now "${m ? m[1] : '?'}" (wanted "${title}") -> ${m && m[1] === title ? 'RENAMED' : 'NOT RENAMED'}`);
process.exit(done && m && m[1] === title ? 0 : 1);
