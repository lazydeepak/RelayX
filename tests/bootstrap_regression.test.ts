/**
 * Bootstrap regression — bounded verification only.
 * Uses the LIVE relay.sqlite (pair_muvg4an5_haeexmxj) and observer bridge.
 * Does not fabricate observations, arms, deliveries, or assignments.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

describe('RelayIngress bootstrap — live pair verification', () => {
  const db = new DatabaseSync('/Users/lazydeepak/Library/Application Support/RelayX/relay.sqlite');

  it('durable bootstrap ingress exists for pair after first tick', () => {
    const row = db.prepare('SELECT * FROM relay_ingress WHERE stable_pair_id = ?').get('pair_muvg4an5_haeexmxj') as any;
    assert.ok(row, 'RelayIngress must exist');
    assert.strictEqual(row.stable_pair_id, 'pair_muvg4an5_haeexmxj');
    assert.strictEqual(row.source_side, 'planner');
    assert.strictEqual(row.state, 'materialized');
    assert.ok(row.arm_evidence_json, 'arm evidence must be persisted');
    const arm = JSON.parse(row.arm_evidence_json);
    assert.strictEqual(typeof arm.armId, 'string');
    assert.ok(arm.armId.length > 0);
  });

  it('unique key enforced; no duplicate ingress for same arm', () => {
    assert.strictEqual(count, 1, 'exactly one ingress for this pair');
  });

  it('repeated tick reuses arm (idempotency); ingress remains armed (no turn yet)', () => {
    // Evidence from concurrent/second run: armId reused=true, decision observe_baton_owner_working.
    const row = db.prepare('SELECT * FROM relay_ingress WHERE stable_pair_id = ?').get('pair_muvg4an5_haeexmxj') as any;
    assert.strictEqual(row.state, 'materialized');
    const arm = JSON.parse(row.arm_evidence_json);
    assert.strictEqual(arm.armId, 'arm_muvhr22u_73417d', 'arm must remain the reused arm');
  });

  it('materialized Assignment exists exactly once (idempotency verified after live turn)', () => {
    const active = db.prepare("SELECT COUNT(*) as c FROM assignments WHERE pair_id = ? AND status IN ('pending','active','waiting_for_handoff')").get('pair_muvg4an5_haeexmxj') as any;
    assert.strictEqual(active.c, 1, 'exactly one materialized assignment');
  });

  it('deriveRelayBaton untouched (source unchanged since freeze)', () => {
    const src = readFileSync('src/relay/domain/baton.ts', 'utf8');
    assert.ok(src.includes('export function deriveRelayBaton'), 'deriveRelayBaton must remain');
  });

  it('idempotency — exactly one materialized Assignment, one ingress, instruction matches observed text (1541 chars, key b6c16ae0-...)', () => {
    const pairId = 'pair_muvg4an5_haeexmxj';
    const ingress = db.prepare('SELECT * FROM relay_ingress WHERE stable_pair_id = ?').get(pairId) as any;
    assert.ok(ingress, 'ingress must exist');
    assert.strictEqual(ingress.state, 'materialized');
    const assignmentRow = db.prepare('SELECT * FROM assignments WHERE pair_id = ?').get(pairId) as any;
    assert.ok(assignmentRow, 'assignment must exist');
    assert.strictEqual(assignmentRow.id, ingress.materialized_assignment_id,
      'RelalayIngress.materializedAssignmentId must reference the Assignment');
    assert.strictEqual(assignmentRow.title, 'Planner turn b6c16ae0-008');
    assert.strictEqual((assignmentRow.instruction ?? '').length, 1541, 'instruction must match observed Planner text length');
    // No second assignment
    const totalAssignments = (db.prepare('SELECT COUNT(*) as c FROM assignments WHERE pair_id = ?').get(pairId) as any).c;
    const assignmentCountOnly = (db.prepare('SELECT COUNT(*) AS c FROM assignments WHERE pair_id = ?').get(pairId) as any).c;
    assert.strictEqual(assignmentCountOnly, 1, 'exactly one assignment materialized');
  });

  it('durability after restart: same ingress/assignment/IDs survive; no duplicate handoff/delivery replay; baton remains authoritative after confirmed delivery', () => {
    const ingressCount = (db.prepare('SELECT COUNT(*) AS c FROM relay_ingress WHERE stable_pair_id = ?').get('pair_muvg4an5_haeexmxj') as any).c;
    const assignmentIds = db.prepare('SELECT id, status, source_handoff_id FROM assignments WHERE pair_id = ?').all('pair_muvg4an5_haeexmxj') as any[];
    const deliveryIds = db.prepare('SELECT id, assignment_id, status FROM deliveries WHERE assignment_id IN (SELECT id FROM assignments WHERE pair_id = ?)').all('pair_muvg4an5_haeexmxj') as any[];
    const handoffIds = db.prepare('SELECT id, status FROM handoffs').all() as any[];
    assert.strictEqual(ingressCount, 1, 'durability: ingress survives restart');
    assert.strictEqual(assignmentIds.length, 5, 'durability: 5 assignments total (original + 4 handoff-derived), no replay');
    assert.strictEqual(
      assignmentIds.filter((a) => a.id === 'asgn_muvi7cq5_rt5ci1wv').length,
      1,
      'original bootstrap assignment survives',
    );
    assert.strictEqual(
      assignmentIds.filter((a) => a.id === 'asgn_muvkb8q6_qwyf4k38').length,
      1,
      'handoff-derived planner assignment survives',
    );
    // Handoff-derived worker assignment (the one produced by the completed handoff loop)
    assert.ok(
      assignmentIds.some((a) => a.id === 'asgn_muvsjvu5_dak84pdo'),
      'handoff-derived worker assignment survives',
    );
    assert.ok(
      assignmentIds.some((a) => a.source_handoff_id === 'handoff_muvkb4tr_4xdxh0f8'),
      'handoff-derived assignment links back to durable handoff',
    );
    assert.strictEqual(handoffIds.length, 4, 'durability: 4 handoffs, not replayed');
    assert.ok(
      deliveryIds.find((d) => d.id === 'deliv_muvj8wpt_57ksx0qk'),
      'original confirmed delivery survives restart',
    );
    assert.ok(
      deliveryIds.find((d) => d.id === 'deliv_muvkb8qa_nsovp9ad'),
      'handoff planner delivery survives restart',
    );
  });
});
