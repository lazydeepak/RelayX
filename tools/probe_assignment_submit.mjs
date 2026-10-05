import fs from 'node:fs';
const DB = '/Users/lazydeepak/Library/Application Support/RelayX/relay.sqlite';
function sql(q: string): string {
  try { return require('node:child_process').execFileSync('/usr/bin/sqlite3', ['-separator', ' | ', DB, q], { encoding: 'utf8', timeout: 10000 }).trim(); } catch (e: any) { return 'SQLERR ' + String(e.message).slice(0, 200); }
}

export default async function (page: any) {
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const drain = () => {
    const evs = (globalThis as any).__cdpEvents || [];
    while (evs.length) { const e = evs.shift(); console.log(`[${stamp()}] CDP ${e.method} ${e.params}`); }
  };
  const log = (s: string) => console.log(s);

  const screenshots = (tag: string) => `/private/var/folders/_w/4wgfpvdd1_55pjmgt2yt99740000gn/T/opencode/relayx/assignment-${tag}`;

  // Ensure we can take screenshots.
  fs.mkdirSync('/private/var/folders/_w/4wgfpvdd1_55pjmgt2yt99740000gn/T/opencode/relayx', { recursive: true });

  // Helper: navigate and open the Create Assignment flow.
  const openCreateAssignment = async () => {
    await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Pairs & Projects'); if (b) b.click(); return true; })()`);
    await wait(1000);
    // Click Create Pair to open the modal? No — for assignment creation the
    // user must select a pair first. Let's open the assignment modal directly
    // through the Dashboard "New Assignment" button.
  };

  // First navigate to Assignments tab; open the Create Assignment modal from there.
  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Assignments'); if (b) b.click(); return true; })()`);
  await wait(1000);
  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'New Assignment'); if (b) b.click(); return true; })()`);
  await wait(800);

  const wizard = await page.evaluate(`(() => {
    const m = Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(x => (x.querySelector('h3')||{}).textContent === 'Create New Assignment');
    if (!m) return null;
    const btnText = Array.from(m.querySelectorAll('button')).map(b => b.textContent.trim());
    const title = (m.querySelector('input[type=text]') || {}).value || '';
    const instr = (m.querySelector('textarea') || {}).value || '';
    return { open: true, btns: btnText, title, instruction: instr, selectedPair: m.textContent.includes('test') ? 'test' : 'other' };
  })()`);
  log(`[${stamp()}] Assignment modal open = ${wizard ? wizard.open : false}; buttons = ${wizard ? wizard.btns : 'none'}`);
  log(`[${stamp()}] Title draft = "${wizard ? (wizard.title || '').slice(0, 90) : ''}"`);

  // Fill draft.
  await page.evaluate(`(() => {
    const m = Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(x => (x.querySelector('h3')||{}).textContent === 'Create New Assignment');
    if (!m) throw new Error('modal missing');
    const titleInput = m.querySelector('input[type=text]');
    const instrInput = m.querySelector('textarea');
    if (titleInput) titleInput.value = 'Investigate creation flow';
    if (instrInput) instrInput.value = 'Investigate why assignments disappear.';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    instrInput.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  await wait(600);

  // Before submit: DB state.
  const beforeDB = sql('select (select count(*) from assignments where pair_id=\'pair_muvbpr8i_095ithfy\') as a, (select active_assignment_id from pairs where id=\'pair_muvbpr8i_095ithfy\') as active, operational_state, relay_state from pairs where id=\'pair_muvbpr8i_095ithfy\';');
  log(`[${stamp()}] DB BEFORE submit: ${beforeDB}`);

  log(`[${stamp()}] Submitting assignment...`);
  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Create & Dispatch'); if (!b) throw new Error('Create & Dispatch button missing'); b.click(); return true; })()`);
  await wait(2500);

  // After submit: observe result.
  const afterDB = sql('select (select count(*) from assignments) as total_assignments, (select count(*) from assignments where pair_id=\'pair_muvbpr8i_095ithfy\') as pair_assignments, active_assignment_id, operational_state, relay_state from pairs where id=\'pair_muvbpr8i_095ithfy\';');
  log(`[${stamp()}] DB AFTER submit: ${afterDB}`);

  const wizardAfter = await page.evaluate(`(() => {
    const m = Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(x => (x.querySelector('h3')||{}).textContent === 'Create New Assignment');
    return { open: !!m, btns: m ? Array.from(m.querySelectorAll('button')).map(b => b.textContent.trim()).slice(-4) : null };
  })()`);
  log(`[${stamp()}] Assignment wizard still open: ${wizardAfter.open}`);
  log(`[${stamp()}] Buttons visible: ${wizardAfter.btns}`);

  await page.shot(`${SHOT_DIR}/assignment-submit-${Date.now()}.png`);
  log(`[${stamp()}] Screenshot saved.`);
}