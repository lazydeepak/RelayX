/**
 * Focused pure-helper tests for PairModal's explicit ChatGPT conversation
 * selection — same approach as ui_pair_filter.test.ts (node:test + assert, no
 * component render framework). The helpers under test are the exact module the
 * modal imports, so these tests cover: empty URL, explicit confirmation gating,
 * selected-runtime-versus-entered-URL display, already-bound conflicts before
 * submit, and forwarding the confirmed URL through the 5-arg createPair
 * contract. Also verifies listRuntimeSessions surfaces persisted external
 * identity to the modal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildCreatePairArgs,
  canConfirmConversation,
  describeConversationChoice,
  describeConversationReview,
  describeDiscoveredWorkerChoice,
  findConversationConflict,
  findPlannerIdConflict,
  shortenExternalId,
  validateChatGPTConversationUrl,
} from '../src/components/pairModalConversation.ts';
import { relayBridge } from '../src/services/relayBridge.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProviderType } from '../src/relay/domain/types.ts';

describe('PairModal ChatGPT conversation helpers', () => {
  it('empty URL fails validation with an explanatory reason', () => {
    const empty = validateChatGPTConversationUrl('');
    assert.strictEqual(empty.ok, false);
    if (!empty.ok) assert.match(empty.reason, /specific ChatGPT conversation/i);

    const blank = validateChatGPTConversationUrl('   ');
    assert.strictEqual(blank.ok, false);
  });

  it('malformed or off-host URL fails validation', () => {
    assert.strictEqual(validateChatGPTConversationUrl('not-a-url').ok, false);
    assert.strictEqual(validateChatGPTConversationUrl('https://evilchatgpt.com/g/g-p-x/c/conv1').ok, false);
    // project root without a conversation segment is not a bindable conversation
    assert.strictEqual(validateChatGPTConversationUrl('https://chatgpt.com/g/g-p-x/project').ok, false);
  });

  it('valid project conversation URL passes validation and yields the conversation id', () => {
    const v = validateChatGPTConversationUrl(' https://chatgpt.com/g/g-p-relayx/c/conv-abc ');
    assert.strictEqual(v.ok, true);
    if (v.ok) {
      assert.strictEqual(v.parsed.projectId, 'g-p-relayx');
      assert.strictEqual(v.parsed.conversationId, 'conv-abc');
    }
  });

  it('explicit confirmation is gated on planner, valid URL, and no conflicts', () => {
    const clear = {
      plannerSelected: true,
      conversationValid: true,
      plannerConflictBoundId: null,
      conversationConflictRuntimeId: null,
    };
    assert.strictEqual(canConfirmConversation(clear), true);
    assert.strictEqual(canConfirmConversation({ ...clear, plannerSelected: false }), false);
    assert.strictEqual(canConfirmConversation({ ...clear, conversationValid: false }), false);
    assert.strictEqual(canConfirmConversation({ ...clear, plannerConflictBoundId: 'sess-other' }), false);
    assert.strictEqual(canConfirmConversation({ ...clear, conversationConflictRuntimeId: 'rt-other' }), false);
  });

  it('review pairs the selected planner runtime with the full entered URL', () => {
    const review = describeConversationReview(
      'Planner A',
      'chatgpt',
      'sess-bound-1234567890',
      ' https://chatgpt.com/g/g-p-relayx/c/conv-review ',
    );
    // selected runtime: name + provider, with a shortened bound external id
    assert.match(review.plannerLabel, /Planner A/);
    assert.match(review.plannerLabel, /\(CHATGPT\)/);
    assert.match(review.plannerLabel, /bound: sess-bound-12345…/);
    // full entered URL shown together with the runtime, trimmed of whitespace
    assert.strictEqual(review.url, 'https://chatgpt.com/g/g-p-relayx/c/conv-review');
  });

  it('surfaces already-bound conflicts before submit', () => {
    const planner = { id: 'rt-planner', name: 'Planner', externalSessionId: 'sess-other' };
    const other = { id: 'rt-other', name: 'Other Runtime', externalSessionId: 'conv-abc' };

    // planner already bound to a DIFFERENT conversation
    assert.strictEqual(findPlannerIdConflict(planner, 'conv-new'), 'sess-other');
    // re-binding the exact same conversation is idempotent, not a conflict
    assert.strictEqual(findPlannerIdConflict(planner, 'sess-other'), null);
    assert.strictEqual(findPlannerIdConflict(undefined, 'conv-new'), null);

    // entered conversation already bound to a DIFFERENT runtime
    assert.strictEqual(findConversationConflict([planner, other], 'rt-planner', 'conv-abc')?.id, 'rt-other');
    // the selected planner itself holding the id is not a cross-runtime conflict
    assert.strictEqual(findConversationConflict([planner, other], 'rt-planner', 'sess-other'), null);
  });

  it('shortens external ids for display while keeping full ids in state', () => {
    assert.strictEqual(shortenExternalId('conv-abc'), 'conv-abc');
    assert.strictEqual(shortenExternalId('sess-1234567890', 8), 'sess-123…');
    assert.strictEqual(shortenExternalId(null), null);
    assert.strictEqual(shortenExternalId(undefined), null);
    assert.strictEqual(shortenExternalId(''), null);
  });

  it('forwards the confirmed conversation URL through the 5-arg createPair contract', () => {
    // the committed bridge signature accepts plannerConversationUrl as the 5th arg
    assert.strictEqual(relayBridge.createPair.length, 5);

    const args = buildCreatePairArgs(
      'proj-1',
      '  My Pair  ',
      'rt-planner',
      'rt-worker',
      '  https://chatgpt.com/g/g-p-relayx/c/conv-forward  ',
    );
    assert.deepStrictEqual(args, {
      projectId: 'proj-1',
      name: 'My Pair',
      plannerSessionId: 'rt-planner',
      workerSessionId: 'rt-worker',
      plannerConversationUrl: 'https://chatgpt.com/g/g-p-relayx/c/conv-forward',
    });

    // the exact call shape the modal makes — URL always present in this UI flow
    const [projectId, name, plannerSessionId, workerSessionId, plannerConversationUrl] = [
      args.projectId,
      args.name,
      args.plannerSessionId,
      args.workerSessionId,
      args.plannerConversationUrl,
    ];
    assert.strictEqual(projectId, 'proj-1');
    assert.strictEqual(name, 'My Pair');
    assert.strictEqual(plannerSessionId, 'rt-planner');
    assert.strictEqual(workerSessionId, 'rt-worker');
    assert.strictEqual(plannerConversationUrl, 'https://chatgpt.com/g/g-p-relayx/c/conv-forward');
  });
});

describe('listRuntimeSessions surfaces persisted external identity to the modal', () => {
  it('includes externalSessionId and externalProjectRef for already-bound runtimes', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);

    const bound = RuntimeSession.create('chatgpt' as ProviderType, 'Bound Planner');
    bound.updateExternalIdentity('conv-bound-123', 'https://chatgpt.com/g/g-p-relayx/project');
    await db.runtimes.save(bound);

    const unbound = RuntimeSession.create('opencode' as ProviderType, 'Fresh Worker');
    await db.runtimes.save(unbound);

    const sessions = await api.listRuntimeSessions();
    assert.strictEqual(sessions.length, 2);

    const plannerUI = sessions.find((s) => s.id === bound.id);
    assert.strictEqual(plannerUI?.externalSessionId, 'conv-bound-123');
    assert.strictEqual(plannerUI?.externalProjectRef, 'https://chatgpt.com/g/g-p-relayx/project');
    // the shortened snippet the modal renders for already-bound runtimes
    assert.strictEqual(shortenExternalId(plannerUI?.externalSessionId ?? null, 8), 'conv-bou…');

    const workerUI = sessions.find((s) => s.id === unbound.id);
    assert.strictEqual(workerUI?.externalSessionId, null);
    assert.strictEqual(workerUI?.externalProjectRef, null);
  });
});
describe('PairModal enumeration choice labels (observed registry + discovered workers)', () => {
  it('describes a bound conversation with its authoritative markers', () => {
    const label = describeConversationChoice({
      conversationId: 'conv-bound-1234567890abc',
      source: 'bound',
      paired: true,
      lastSeenAt: 0,
    });
    assert.match(label, /^conv-bound/);
    assert.match(label, /bound/);
    assert.match(label, /in active pair/);
  });

  it('describes an observed conversation distinctly', () => {
    const label = describeConversationChoice({
      conversationId: 'conv-observed',
      source: 'observed',
      paired: false,
      lastSeenAt: 1_700_000_000_000,
    });
    assert.match(label, /conv-observed/);
    assert.match(label, /observed/);
    assert.doesNotMatch(label, /bound/);
    assert.doesNotMatch(label, /in active pair/);
  });

  it('describes a discovered worker choice with window title', () => {
    const label = describeDiscoveredWorkerChoice({
      kind: 'discovered',
      sessionId: 'ses_abcdef1234567890',
      windowTitle: 'RelayX — sessions',
    });
    assert.match(label, /^ses_abcdef/);
    assert.match(label, /… — RelayX — sessions$/);
  });

  it('uses the OpenCode session title as the human-facing worker label', () => {
    const label = describeDiscoveredWorkerChoice({
      kind: 'discovered',
      sessionId: 'ses_abcdef1234567890',
      sessionTitle: 'Fix worker discovery',
      windowTitle: 'RelayX — sessions',
    });
    assert.match(label, /^Fix worker discovery — ses_abcdef/);
    assert.doesNotMatch(label, /RelayX — sessions/);
  });

  it('falls back to the full id when the window title is absent', () => {
    const label = describeDiscoveredWorkerChoice({
      kind: 'discovered',
      sessionId: 'ses_short',
    });
    assert.strictEqual(label, 'ses_short');
  });
});
