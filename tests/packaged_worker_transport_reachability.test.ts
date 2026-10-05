import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  OpenCodeSessionClient,
  OpenCodeServiceError,
  type FetchLike,
} from '../src/relay/providers/opencodeSessionClient.ts';

/**
 * REGRESSION GUARD — packaged-app exact-session transcript reachability.
 *
 * Proven failure this locks down:
 *   pair   pair_mut4l0sg_kypfzefr
 *   worker runtime_mut4l0fj_vyw6ljyb  externalSessionId ses_efb889309ffehTlDbrTHrPzewA
 *   delivery deliv_mut4orr7_bk4aud89 -> status=ambiguous
 *
 * Root cause: the packaged main process could not open a loopback TCP connection
 * to the OpenCode shared service registered in ~/.local/state/opencode/service.json,
 * because the hardened-runtime signature lacked com.apple.security.network.client.
 * Planner (AppleScript) kept working, so the failure looked transport-specific.
 *
 * These tests assert the two halves that were independently wrong:
 *   (1) signing/entitlement layer — network.client must be present
 *   (2) transcript layer — a web-app HTML body must never satisfy the session API
 */

const ENTITLEMENTS = new URL('../electron/entitlements.mac.plist', import.meta.url);
const PKG = new URL('../package.json', import.meta.url);

describe('packaged entitlements: loopback reachability for the worker service', () => {
  it('requests com.apple.security.network.client so the main process can reach the OpenCode service', () => {
    const plist = readFileSync(ENTITLEMENTS, 'utf8');
    assert.match(
      plist,
      /com\.apple\.security\.network\.client/,
      'electron/entitlements.mac.plist must request com.apple.security.network.client; ' +
        'without it the hardened-runtime signature denies the loopback TCP connect and every ' +
        'exact-session transcript read fails with "fetch failed".',
    );
  });

  it('keeps the automation entitlement needed for planner Chrome/AppleScript observation', () => {
    const plist = readFileSync(ENTITLEMENTS, 'utf8');
    assert.match(plist, /com\.apple\.security\.automation\.apple-events/);
  });

  it('does not ship an unsigned/adhoc expectation in the packaging config', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
    // Hardened runtime must stay on; disabling it is not an acceptable substitute
    // for the network entitlement.
    assert.equal(pkg.build?.mac?.hardenedRuntime, true);
  });
});

describe('exact-session transcript read rejects a web-app HTML surface', () => {
  const baseUrl = 'http://127.0.0.1:65535';
  const sessionId = 'ses_efb889309ffehTlDbrTHrPzewA';

  const htmlFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    // What the OpenCode *web UI* server returns for an API path: the SPA shell.
    text: async () =>
      '<!doctype html><html lang="en"><head><title>OpenCode</title></head></html>',
    json: async () => {
      throw new Error('not json');
    },
  });

  it('does not treat an HTML page as a successful session read', async () => {
    const client = new OpenCodeSessionClient({
      baseUrl,
      password: 'irrelevant',
      fetchImpl: htmlFetch,
    });

    await assert.rejects(
      () => client.getSession(sessionId),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeServiceError);
        // The specific failure class must be a malformed/unusable payload,
        // never a silent success that would let a delivery be called delivered.
        assert.ok(
          /malformed|unexpected|invalid/i.test(
            `${err.code ?? ''} ${err.message}`,
          ),
          `expected a malformed-payload rejection, got: ${err.code ?? ''} ${err.message}`,
        );
        return true;
      },
    );
  });

  it('still authenticates and targets the exact external session id', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const captureFetch: FetchLike = async (url, init) => {
      seen.push({
        url,
        auth: (init.headers as Record<string, string> | undefined)?.Authorization,
      });
      return { ok: true, status: 200, text: async () => '{"data":[]}', json: async () => ({ data: [] }) };
    };

    const client = new OpenCodeSessionClient({
      baseUrl,
      password: 'pw',
      fetchImpl: captureFetch,
    });
    await client.getSession(sessionId).catch(() => undefined);

    assert.equal(seen.length, 1);
    assert.ok(
      seen[0].url.endsWith(`/api/session/${encodeURIComponent(sessionId)}`),
      `exact session must be addressed by id, got ${seen[0].url}`,
    );
    assert.match(String(seen[0].auth), /^Basic /);
  });
});

describe('ambiguity is preserved when the transcript genuinely cannot be read', () => {
  it('surfaces service_unreachable rather than asserting delivered', async () => {
    const client = new OpenCodeSessionClient({
      baseUrl: 'http://127.0.0.1:65535',
      password: 'pw',
      fetchImpl: async () => {
        // Exactly what the packaged app produced: a connect-level failure.
        throw Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      },
    });

    await assert.rejects(
      () => client.getSession('ses_efb889309ffehTlDbrTHrPzewA'),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeServiceError);
        assert.equal(err.code, 'service_unavailable');
        // Blind-resend protection depends on this staying unavailable, never delivered.
        assert.doesNotMatch(err.message, /delivered/i);
        return true;
      },
    );
  });

  it('rejects auth failure distinctly so a wrong password is not read as empty transcript', async () => {
    const client = new OpenCodeSessionClient({
      baseUrl: 'http://127.0.0.1:65535',
      password: 'wrong',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '', json: async () => ({}) }),
    });

    await assert.rejects(
      () => client.getSession('ses_efb889309ffehTlDbrTHrPzewA'),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeServiceError);
        assert.equal(err.code, 'authentication_failed');
        return true;
      },
    );
  });
});