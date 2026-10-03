/**
 * Phase 1 external-worker handoff report tests.
 *
 * The report is a factual summary for an external investigator. These tests
 * prove it is useful, bounded, honest about unknowns, safe with respect to
 * sensitive content, and completely read-only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { HealthIncident, HealthObservation } from '../src/relay/domain/healthDomain.ts';
import {
  HealthHandoffReportService,
  HANDOFF_EVENT_LIMIT,
  HANDOFF_DEFAULT_EVENT_LIMIT,
} from '../src/relay/application/HealthHandoffReportService.ts';
import { sanitizeHealthEvidence } from '../src/relay/health/healthEvidenceSanitizer.ts';

const T0 = 1_700_000_000_000;

function harness() {
  const db = new MemoryRelayDatabase();
  const service = new HealthHandoffReportService(db, db.healthIncidents);
  return { db, service };
}

function mkIncident(
  id: string,
  type: string,
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL',
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'RECURRED' = 'OPEN',
  evidence: Record<string, unknown> = {},
  componentType = 'delivery',
  componentId: string | null = 'del_1',
): HealthIncident {
  return new HealthIncident({
    id, incidentType: type, componentType, componentId, severity, status,
    firstSeen: T0, lastSeen: T0 + 1000, occurrenceCount: 2, evidence,
  });
}

/* ---------- 1: report for all six incident types ---------- */

describe('handoff: all six incident classes', () => {
  const cases: Array<[string, string, Record<string, unknown>, string, string]> = [
    ['DELIVERY_STALLED', 'delivery', { deliveryId: 'del_1', assignmentId: 'asg_1', attemptId: 'att_1', pairId: 'pair_1', status: 'delivering', ageMs: 200_000, thresholdErrorMs: 120_000 }, 'delivery', 'del_1'],
    ['MAIN_PROCESS_STALL', 'main_process', { measuredLagMs: 800, thresholdWarningMs: 150, thresholdErrorMs: 500, confirmationCount: 3 }, 'main_process', 'electron_main'],
    ['UNEXPECTED_IDLE_ACTIVITY', 'supervision', { operationName: 'getAppStatus', activityCategory: 'system_automation', pairCount: 2, activePairCount: 0 }, 'supervision', 'idle_monitor'],
    ['TRANSPORT_UNHEALTHY', 'transport', { transportOperation: 'dispatch', transportOutcome: 'not_delivered', providerIntegrationStatus: 'verified', activeWorkBlocked: true }, 'transport', 'pair_1'],
    ['SESSION_DRIFT', 'session_pair', { expectedExternalSessionId: 'ses_a', observedExternalSessionId: 'ses_b', sideRole: 'worker', providerType: 'opencode', observedVerificationState: 'mismatched' }, 'session_pair', 'pair_2'],
    ['PROVIDER_UNREACHABLE', 'provider', { requiredForActiveWork: true, providerReachable: false, activePairCount: 1, runtimeSessionId: 'rt_1' }, 'provider', 'chatgpt'],
  ];

  for (const [type, ct, ev, expectCt, expectCid] of cases) {
    it(`report generated for ${type}`, async () => {
      const { db, service } = harness();
      await db.healthIncidents.save(mkIncident(`inc_${type}`, type, 'ERROR', 'OPEN', ev, ct, expectCid));
      const report = await service.generate(`inc_${type}`);
      assert.ok(report, `${type} report must be generated`);
      assert.strictEqual(report!.incidentType, type);
      assert.strictEqual(report!.componentType, expectCt);
      assert.strictEqual(report!.componentId, expectCid);
      assert.ok(report!.text.includes('RelayX Health Incident'));
      assert.ok(report!.text.includes(type));
      assert.ok(report!.text.length > 400, 'report should carry substantive content');
    });
  }

  it('detector-specific evidence actually appears in the report', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i1', 'DELIVERY_STALLED', 'ERROR', 'OPEN', {
      deliveryId: 'del_9', assignmentId: 'asg_9', attemptId: 'att_9', pairId: 'pair_9',
      status: 'delivering', ageMs: 200_000, thresholdErrorMs: 120_000,
    }));
    const t = (await service.generate('i1'))!.text;
    for (const token of ['del_9', 'asg_9', 'att_9', 'pair_9', 'delivering', '200000', '120000']) {
      assert.ok(t.includes(token), `expected ${token} in DELIVERY_STALLED report`);
    }
  });

  it('SESSION_DRIFT report includes expected AND observed identity', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i2', 'SESSION_DRIFT', 'ERROR', 'OPEN', {
      expectedExternalSessionId: 'ses_expected',
      observedExternalSessionId: 'ses_observed',
      sideRole: 'planner',
      providerType: 'chatgpt',
      observedVerificationState: 'mismatched',
    }, 'session_pair', 'pair_3'));
    const t = (await service.generate('i2'))!.text;
    assert.ok(t.includes('ses_expected'));
    assert.ok(t.includes('ses_observed'));
    assert.ok(t.includes('mismatched'));
    assert.ok(t.includes('planner'));
  });
});

/* ---------- 2: identifiers ---------- */

describe('handoff: identifiers and classification separation', () => {
  it('includes incident and component identifiers', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('inc_x', 'PROVIDER_UNREACHABLE', 'ERROR', 'OPEN', { providerType: 'chatgpt' }, 'provider', 'chatgpt'));
    const r = (await service.generate('inc_x'))!;
    assert.strictEqual(r.incidentId, 'inc_x');
    assert.ok(r.text.includes('Incident ID: inc_x'));
    assert.ok(r.text.includes('Component type: provider'));
    assert.ok(r.text.includes('Component id: chatgpt'));
    assert.ok(r.text.includes('Severity: ERROR'));
    assert.ok(r.text.includes('Lifecycle: OPEN'));
  });

  it('separates observed facts from the health classification', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i3', 'TRANSPORT_UNHEALTHY', 'ERROR', 'OPEN', {
      transportOutcome: 'not_delivered', reason: 'provider returned no matching turn',
    }, 'transport', 'pair_1'));
    const t = (await service.generate('i3'))!.text;
    assert.ok(t.includes('What RelayX detected (RelayX classification, not a diagnosis)'));
    assert.ok(t.includes('Classification: TRANSPORT_UNHEALTHY'));
    assert.ok(t.includes('Observed facts (sanitized evidence)'));
  });

  it('never claims root cause or prescribes a fix', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i4', 'DELIVERY_STALLED', 'ERROR', 'OPEN', { ageMs: 500_000 }));
    const t = (await service.generate('i4'))!.text;
    assert.ok(!/root cause is/i.test(t));
    assert.ok(!/fix by/i.test(t));
    assert.ok(!/you should retry/i.test(t));
    assert.ok(t.includes('Manual investigation required.'));
    assert.ok(t.includes('no retry or resend'));
    assert.ok(t.includes('no repair'));
  });
});

/* ---------- 3-4: honesty about unknowns ---------- */

describe('handoff: UNKNOWN honesty', () => {
  it('missing values are explicitly unavailable, not fabricated', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i5', 'PROVIDER_UNREACHABLE', 'ERROR', 'OPEN', {}, 'provider', 'opencode'));
    const t = (await service.generate('i5'))!.text;
    assert.ok(t.includes('Pair: unavailable'));
    assert.ok(t.includes('Assignment: unavailable'));
    assert.ok(t.includes('Detector statement: unavailable'));
    assert.ok(t.includes('Unknown / not established by RelayX'));
    assert.ok(!/Pair: null/.test(t));
  });

  it('does not infer unreachable from a missing observation', async () => {
    const { db, service } = harness();
    // providerReachable absent entirely: the report must not claim reachability.
    await db.healthIncidents.save(mkIncident('i6', 'PROVIDER_UNREACHABLE', 'WARNING', 'OPEN', {
      requiredForActiveWork: true,
    }, 'provider', 'opencode'));
    const t = (await service.generate('i6'))!.text;
    assert.ok(!/reachable: (true|false)/.test(t));
  });
});

/* ---------- 5-6: evidence safety ---------- */

describe('handoff: evidence safety', () => {
  it('transcripts, prompts, and message bodies are excluded', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i7', 'DELIVERY_STALLED', 'ERROR', 'OPEN', {
      deliveryId: 'del_s',
      transcript: 'SECRET_TRANSCRIPT_CONTENT',
      prompt: 'SECRET_PROMPT_CONTENT',
      messageBody: 'SECRET_MESSAGE_CONTENT',
      instructionSnippet: 'SECRET_INSTRUCTION_CONTENT',
      command: 'osascript -e secret',
      stdout: 'SECRET_STDOUT',
      apiKey: 'sk-SECRET',
      instruction: 'do the thing',
    }));
    const t = (await service.generate('i7'))!.text;
    for (const secret of [
      'SECRET_TRANSCRIPT_CONTENT', 'SECRET_PROMPT_CONTENT', 'SECRET_MESSAGE_CONTENT',
      'SECRET_INSTRUCTION_CONTENT', 'SECRET_STDOUT', 'sk-SECRET', 'do the thing',
    ]) {
      assert.ok(!t.includes(secret), `secret leaked into report: ${secret}`);
    }
    // Names may appear so the reader knows something was withheld.
    assert.ok(t.includes('redacted for safety'));
  });

  it('oversized and nested evidence is excluded', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i8', 'DELIVERY_STALLED', 'ERROR', 'OPEN', {
      deliveryId: 'del_n',
      ageMs: 1000,
      giantBlob: 'X'.repeat(50_000),
      nested: { a: { b: { c: 'deep' } } },
      messages: [{ role: 'user', content: 'nope' }],
    }));
    const t = (await service.generate('i8'))!.text;
    assert.ok(!t.includes('XXXXXXXXXX'), 'oversized string must not appear');
    assert.ok(!t.includes('deep'));
    assert.ok(t.includes('omitted as oversized or non-scalar'));
    // The report stays small: a 50k blob must not inflate it.
    assert.ok(t.length < 6000, `report should stay compact, got ${t.length} chars`);
  });

  it('uses the shared sanitizer, not a second weaker filter', async () => {
    const direct = sanitizeHealthEvidence({ transcript: 'SECRET', keep: 'ok', giant: 'Y'.repeat(500) });
    assert.strictEqual(direct.values.transcript, undefined);
    assert.strictEqual(direct.values.keep, 'ok');
    assert.strictEqual(direct.values.giant, undefined);
  });
});

/* ---------- 7: bounded related events ---------- */

describe('handoff: related events are bounded', () => {
  it('event query limit is applied and clamped', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i9', 'DELIVERY_STALLED', 'ERROR', 'OPEN', { deliveryId: 'del_e' }));
    for (let i = 0; i < 40; i++) {
      const ev = await import('../src/relay/domain/entities.ts');
      await db.events.save(ev.RelayEvent.create('delivery', 'del_e', `event.${i}`, {
        actor: 'engine', newState: 'x',
      }));
    }
    const r = (await service.generate('i9'))!;
    assert.ok(r.relatedEvents.length <= HANDOFF_DEFAULT_EVENT_LIMIT);
    assert.ok(r.relatedEvents.length <= HANDOFF_EVENT_LIMIT);
    // A huge requested limit is clamped to the hard ceiling.
    const clamped = await service.generate('i9', { eventLimit: 100_000 });
    assert.ok(clamped!.relatedEvents.length <= HANDOFF_EVENT_LIMIT);
  });

  it('event summaries omit payload details', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i10', 'DELIVERY_STALLED', 'ERROR', 'OPEN', { deliveryId: 'del_p' }));
    const ev = await import('../src/relay/domain/entities.ts');
    await db.events.save(ev.RelayEvent.create('delivery', 'del_p', 'delivery.started', {
      actor: 'engine', newState: 'delivering',
      details: { instructionText: 'SECRET_PAYLOAD' },
    }));
    const r = (await service.generate('i10'))!;
    assert.ok(!r.text.includes('SECRET_PAYLOAD'));
  });
});

/* ---------- 8-10: read-only, no external work ---------- */

describe('handoff: read-only and no external work', () => {
  it('report generation mutates no operational state', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i11', 'DELIVERY_STALLED', 'ERROR', 'OPEN', { deliveryId: 'del_z' }));
    const before = await db.healthIncidents.findById('i11');
    await service.generate('i11');
    const after = await db.healthIncidents.findById('i11');
    assert.strictEqual(after!.status, before!.status);
    assert.strictEqual(after!.occurrenceCount, before!.occurrenceCount);
    assert.deepStrictEqual(await db.pairs.findAll(), []);
    assert.deepStrictEqual(await db.runtimes.findAll(), []);
    assert.deepStrictEqual(await db.assignments.findAll(), []);
  });

  it('service imports no provider, subprocess, or filesystem surface', async () => {
    const fs = await import('node:fs');
    const code = fs
      .readFileSync(`${process.cwd()}/src/relay/application/HealthHandoffReportService.ts`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/node:child_process/.test(code));
    assert.ok(!/\b(execSync|spawnSync)\s*\(/.test(code));
    assert.ok(!/osascript/.test(code));
    assert.ok(!/adapters\//.test(code));
    assert.ok(!/setTimeout|setInterval/.test(code), 'report generation owns no timer');
  });

  it('returns null for an unknown incident', async () => {
    const { service } = harness();
    assert.strictEqual(await service.generate('does-not-exist'), null);
  });
});

/* ---------- 11-12: historical and acknowledged ---------- */

describe('handoff: historical and acknowledged incidents', () => {
  it('a RESOLVED incident still produces a historical handoff report', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i12', 'TRANSPORT_UNHEALTHY', 'WARNING', 'RESOLVED', {
      transportOutcome: 'ambiguous', pairId: 'pair_r',
    }, 'transport', 'pair_r'));
    const r = (await service.generate('i12'))!;
    assert.ok(r);
    assert.strictEqual(r.lifecycle, 'RESOLVED');
    assert.ok(r.text.includes('Lifecycle: RESOLVED'));
  });

  it('a RECURRED incident is represented as such', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i13', 'DELIVERY_STALLED', 'WARNING', 'RECURRED', { deliveryId: 'del_rc' }));
    const r = (await service.generate('i13'))!;
    assert.strictEqual(r.lifecycle, 'RECURRED');
    assert.ok(r.text.includes('Lifecycle: RECURRED'));
  });

  it('acknowledged status is represented correctly', async () => {
    const { db, service } = harness();
    await db.healthIncidents.save(mkIncident('i14', 'DELIVERY_STALLED', 'ERROR', 'ACKNOWLEDGED', { deliveryId: 'del_a' }));
    const r = (await service.generate('i14'))!;
    assert.strictEqual(r.lifecycle, 'ACKNOWLEDGED');
    assert.ok(r.text.includes('Lifecycle: ACKNOWLEDGED'));
  });
});

/* ---------- sanitizer unit coverage ---------- */

describe('handoff: sanitizer', () => {
  it('drops denied keys regardless of value', () => {
    const r = sanitizeHealthEvidence({
      deliveryId: 'd1', ageMs: 5, verified: true, nothing: null,
      transcript: 'x', prompt: 'y', script: 'z', env: 'PATH', token: 't',
    });
    assert.deepStrictEqual(Object.keys(r.values).sort(), ['ageMs', 'deliveryId', 'nothing', 'verified']);
    assert.strictEqual(r.redactedKeys.length, 5);
  });

  it('drops non-scalars and oversized strings, keeps the rest', () => {
    const r = sanitizeHealthEvidence({
      ok: 'short',
      tooLong: 'z'.repeat(201),
      exactlyMax: 'z'.repeat(200),
      obj: { a: 1 },
      arr: [1, 2],
      num: 1.5,
      bool: false,
    });
    assert.ok('ok' in r.values);
    assert.ok('exactlyMax' in r.values);
    assert.strictEqual('tooLong' in r.values, false);
    assert.strictEqual('obj' in r.values, false);
    assert.strictEqual('arr' in r.values, false);
    assert.ok('num' in r.values && 'bool' in r.values);
  });
});
