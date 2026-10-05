/**
 * RelayX Planner Observer — loopback bridge.
 *
 * ## Why loopback HTTP and not Chrome Native Messaging
 *
 * Native Messaging was the fallback in the brief, not the preference. It requires registering a
 * host in the operating system's native-messaging manifest and running a long-lived host process
 * that speaks a length-prefixed framing protocol. This proof has to move a few hundred bytes
 * from a browser tab to one process on the same machine, and both processes are already running.
 * A 127.0.0.1 HTTP endpoint is the smallest thing that can do that, and it is bound to the
 * loopback interface only.
 *
 * ## What it is for
 *
 *   POST /arm           RelayX arms the observer for one exact conversation
 *   GET  /next          the content script's control-plane poll while disarmed
 *   POST /observation   the observer's structured report
 *   GET  /latest        the most recent observation for a conversation
 *   GET  /all           everything this bridge has seen, in order
 *   GET  /health        liveness
 *
 * Nothing here drives the browser. The bridge has no browser capability at all.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PLANNER_OBSERVER_PORT ?? 8791);
const HOST = '127.0.0.1';

/**
 * Where the append-only observation trail is written.
 *
 * This must live OUTSIDE the RelayX source tree. The dev server watches the project root, and
 * `@tailwindcss/vite` answers *any* change to a file under it with `{ type: 'full-reload' }`,
 * which the Vite client turns into `location.reload()`. Because this bridge appends here on
 * every ChatGPT planner observation, keeping the log inside the repo meant every observation
 * silently reloaded the whole renderer — wiping any in-flight UI (this is what destroyed the
 * Add Project wizard the moment planner discovery started). Runtime output belongs in per-user
 * application data; only source belongs in the repository.
 *
 * `RELAYX_PLANNER_OBSERVER_LOG` overrides the location for anyone who needs it elsewhere.
 */
const LOG_PATH = process.env.RELAYX_PLANNER_OBSERVER_LOG
  ? path.resolve(process.env.RELAYX_PLANNER_OBSERVER_LOG)
  : path.join(
      process.env.HOME || os.homedir(),
      'Library',
      'Application Support',
      'RelayX',
      'planner-observer',
      'observations.jsonl',
    );
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

/** Arms, keyed by the conversation RelayX is delivering to. Only the CURRENT arm per conversation. */
const arms = new Map();
/**
 * Every arm ever created for any conversation, including retired ones.
 *
 * This exists because a completion arrives AFTER its arm stops being current: the bridge retires
 * the arm on `finished`, and the relay's next read happens after that. Without history the
 * finished response would lose its Delivery attribution and be discarded as if it never existed.
 */
const allArms = [];
/** Every observation, in arrival order. */
const observations = [];
const MAX_OBSERVATIONS = 5000;

function json(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Log EVERY inbound request, not just the interesting ones. The control-plane poll
  // (/next) is the heartbeat that proves the extension's content script is alive inside a real
  // tab; without logging it, "extension not loaded" and "extension loaded but silent" look
  // identical from the outside.
  if (url.pathname !== '/health' && url.pathname !== '/all') {
    console.log(`[bridge] <- ${req.method} ${url.pathname}${url.search || ''}`);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'POST /arm': {
        const body = await readBody(req);
        const conversationId = String(body.conversationId ?? '').trim();
        if (!conversationId) return json(res, 400, { ok: false, reason: 'conversationId required' });
        const armId = `arm_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        arms.set(conversationId, {
          armId,
          conversationId,
          // Which Delivery this arm was created for. Scoping completions to it is what stops a
          // finished response being attributed to the NEXT baton: after the baton moves on, an
          // old arm's completion must never be picked up as the new owner's reply.
          deliveryId: String(body.deliveryId ?? '').trim() || null,
          issuedAt: new Date().toISOString(),
          note: body.note ?? null,
          deliveredAt: null,
          consumed: false,
          completed: false,
        });
        allArms.push(arms.get(conversationId));
        console.log(
          `[bridge] ARM ${armId} -> conversation ${conversationId}` +
            (body.note ? ` (${body.note})` : ''),
        );
        return json(res, 200, { ok: true, armId, conversationId });
      }

      case 'GET /next': {
        const conversationId = String(url.searchParams.get('conversationId') ?? '').trim();
        const arm = arms.get(conversationId);
        if (!arm) return json(res, 200, { ok: true, armed: false, reason: 'no arm for this conversation' });
        // One delivery -> one arm -> one completion. Once an arm has produced its completion it
        // must never be handed out again, or the observer would silently re-arm against a stale
        // arm after disarming and treat the NEXT delivery's reply as belonging to this one.
        if (arm.completed) {
          return json(res, 200, {
            ok: true,
            armed: false,
            armId: arm.armId,
            reason: 'this arm already produced its completion; awaiting the next delivery',
          });
        }
        if (!arm.consumed) {
          arm.consumed = true;
          arm.deliveredAt = new Date().toISOString();
          console.log(`[bridge] arm ${arm.armId} delivered to the observer`);
        }
        return json(res, 200, {
          ok: true,
          armed: true,
          armId: arm.armId,
          requestedConversationId: arm.conversationId,
          issuedAt: arm.issuedAt,
          note: arm.note,
        });
      }

      case 'POST /observation': {
        const body = await readBody(req);
        const record = { seq: observations.length + 1, receivedAt: new Date().toISOString(), ...body };
        observations.push(record);
        if (observations.length > MAX_OBSERVATIONS) observations.shift();
        fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);

        // Retire the arm that just produced its completion, so it is never re-delivered.
        if (record.state === 'finished' && record.armId) {
          for (const arm of arms.values()) {
            if (arm.armId === record.armId) {
              arm.completed = true;
              arm.completedAt = record.receivedAt;
              console.log(`[bridge] arm ${arm.armId} completed and retired`);
            }
          }
        }

        const brief =
          `${record.state}` +
          (record.conversationId ? ` conv=${String(record.conversationId).slice(0, 8)}…` : '') +
          (record.responseLength !== undefined ? ` len=${record.responseLength}` : '') +
          (record.reason ? ` reason="${String(record.reason).slice(0, 90)}"` : '');
        console.log(`[bridge] #${record.seq} ${brief}`);
        return json(res, 200, { ok: true, seq: record.seq });
      }

      case 'GET /latest': {
        const conversationId = url.searchParams.get('conversationId');
        const state = url.searchParams.get('state');
        let list = observations;
        if (conversationId) list = list.filter((o) => o.conversationId === conversationId);
        if (state) list = list.filter((o) => o.state === state);
        return json(res, 200, { ok: true, count: list.length, latest: list[list.length - 1] ?? null });
      }

      case 'GET /all': {
        const conversationId = url.searchParams.get('conversationId');
        const list = conversationId
          ? observations.filter((o) => o.conversationId === conversationId)
          : observations;
        return json(res, 200, { ok: true, count: list.length, observations: list });
      }

      case 'GET /health': {
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          port: PORT,
          observations: observations.length,
          arms: Array.from(arms.values()).map((a) => ({
            armId: a.armId,
            conversationId: a.conversationId,
            deliveryId: a.deliveryId ?? null,
            consumed: a.consumed,
            completed: a.completed === true,
          })),
          allArms: allArms.map((a) => ({
            armId: a.armId,
            conversationId: a.conversationId,
            deliveryId: a.deliveryId ?? null,
            completed: a.completed === true,
            issuedAt: a.issuedAt,
          })),
        });
      }

      default:
        return json(res, 404, { ok: false, reason: `no route for ${req.method} ${url.pathname}` });
    }
  } catch (err) {
    return json(res, 500, { ok: false, reason: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] RelayX Planner Observer bridge on http://${HOST}:${PORT}`);
  console.log(`[bridge] appending every observation to ${LOG_PATH}`);
});