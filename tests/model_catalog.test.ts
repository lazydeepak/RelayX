import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseCatalog, refreshCatalog, CATALOG_URLS } from '../src/relay/model-intelligence/catalog';

const raw = JSON.stringify({ data: [{ id: 'vendor/model:free', name: 'Model', pricing: { prompt: '0', completion: '0.00000000000000000001' }, supported_parameters: ['tools'] }] });
const snapshot = () => parseCatalog('OPENROUTER', raw, 100, '"v1"');
const signal = () => AbortSignal.timeout(1000);
describe('public catalog discovery', () => {
  it('preserves prices exactly, raw evidence and provenance without creating authorization', () => {
    const value = snapshot();
    assert.equal(value.rawBody, raw);
    assert.equal(value.contentHash, createHash('sha256').update(raw).digest('hex'));
    assert.deepEqual(value.models[0].publishedPricing, { prompt: '0', completion: '0.00000000000000000001' });
    assert.equal(value.models[0].provenance.sourceUrl, CATALOG_URLS.OPENROUTER);
    assert.equal('verdict' in value.models[0], false);
    assert.equal('accountId' in value.models[0], false);
  });
  it('retains unknown pricing rather than guessing free from an alias', () => {
    const value = parseCatalog('OPENROUTER', JSON.stringify({ data: [{ id: 'auto:free' }] }), 1);
    assert.equal(value.models[0].publishedPricing, null);
  });
  it('does not conflate a Models.dev provider with a model vendor', () => {
    const value = parseCatalog('MODELS_DEV', JSON.stringify({ gateway: { id: 'gateway', api: 'https://gateway.example/v1', models: { 'vendor/model': { id: 'vendor/model', cost: { input: 0, output: 1 }, tool_call: true } } } }), 100);
    assert.equal(value.models[0].providerId, 'gateway');
    assert.equal(value.models[0].publishedModelId, 'vendor/model');
    assert.equal(value.models[0].endpointId, 'https://gateway.example/v1');
    assert.deepEqual(value.models[0].publishedPricing, { input: 0, output: 1 });
  });
  it('excludes conflicting Models.dev identities and missing endpoints', () => {
    const value = parseCatalog('MODELS_DEV', JSON.stringify({ one: { api: 'https://one.example', models: { x: { id: 'y' } } }, two: { models: { x: { id: 'x' } } } }), 1);
    assert.equal(value.models.length, 0);
    assert.deepEqual(value.warnings, ['CONFLICTING_MODEL_ID', 'MISSING_PROVIDER_ENDPOINT:two']);
  });
  it('rejects ambiguous duplicates rather than choosing the cheaper record', () => {
    assert.throws(() => parseCatalog('OPENROUTER', JSON.stringify({ data: [{ id: 'x' }, { id: 'x', pricing: { prompt: '0' } }] }), 1), /Duplicate/);
  });
  for (const body of ['null', '{}', '{"data":{}}', 'not json']) {
    it(`rejects invalid envelope ${body}`, () => assert.throws(() => parseCatalog('OPENROUTER', body, 1)));
  }
  it('reports invalid rows without manufacturing identities', () => {
    const value = parseCatalog('OPENROUTER', '{"data":[null,{}, {"id":"ok"}]}', 1);
    assert.deepEqual(value.models.map(model => model.publishedModelId), ['ok']);
    assert.deepEqual(value.warnings, ['INVALID_MODEL', 'MISSING_IDENTITY']);
  });
  it('refreshes via a credential-free public GET and captures ETag', async () => {
    const abort = signal();
    const result = await refreshCatalog('OPENROUTER', { now: 200, signal: abort, fetch: (async (url, init) => {
      assert.equal(url, CATALOG_URLS.OPENROUTER);
      assert.equal(init?.method, 'GET'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      assert.equal(init?.signal, abort); assert.equal(init?.body, undefined);
      assert.deepEqual(init?.headers, { Accept: 'application/json' });
      return new Response(raw, { headers: { etag: '"v2"' } });
    }) as typeof fetch });
    assert.equal(result.status, 'UPDATED'); assert.equal(result.snapshot?.etag, '"v2"');
  });
  it('304 updates check time without rewriting evidence or original fetch time', async () => {
    const previous = snapshot(); const before = structuredClone(previous);
    const result = await refreshCatalog('OPENROUTER', { previous, now: 200, signal: signal(), fetch: (async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>)['If-None-Match'], '"v1"');
      return new Response(null, { status: 304 });
    }) as typeof fetch });
    assert.equal(result.status, 'NOT_MODIFIED');
    assert.equal(result.snapshot?.fetchedAt, 100); assert.equal(result.snapshot?.checkedAt, 200);
    assert.equal(result.snapshot?.rawBody, raw); assert.deepEqual(previous, before);
  });
  for (const status of [402, 429, 500]) {
    it(`retains stale browsing evidence on HTTP ${status}`, async () => {
      const previous = snapshot();
      const result = await refreshCatalog('OPENROUTER', { previous, now: 200, signal: signal(), fetch: (async () => new Response('private error', { status })) as typeof fetch });
      assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.snapshot, previous);
      assert.equal(result.snapshot?.checkedAt, 100); assert.equal(JSON.stringify(result).includes('private error'), false);
    });
  }
  it('keeps cache on malformed successful response', async () => {
    const previous = snapshot();
    const result = await refreshCatalog('OPENROUTER', { previous, now: 200, signal: signal(), fetch: (async () => new Response('{}')) as typeof fetch });
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.snapshot, previous);
  });
  it('cannot borrow another source cache', async () => {
    await assert.rejects(refreshCatalog('MODELS_DEV', { previous: snapshot(), now: 200, signal: signal(), fetch }), /Cache source mismatch/);
  });
  it('rejects a clock rollback instead of claiming a new refresh', async () => {
    await assert.rejects(refreshCatalog('OPENROUTER', { previous: snapshot(), now: 99, signal: signal(), fetch }), /clock moved backwards/);
  });
  it('does not accept 304 without a cache', async () => {
    const result = await refreshCatalog('OPENROUTER', { now: 200, signal: signal(), fetch: (async () => new Response(null, { status: 304 })) as typeof fetch });
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.snapshot, undefined);
  });
  it('does not expose transport errors or mark failed refresh current', async () => {
    const previous = snapshot();
    const result = await refreshCatalog('OPENROUTER', { previous, now: 200, signal: signal(), fetch: (async () => { throw new Error('sensitive transport error'); }) as typeof fetch });
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.snapshot, previous);
    assert.equal(JSON.stringify(result).includes('sensitive transport'), false);
  });
});
