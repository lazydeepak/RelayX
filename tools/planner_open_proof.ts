/**
 * LIVE READ-ONLY PROOF — ChatGPT Planner exact-session opener.
 *
 * Calls the SAME method the RelayX "Open Planner" button calls
 * (ChatGPTProvider.openExactSessionInChrome) against real Chrome.
 *
 * It only NAVIGATES/opens a tab (the identical operation the Open button performs).
 * It never types a message, never submits, never dispatches a relay message.
 */
import { execFileSync } from 'node:child_process';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';

const CONV = '6ac42a8a-8f34-83ee-8a15-7d95de316b90';
const EXACT = `https://chatgpt.com/g/g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx/c/${CONV}`;

/** Read-only: is the window/tab the opener returned actually showing the URL it claimed? */
function observeChrome(): Array<{ win: string; tab: string; id: string; url: string }> {
  const script = `
    tell application "Google Chrome"
      set out to ""
      repeat with wi from 1 to (count of windows)
        set w to window wi
        repeat with tabIndex from 1 to (count of tabs of w)
          set out to out & (id of w) & "::" & (id of tab tabIndex of w) & "::" & (URL of tab tabIndex of w) & linefeed
        end repeat
      end repeat
      return out
    end tell`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const raw = execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [win, tab, url] = l.split('::');
      return { win, tab, id: tab, url };
    });
}

const before = observeChrome();
const beforeExact = before.filter((t) => t.url.includes(CONV));
const beforeProjectScoped = beforeExact.filter((t) => t.url.includes('/g/'));

console.log('=== BEFORE ===');
console.log('total Chrome tabs:', before.length);
console.log('tabs already holding conversation', CONV, '=>', beforeExact.length);
console.log('  of those, PROJECT-SCOPED (/g/<project>/c/<id>):', beforeProjectScoped.length);
console.log('  of those, CANONICALIZED bare /c/<id>:', beforeExact.length - beforeProjectScoped.length);
beforeExact.forEach((t) => console.log(`    win=${t.win} tab=${t.id} ${t.url}`));

const provider = new ChatGPTProvider();
const result = await provider.openExactSessionInChrome(EXACT, CONV);

console.log('\n=== OPENER RESULT (structured, verbatim) ===');
console.log(JSON.stringify({ ...result, diagnostics: undefined }, null, 2));
console.log('diagnostics:');
(result.diagnostics ?? []).forEach((d) => console.log('  -', d));

const after = observeChrome();
const handle = result.windowId != null && result.tabId != null
  ? after.find((t) => t.win === String(result.windowId) && t.tab === String(result.tabId))
  : undefined;

console.log('\n=== AFTER (independent read-only Chrome observation) ===');
console.log('total Chrome tabs after:', after.length, '(delta +' + (after.length - before.length) + ')');
console.log('returned handle WIN:' + result.windowId + '|TAB:' + result.tabId);
console.log('handle actually resolves to:', handle ? handle.url : 'UNRESOLVABLE');
console.log('final VISIBLE (active) tab of front window:', after[0]?.url ?? 'n/a');

const activeScript = `tell application "Google Chrome" to return (URL of active tab of front window)`;
let visible = 'READ_FAILED';
try {
  visible = execFileSync('/usr/bin/osascript', ['-e', activeScript], { encoding: 'utf8' }).trim();
} catch (e: any) {
  visible = 'READ_FAILED: ' + (e?.stderr?.toString() ?? e?.message);
}
console.log('final VISIBLE Chrome URL (active tab of front window):', visible);

console.log('\n=== VERDICT ===');
console.log('requestedUrl      :', EXACT);
console.log('observedUrl       :', result.observedUrl ?? '(none)');
console.log('reused            :', result.reused === true, result.reused === true ? '(existing tab)' : '(NEW tab created)');
console.log('success           :', result.success);
console.log('handle            :', `WIN:${result.windowId}|TAB:${result.tabId}`);
console.log('contains CONV     :', String(result.observedUrl ?? '').includes(CONV));
console.log('project-scoped    :', String(result.observedUrl ?? '').includes('/g/g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx/'));
process.exit(0);