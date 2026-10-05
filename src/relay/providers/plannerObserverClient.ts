import http from 'node:http';

/**
 * RelayX -> Planner Observer client.
 *
 * ## What this is
 *
 * The Planner Observer is a Chrome extension content script that watches ONE already-open,
 * already-authenticated ChatGPT Planner conversation. It reports `working` and `finished` and,
 * on finish, the exact new completed response, to a loopback HTTP bridge. This client reads
 * those reports from the bridge on behalf of the relay engine.
 *
 * ## What this deliberately cannot do
 *
 * It has NO browser capability whatsoever: no AppleScript, no AppleScript bridge, no window or
 * tab enumeration, no navigation, no focus, no clicking, and no way to make the Planner tab
 * appear. It speaks HTTP to 127.0.0.1 and nothing else. If the Planner tab is not open, the
 * observer reports `unreadable` and there is no fallback that opens it — that is the point.
 *
 * The only side that may touch the UI is Delivery, which uses the existing AppleScript/UI path.
 */

/** One `finished` report: the new response produced after the arm point. */
export interface PlannerObserverCompletion {
  armId: string;
  conversationId: string;
  responseText: string;
  responseHash: string;
  responseLength: number;
  completedTurnKey: string | null;
  observedAt: string;
  /** True when adopted from an arm the ledger could not resolve (see `status`). */
  adoptedFromUnresolvableArm: boolean;
}

export interface PlannerObserverArm {
  armId: string;
  conversationId: string;
  /** True when an existing unconsumed arm was adopted rather than a new one minted. */
  reused: boolean;
}

export interface PlannerObserverStatus {
  /** False when the bridge could not be reached at all. Never conflated with "no completion". */
  available: boolean;
  unavailableReason: string | null;
  conversationId: string;
  /** The arm currently held for this conversation, if any. */
  armId: string | null;
  armActive: boolean;
  /** True while the observer has reported the Planner as generating. */
  working: boolean;
  /** Present once THIS arm has produced its one completion. */
  completion: PlannerObserverCompletion | null;
  /** Latest observer state string, for the trail: identity|armed|working|finished|unreadable|... */
  lastState: string | null;
  lastObservedAt: string | null;
}

interface RawObservation {
  seq: number;
  state: string;
  armId?: string | null;
  conversationId?: string | null;
  latestCompletedResponse?: string;
  responseHash?: string;
  responseLength?: number;
  completedTurnKey?: string | null;
  observedAt?: string;
  reason?: string;
  generatingControlCount?: number;
  finishedControlCount?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8791';

export class PlannerObserverClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.RELAYX_PLANNER_OBSERVER_URL ?? DEFAULT_BASE_URL)
      // Loopback only. This client must never be constructible against a remote host.
      .replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  private request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request(
        {
          host: '127.0.0.1',
          port: new URL(this.baseUrl).port || 80,
          path,
          method,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {},
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
            } catch (err) {
              reject(new Error(`observer bridge returned unparseable JSON: ${(err as Error).message}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('observer bridge request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async armLedger(conversationId: string): Promise<
    Array<{ armId: string; deliveryId: string | null; completed: boolean; issuedAt: string | null }>
  > {
    const health = await this.request<{
      allArms?: Array<{
        armId: string;
        conversationId: string;
        deliveryId: string | null;
        completed?: boolean;
        issuedAt?: string;
      }>;
      arms?: Array<{ armId: string; conversationId: string; deliveryId?: string | null; completed?: boolean }>;
    }>('GET', '/health');
    const rows = health.allArms ?? health.arms ?? [];
    return rows
      .filter((a) => a.conversationId === conversationId)
      .map((a) => ({
        armId: a.armId,
        deliveryId: a.deliveryId ?? null,
        completed: a.completed === true,
        issuedAt: (a as { issuedAt?: string }).issuedAt ?? null,
      }));
  }

  private async activeArm(conversationId: string): Promise<{ armId: string; completed: boolean } | null> {
    const ledger = await this.armLedger(conversationId);
    const match = ledger.filter((a) => !a.completed).pop() ?? null;
    if (!match) return null;
    return { armId: match.armId, completed: false };
  }

  /**
   * Ensure exactly one arm exists for this exact conversation.
   *
   * Re-arm discipline matters: the observer's baseline is the set of assistant turn keys
   * present at ARM time, so arming again mid-flight would re-baseline OVER a response that has
   * already been produced and would silently lose it. An existing arm that has not yet
   * completed is therefore adopted, never replaced.
   */
  async ensureArmed(conversationId: string, note: string, deliveryId: string): Promise<PlannerObserverArm> {
    const ledger = await this.armLedger(conversationId);
    // Adopt an arm that is still open for THIS Delivery. An arm belongs to exactly one Delivery,
    // so an arm left open by a previous, already-handed-on Delivery must never be reused: it
    // would re-baseline over a response that has already been forwarded.
    const reusable = ledger.filter((a) => !a.completed && a.deliveryId === deliveryId).pop();
    if (reusable) {
      return { armId: reusable.armId, conversationId, reused: true };
    }
    const res = await this.request<{ ok: boolean; armId?: string }>('POST', '/arm', {
      conversationId,
      note,
      deliveryId,
    });
    if (!res.ok || !res.armId) throw new Error('observer bridge refused the arm');
    return { armId: res.armId, conversationId, reused: false };
  }

  /**
   * Read the observer's current view of this conversation. Never throws.
   *
   * A completion is surfaced when it came from an arm this Delivery created — including one whose
   * arm has already been RETIRED. The observer finishes and the bridge retires the arm in the
   * same instant, and the relay's next read is almost always after that, so a status that only
   * looked at the current arm would silently discard the very response it was waiting for.
   */
  async status(conversationId: string, deliveryId: string): Promise<PlannerObserverStatus> {
    const unavailable: PlannerObserverStatus = {
      available: false,
      unavailableReason: null,
      conversationId,
      armId: null,
      armActive: false,
      working: false,
      completion: null,
      lastState: null,
      lastObservedAt: null,
    };
    let observations: RawObservation[];
    let arm: { armId: string; completed: boolean } | null;
    let ledger: Array<{
      armId: string;
      deliveryId: string | null;
      completed: boolean;
      issuedAt: string | null;
    }>;
    try {
      const all = await this.request<{ observations: RawObservation[] }>(
        'GET',
        `/all?conversationId=${encodeURIComponent(conversationId)}`,
      );
      observations = all.observations ?? [];
      ledger = await this.armLedger(conversationId);
      arm = ledger.filter((a) => !a.completed).pop() ?? null;
    } catch (err) {
      return { ...unavailable, unavailableReason: (err as Error).message };
    }

    const latest = observations[observations.length - 1] ?? null;
    // Only a completion produced by an arm THIS Delivery created counts, whether or not that arm
    // is still current. The observer finishing retires its arm in the same instant, and the
    // relay's next read is almost always after that, so a status that only looked at the current
    // arm would silently discard the very response it was waiting for. Exactly-once is then
    // enforced downstream by the durable record event plus `hasCompletedTurnBeenTransferred`.
    const armIdsForThisDelivery = new Set(
      ledger.filter((a) => a.deliveryId === deliveryId).map((a) => a.armId),
    );
    const attributed = observations
      .filter((o) => o.state === 'finished' && o.armId && armIdsForThisDelivery.has(String(o.armId)))
      .pop();

    // A completion whose arm the ledger cannot resolve happens when the observer was armed
    // against an EARLIER bridge process and outlived it. The turn really did complete, so it is
    // adopted — but only if it was observed AFTER this Delivery's arm was issued. That bound is
    // what makes adoption safe: a stale completion necessarily predates any later arm, so it can
    // never be stolen by the NEXT baton.
    const currentArm = ledger.filter((a) => a.deliveryId === deliveryId).pop() ?? null;
    const issuedAtMs = currentArm?.issuedAt ? Date.parse(currentArm.issuedAt) : Number.NaN;
    const unattributed =
      attributed || !Number.isFinite(issuedAtMs)
        ? null
        : (observations
            .filter((o) => {
              if (o.state !== 'finished' || !o.armId) return false;
              if (armIdsForThisDelivery.has(String(o.armId))) return false;
              const at = Date.parse(String(o.observedAt ?? ''));
              return Number.isFinite(at) && at > issuedAtMs;
            })
            .pop() ?? null);

    const finished = attributed ?? unattributed;
    const adopted = !attributed && !!unattributed;

    return {
      available: true,
      unavailableReason: null,
      conversationId,
      armId: arm?.armId ?? null,
      armActive: !!arm && !arm.completed,
      working: observations.some((o) => o.state === 'working' && o.armId === (arm?.armId ?? null)),
      completion: finished
        ? {
            armId: String(finished.armId),
            conversationId,
            responseText: String(finished.latestCompletedResponse ?? ''),
            responseHash: String(finished.responseHash ?? ''),
            responseLength: Number(finished.responseLength ?? 0),
            completedTurnKey: finished.completedTurnKey ?? null,
            observedAt: String(finished.observedAt ?? ''),
            // True when this completion was adopted from an arm the ledger could not resolve.
            // Recorded so the durable trail shows the difference rather than hiding it.
            adoptedFromUnresolvableArm: adopted,
          }
        : null,
      lastState: latest?.state ?? null,
      lastObservedAt: latest?.observedAt ?? null,
    };
  }
}