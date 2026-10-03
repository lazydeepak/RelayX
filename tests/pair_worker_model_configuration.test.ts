/**
 * Pair-scoped Worker Model configuration.
 *
 * ## The semantic this pins
 *
 * The Worker Model selector is PERSISTENT RelayX configuration, not a live
 * mutation of the provider runtime. Choosing a model must be possible while the
 * Pair is IDLE and must cause ZERO provider contact (I-2). The chosen value is
 * applied by the engine at the authorized dispatch boundary, via the SAME
 * `provider_settings` authority as the global and project scopes — a third
 * scope, never a second authority.
 *
 * Resolution order: pair > project > global > first supported free model.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RuntimeSession, Project, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';

const pairViewSource = readFileSync(new URL('../src/components/PairView.tsx', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('../src/components/WorkerModelControl.tsx', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../src/relay/application/RelayEngine.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/relay/application/RelayApiService.ts', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../src/services/relayBridge.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types/relayApi.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(new URL('../electron/ipc/contracts.ts', import.meta.url), 'utf8');
const adaptersSource = readFileSync(new URL('../src/relay/providers/adapters.ts', import.meta.url), 'utf8');

/* ======================================================================== *
 * Static: one authority, no live mutation path.
 * ======================================================================== */
describe('Worker Model is persistent configuration, not a live mutation', () => {
  it('the renderer no longer references the live setSessionModel path anywhere', () => {
    for (const [name, src] of Object.entries({
      PairView: pairViewSource,
      WorkerModelControl: controlSource,
      relayBridge: bridgeSource,
      relayApiTypes: typesSource,
      preload: preloadSource,
      contracts: contractsSource,
      RelayApiService: serviceSource,
      adapters: adaptersSource,
    })) {
      assert.doesNotMatch(src, /setSessionModel/, `${name} must not reference the removed live mutation path`);
    }
    assert.doesNotMatch(pairViewSource, /window as any\)\.relayBridge/);
  });

  it('PairView renders the config control and holds no per-pair model mutation state', () => {
    assert.match(pairViewSource, /<WorkerModelControl pair=\{pair\} \/>/);
    assert.doesNotMatch(pairViewSource, /selectedWorkerModel/);
    assert.doesNotMatch(pairViewSource, /applyWorkerStatus/);
  });

  it('the control writes the SAME provider_settings authority (pair scope) and never contacts a provider', () => {
    assert.match(controlSource, /relayBridge\.getEffectiveModelConfig\('opencode', pair\.projectId, pair\.id\)/);
    assert.match(controlSource, /relayBridge\.setPairModelOverride\(pair\.id, 'opencode', model,/);
    assert.match(controlSource, /relayBridge\.clearPairModelOverride\(pair\.id, 'opencode'\)/);
    // No "apply now" / provider interaction (only the config bridge is called).
    assert.doesNotMatch(controlSource, /relayBridge\.(inspectRuntime|activateRuntime|deliverInstruction|setSessionModel)\(/);
    assert.match(controlSource, /applies at the next dispatch/i);
  });

  it('pair override is wired through every layer', () => {
    assert.match(typesSource, /setPairModelOverride\(pairId: string, providerType: ProviderType, model: string, justification: string\)/);
    assert.match(typesSource, /clearPairModelOverride\(pairId: string, providerType: ProviderType\)/);
    assert.match(bridgeSource, /setPairModelOverride: async \(pairId, providerType, model, justification\)/);
    assert.match(preloadSource, /SET_PAIR_MODEL_OVERRIDE/);
    assert.match(contractsSource, /SET_PAIR_MODEL_OVERRIDE: 'relay:set-pair-model-override'/);
    assert.match(serviceSource, /public async setPairModelOverride\(/);
    assert.match(engineSource, /public async setPairModelOverride\(/);
  });

  it('the delivery boundary resolves the pair scope (pair > project > global)', () => {
    // Both dispatch and continuation delivery pass the pair id.
    const callSites = engineSource.match(/resolveProviderModelOverride\([^)]*pair\.projectId, pair\.id\)/g) ?? [];
    assert.strictEqual(callSites.length, 2, 'both delivery call sites must pass pair.id');
  });
});

/* ======================================================================== *
 * Behaviour: precedence + zero provider contact.
 * ======================================================================== */
class CountingProvider extends MockProvider {
  public calls = 0;
  private count() {
    this.calls++;
  }
  async findRuntime(d: any) { this.count(); return super.findRuntime(d); }
  async findAllRuntimes() { this.count(); return super.findAllRuntimes(); }
  async matchSessionsByPath(p: any, g?: any) { this.count(); return super.matchSessionsByPath(p, g); }
  async inspectRuntime(id: any) { this.count(); return super.inspectRuntime(id); }
  async activateRuntime(id: any) { this.count(); return super.activateRuntime(id); }
  async deliverInstruction(r: any) { this.count(); return super.deliverInstruction(r); }
  async detectWorkingState(id: any) { this.count(); return super.detectWorkingState(id); }
  async detectCompletionState(id: any) { this.count(); return super.detectCompletionState(id); }
  async captureEvidence(id: any, a: any) { this.count(); return super.captureEvidence(id, a); }
}

function createTestService() {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  const opencode = new CountingProvider('opencode');
  engine.registerProvider(opencode);
  engine.registerProvider(new MockProvider('chatgpt'));
  const service = new RelayApiService(db, engine);
  return { service, db, engine, opencode };
}

async function seedIdlePair(db: SqliteRelayDatabase, engine: RelayEngine) {
  const project = Project.create('pair-model', '', '/dev/pair-model', '/dev/pair-model');
  await db.projects.save(project);

  const planner = RuntimeSession.create('chatgpt', 'Planner');
  planner.updateExternalIdentity('conv_pm', 'https://chatgpt.com/g/g-p-pm');
  await db.runtimes.save(planner);

  const worker = RuntimeSession.create('opencode', 'Worker');
  worker.updateExternalIdentity('ses_pm', '/dev/pair-model');
  await db.runtimes.save(worker);

  await db.associations.save(
    RuntimeProjectAssociation.create(planner.id, project.id, 'conv_pm', 'verified', 'discovery', 'chatgpt'),
  );
  await db.associations.save(
    RuntimeProjectAssociation.create(worker.id, project.id, 'ses_pm', 'verified', 'discovery', 'opencode'),
  );

  const pair = await engine.createPair(project.id, 'Pair Model Pair', planner.id, worker.id);
  return { project, planner, worker, pair };
}

describe('Pair-scoped worker model resolution', () => {
  it('pair override wins over project and global', async () => {
    const { service } = createTestService();

    await service.setGlobalModelDefault('opencode', 'openrouter/free');
    await service.setProjectModelOverride('proj_1', 'opencode', 'thinking-machines/inkling:free', 'project reason');
    await service.setPairModelOverride('pair_1', 'opencode', 'google/gemini-2.5-flash:free', 'pair reason');

    const config = await service.getEffectiveModelConfig('opencode', 'proj_1', 'pair_1');
    assert.strictEqual(config.effectiveModel, 'google/gemini-2.5-flash:free');
    assert.strictEqual(config.isPairOverride, true);
    assert.strictEqual(config.pairOverride, 'google/gemini-2.5-flash:free');
  });

  it('clearing the pair override reverts to the project override, then the global default', async () => {
    const { service } = createTestService();

    await service.setGlobalModelDefault('opencode', 'openrouter/free');
    await service.setProjectModelOverride('proj_2', 'opencode', 'thinking-machines/inkling:free', 'project reason');
    await service.setPairModelOverride('pair_2', 'opencode', 'google/gemini-2.5-flash:free', 'pair reason');

    await service.clearPairModelOverride('pair_2', 'opencode');
    let config = await service.getEffectiveModelConfig('opencode', 'proj_2', 'pair_2');
    assert.strictEqual(config.effectiveModel, 'thinking-machines/inkling:free', 'falls back to project override');
    assert.strictEqual(config.isPairOverride, false);

    await service.clearProjectModelOverride('proj_2', 'opencode');
    config = await service.getEffectiveModelConfig('opencode', 'proj_2', 'pair_2');
    assert.strictEqual(config.effectiveModel, 'openrouter/free', 'falls back to global default');
  });

  it('the execution resolver applies the same precedence the delivery boundary uses', async () => {
    const { service, engine } = createTestService();

    await service.setGlobalModelDefault('opencode', 'openrouter/free');
    await service.setProjectModelOverride('proj_3', 'opencode', 'thinking-machines/inkling:free', 'project reason');
    await service.setPairModelOverride('pair_3', 'opencode', 'google/gemini-2.5-flash:free', 'pair reason');

    assert.strictEqual(
      await engine.resolveProviderModelOverride('opencode', 'proj_3' as any, 'pair_3' as any),
      'google/gemini-2.5-flash:free',
    );
    assert.strictEqual(
      await engine.resolveProviderModelOverride('opencode', 'proj_3' as any),
      'thinking-machines/inkling:free',
    );
    assert.strictEqual(await engine.resolveProviderModelOverride('opencode'), 'openrouter/free');
  });

  it('an unsupported pair value does not silently win; the resolver ignores it', async () => {
    const { service, engine } = createTestService();
    await service.setGlobalModelDefault('opencode', 'openrouter/free');
    await service.setPairModelOverride('pair_4', 'opencode', 'not/a-real-model', 'typo');

    assert.strictEqual(await engine.resolveProviderModelOverride('opencode', undefined, 'pair_4' as any), 'openrouter/free');
  });

  it('choosing a model while the Pair is IDLE causes ZERO provider contact', async () => {
    const { service, db, engine, opencode } = createTestService();
    const { project, pair } = await seedIdlePair(db, engine);

    const stored = (await db.pairs.findAll())[0];
    assert.strictEqual(stored.operationalState, 'IDLE', 'the fixture pair must start IDLE');

    opencode.calls = 0;
    await service.setPairModelOverride(pair.id, 'opencode', 'google/gemini-2.5-flash:free', 'selected while IDLE');
    await service.getEffectiveModelConfig('opencode', project.id, pair.id);
    await service.clearPairModelOverride(pair.id, 'opencode');

    assert.strictEqual(
      opencode.calls,
      0,
      `I-2: configuring the model must not contact the provider while IDLE, saw ${opencode.calls} call(s)`,
    );
    assert.strictEqual((await db.pairs.findAll())[0].operationalState, 'IDLE');
    db.close();
  });
});
