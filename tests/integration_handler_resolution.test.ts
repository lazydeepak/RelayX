import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';
import { ChatGPTAppHandler } from '../src/relay/integrations/handlers/ChatGPTAppHandler.ts';
import { IntegrationManager } from '../src/relay/integrations/IntegrationManager.ts';

const CONV = '6ac1a7c4-7b40-83ec-ba40-86180675f217';
const EXACT = `https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/c/${CONV}`;

function buildDbWithRuntime() {
  const db = new MemoryRelayDatabase();
  (db.runtimes as any).save = async () => {};
  (db.runtimes as any).findById = async () => ({
    id: 'rt1', providerType: 'chatgpt', name: 'planner',
    sessionUrl: EXACT, externalSessionId: CONV,
    updateExternalIdentity() {}, updatedAt: Date.now(), createdAt: Date.now(),
  });
  return db;
}

describe('IntegrationManager registration paths expose the ChatGPT opener', () => {
  it('seed/default path registers a ChatGPTAppHandler under "chatgpt" with openSession', async () => {
    const db = buildDbWithRuntime();
    // no providerSettings savedConfigs -> seed path
    const m = new IntegrationManager(db as any, new RelayEngine(db as any) as any);
    await m.initialize();
    const h = m.getHandler('chatgpt');
    assert.ok(h, 'seed path must register a handler for chatgpt');
    assert.ok(h instanceof ChatGPTAppHandler, 'expected ChatGPTAppHandler, got ' + h.constructor.name);
    assert.equal(typeof (h as any).openSession, 'function');
  });

  it('saved-config path (chatgpt) also yields ChatGPTAppHandler + openSession', async () => {
    const db = buildDbWithRuntime();
    const cfg = [{ id: 'chatgpt', name: 'ChatGPT', enabled: true }];
    (db.providerSettings as any).get = async () => ({ value: JSON.stringify(cfg) });
    const m = new IntegrationManager(db as any, new RelayEngine(db as any) as any);
    await m.initialize();
    const h = m.getHandler('chatgpt');
    assert.ok(h, 'saved-config path must register a handler for chatgpt');
    assert.ok(h instanceof ChatGPTAppHandler, 'expected ChatGPTAppHandler, got ' + h.constructor.name);
    assert.equal(typeof (h as any).openSession, 'function');
  });

  it('an unrelated saved config must not silently become the chatgpt handler', async () => {
    const db = buildDbWithRuntime();
    (db.providerSettings as any).get = async () => ({ value: JSON.stringify([{ id: 'not_chatgpt', enabled: true }]) });
    const m = new IntegrationManager(db as any, new RelayEngine(db as any) as any);
    await m.initialize();
    assert.equal(m.getHandler('chatgpt'), undefined, 'no silent fallback registration');
  });

  it('wrong provider key does not resolve the chatgpt handler (no key normalisation leak)', async () => {
    const db = buildDbWithRuntime();
    const m = new IntegrationManager(db as any, new RelayEngine(db as any) as any);
    await m.initialize();
    assert.ok(m.getHandler('chatgpt'));
    assert.equal(m.getHandler('ChatGPT'), undefined, 'lookup must be exact, not case-insensitive fallback');
  });

  it('default and saved-config paths produce equivalent handler capability', async () => {
    const dbA = buildDbWithRuntime();
    const mA = new IntegrationManager(dbA as any, new RelayEngine(dbA as any) as any);
    await mA.initialize();
    const dbB = buildDbWithRuntime();
    (dbB.providerSettings as any).get = async () => ({ value: JSON.stringify([{ id: 'chatgpt', enabled: true }]) });
    const mB = new IntegrationManager(dbB as any, new RelayEngine(dbB as any) as any);
    await mB.initialize();
    const cap = (m: IntegrationManager) => Object.getOwnPropertyNames(Object.getPrototypeOf(m.getHandler('chatgpt')!)).sort();
    assert.deepEqual(cap(mA), cap(mB), 'both registration paths must yield the same capability surface');
  });
});

describe('openRuntimeSession resolves the handler without prior Integrations-tab visit', () => {
  it('initializes the IntegrationManager, so a healthy planner resolves its opener', async () => {
    const db = buildDbWithRuntime();
    const engine = new RelayEngine(db as any);
    engine.registerProvider(new ChatGPTProvider());
    const service = new RelayApiService(db as any, engine);
    // Deliberately do NOT call listIntegrations() first.
    const before = service.integrationManager.getHandler('chatgpt');
    assert.equal(before, undefined, 'precondition: handlers are not yet registered');

    const res: any = await service.openRuntimeSession('rt1');
    // It must NOT be the old "no handler" failure any more.
    assert.doesNotMatch(String(res.error ?? ''), /No integration handler exposes/);
    const after = service.integrationManager.getHandler('chatgpt');
    assert.ok(after, 'openRuntimeSession must leave the manager initialized');
    assert.equal(typeof (after as any).openSession, 'function');
  });
});
