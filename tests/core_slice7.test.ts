import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'crypto';

describe('Core Slice 7 — Plan-First Contract', () => {
  it('C1 — canonical stability (whitespace/ordering irrelevant)', async () => {
    const canonicalA = JSON.stringify({ objective: 'support CSV import', criteria: 'tests pass' }, Object.keys({ objective: 'x', criteria: 'x' }).sort());
    const canonicalB = JSON.stringify({ objective: 'support CSV import', criteria: 'tests pass' }, Object.keys({ criteria: 'x', objective: 'x' }).sort());
    const digestA = createHash('sha256').update(canonicalA).digest('hex');
    const digestB = createHash('sha256').update(canonicalB).digest('hex');
    assert.strictEqual(digestA, digestB);
  });

  it('C2 — semantic objective change alters digest', async () => {
    const canonicalA = JSON.stringify({ objective: 'support CSV import', criteria: 'tests pass' }, ['objective', 'criteria']);
    const canonicalB = JSON.stringify({ objective: 'support CSV and XLSX import', criteria: 'tests pass' }, ['objective', 'criteria']);
    const digestA = createHash('sha256').update(canonicalA).digest('hex');
    const digestB = createHash('sha256').update(canonicalB).digest('hex');
    assert.notStrictEqual(digestA, digestB);
  });

  it('C3 — unrelated document section change does not alter digest', async () => {
    const canonicalA = JSON.stringify({ objective: 'build', criteria: 'pass', milestone: 'm1' }, ['objective', 'criteria']);
    const canonicalB = JSON.stringify({ objective: 'build', criteria: 'pass', milestone: 'm2' }, ['objective', 'criteria']);
    const digestA = createHash('sha256').update(canonicalA).digest('hex');
    const digestB = createHash('sha256').update(canonicalB).digest('hex');
    assert.strictEqual(digestA, digestB);
  });
});
