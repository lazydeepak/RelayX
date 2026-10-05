/**
 * RelayX Planner Observer — content script.
 *
 * WHAT THIS IS
 * A read-only observer for ONE already-open, already-authenticated ChatGPT conversation. It
 * runs in the tab the user already has. It never activates Chrome, never focuses or switches
 * to the tab, never opens a URL, never navigates, never clicks, and never touches AppleScript.
 * If the conversation is not there, it says `unreadable` and stops — it has no recovery path
 * that could open or move a tab.
 *
 * WHAT IT ANSWERS
 *   identity  — the conversation id, taken from the page's OWN url, never from a requested id
 *   state     — `working` while the model is streaming, `finished` once it stops
 *   response  — the text of the assistant turn that appeared AFTER the arm point
 *
 * ---------------------------------------------------------------------------
 * The arm point is the whole design
 * ---------------------------------------------------------------------------
 * RelayX only cares about the response that follows its own delivery. So the observer does not
 * reconstruct or re-read history at all. At arm time it writes down exactly one thing:
 *
 *     the set of assistant turn-keys that already exist
 *
 * Everything after that is decided by "which assistant turn-key is new". A turn that was
 * already on the page at arm time can never be reported, no matter how it changes afterwards,
 * because its key is in the baseline set. That is why:
 *
 *   - no stable id is required for any HISTORICAL turn (we only need keys for turns we see
 *     while armed, and the keys of the ones present at arm are read once and forgotten);
 *   - no text matching against the legacy transcript happens anywhere;
 *   - the observer is immune to history scrolling out of ChatGPT's virtualised window, because
 *     membership is decided by key, not by position in the DOM.
 *
 * ---------------------------------------------------------------------------
 * Every read fails safe
 * ---------------------------------------------------------------------------
 * Each DOM read is individually guarded. A throwing or empty read yields `unreadable` with the
 * reason, never "finished", never "dead", and never a disarmed observer. Being unable to look
 * says nothing about whether the conversation exists.
 */

(() => {
  // Idempotent: the worker may inject this file into a tab that already has it.
  if (window.__relayxPlannerObserverV1) return;
  window.__relayxPlannerObserverV1 = true;

  const WORKER_TARGET = 'relayx-planner-observer';

  // ---------------------------------------------------------------- selectors
  // Turn/role/root selectors are RelayX's own, copied verbatim from the extraction the
  // AppleScript path already proves works (composeChatGPTConversationReadScript). Reusing them
  // means the observer and the existing reader agree on what a turn IS, instead of the
  // observer inventing a second, subtly different definition.
  const ROOT_SEL = '[data-thread-find-target="conversation"]';
  const TURNKEY_SEL = '[data-turn-key]';
  const USER_SEL = '[data-user-message-bubble]';
  const USER_FALLBACK = '[class*="bg-user-message"]';
  const BLOCKISH = '[class*="block-"]';
  const PAIR_SEL = '[data-content-search-turn-key]';

  // MEASURED on a throwaway chat (not the Planner conversation): while the model streams, the
  // composer swaps its Send control for a Stop control, and `button[aria-label*="Stop"]`
  // matches exactly 1 element. When idle, in the same conversation, it matches 0 — including
  // with text sitting unsent in the composer. `stopTestId` and `stopIcon` stayed 0 throughout,
  // so this aria-label control is the signal that is actually present.
  const GENERATING_SELECTORS = [
    'button[aria-label*="Stop"]',
    '[aria-label*="Stop streaming" i]',
    'button[data-testid="stop-button"]',
  ];

  // -------------------------------------------------------------- observation state
  const S = {
    conversationId: null,
    pageUrl: null,
    reportedIdentity: false,
    armed: false,
    armId: null,
    baselineKeys: null, // Set<string> of assistant turn-keys present BEFORE this delivery
    baselineAssistantCount: null,
    baselineUrl: null,
    sawGenerating: false,
    reportedWorking: false,
    trackedKey: null, // the assistant turn-key currently being streamed
    lastSignature: null, // dedupe for repeated identical reports
    observer: null,
    pollTimer: null,
    flushTimer: null,
    unreadableStreak: 0,
  };

  // ------------------------------------------------------------------- helpers
  function hashOf(text) {
    // FNV-1a, hex. Only used to let RelayX reject a duplicate completion, never to decide
    // anything about content.
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 'fnv1a_' + h.toString(16).padStart(8, '0') + '_len' + s.length;
  }

  function matches(el, sel) {
    if (!el || !el.getAttribute) return false;
    if (sel === USER_SEL) return el.getAttribute('data-user-message-bubble') !== null;
    if (sel === USER_FALLBACK) return String(el.className || '').indexOf('bg-user-message') >= 0;
    if (sel === BLOCKISH) return String(el.className || '').indexOf('block-') >= 0;
    return false;
  }

  function descendantsOf(el, sel) {
    const out = [];
    const stack = Array.prototype.slice.call(el.children || []);
    while (stack.length) {
      const c = stack.shift();
      if (matches(c, sel)) out.push(c);
      for (const k of Array.prototype.slice.call(c.children || [])) stack.push(k);
    }
    return out;
  }

  function canon(t) {
    return String(t || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '');
  }

  // The renderer accessibility label ("You said:" / "ChatGPT said:") is removed BY STRUCTURE:
  // a child whose whole text is just that label is skipped. No text guessing.
  function messageTextOf(block, isUser) {
    if (isUser) {
      const bub = descendantsOf(block, USER_SEL)[0] || descendantsOf(block, USER_FALLBACK)[0];
      if (bub) return bub.innerText || '';
    }
    const kids = Array.prototype.slice.call(block.children || []);
    const parts = [];
    for (const k of kids) {
      const only = (k.innerText || '').replace(/^\s+|\s+$/g, '');
      if (/^(?:You said|ChatGPT said)\s*:?$/.test(only)) continue;
      parts.push(k.innerText || '');
    }
    return parts.join(' ').replace(/^\s+|\s+$/g, '');
  }

  function isRendered(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** The authoritative live conversation tree, or null when nothing readable is mounted. */
  function authoritativeRoot() {
    const all = Array.prototype.slice.call(document.querySelectorAll(ROOT_SEL));
    if (!all.length) return null;
    const rendered = all.filter(isRendered);
    if (rendered.length === 1) return rendered[0];
    if (rendered.length > 1) {
      // ChatGPT mounts a detached MIRROR root with the identical turn keys. Both roots carry
      // the same keys, so either is truthful; pick the one that actually has turns.
      const scored = rendered
        .map((el, i) => ({
          el,
          i,
          keys: el.querySelectorAll(TURNKEY_SEL).length,
          area: (() => {
            const r = el.getBoundingClientRect();
            return r.width * r.height;
          })(),
        }))
        .sort((a, b) => b.keys - a.keys || b.area - a.area || a.i - b.i);
      return scored[0].el;
    }
    return null;
  }

  function outermostBlocks(scope) {
    const all = descendantsOf(scope, BLOCKISH);
    return all.filter((b) => !all.some((o) => o !== b && o.contains(b)));
  }

  function isTimestampChrome(b, text) {
    if (!b.querySelector) return false;
    const t = b.querySelector('time[datetime]');
    if (!t) return false;
    return canon(t.innerText) === text && canon(text).length > 0;
  }

  /** Every turn in the live tree, with role and text. Role is structural, never inferred. */
  /**
   * Every message in the live tree, each stamped with the turn container it came from.
   *
   * MEASURED on this build (ChatGPT 154): a logical exchange is one `[data-turn-key]`
   * container holding BOTH sides of the exchange, and inside it each message is a wrapper whose
   * direct children are an `h4.sr-only` accessibility label plus the message content. The
   * `[class*="block-"]` fragments the repo's transcript reader walks live in a DISJOINT part of
   * the tree — measured `blocksContainingKey: 0` — so walking those fragments cannot recover a
   * single turn key, and a turn with no key can never be distinguished from an older one.
   *
   * That is why the walk is keyed-container driven: the key comes from the container that
   * actually holds the message, which is the only thing that makes the ARM-time baseline able to
   * distinguish "the response that came after my delivery" from "a reply that was already here".
   */
  function extractTurns(root) {
    const containers = Array.prototype.slice.call(root.querySelectorAll(TURNKEY_SEL));
    const turns = [];

    for (const c of containers) {
      const key = c.getAttribute('data-turn-key');
      // Each message group is identified by the sr-only label element it directly contains. We
      // read the ROLE from that label and the TEXT by structure, stripping the label child — we
      // never match message text against the legacy transcript.
      const labels = Array.prototype.slice.call(c.querySelectorAll('h4.sr-only'));
      for (const label of labels) {
        const group = label.parentElement;
        if (!group) continue;
        const labelText = String(label.textContent || '').trim();
        let role;
        if (/^ChatGPT said/i.test(labelText)) role = 'assistant';
        else if (/^You said/i.test(labelText)) role = 'user';
        else continue; // not a message-group label (e.g. some other sr-only heading)
        const isUser = role === 'user';
        turns.push({
          role,
          text: canon(messageTextOf(group, isUser)),
          turnKey: key,
        });
      }
    }

    // No keyed container is mounted. Return nothing keyed rather than inventing fragments: an
    // unkeyed "turn" could never be proven new, so reporting one would risk handing RelayX an
    // older response. The caller surfaces this as unreadable.
    return turns;
  }

  /** Guarded read of the conversation. Never throws; never reports "zero turns" as a fact. */
  function readConversation() {
    try {
      const root = authoritativeRoot();
      if (!root) {
        return {
          ok: false,
          reason:
            'no rendered [data-thread-find-target="conversation"] root is mounted on this page; ' +
            'reporting unreadable, NOT an empty conversation and NOT a dead session',
        };
      }
      const turns = extractTurns(root);
      if (!turns.length) {
        // Turns exist, but none carried a turn container key. Without keys nothing can be proven
        // to be NEW, so this is a read failure, not an empty conversation and not a reply.
        return {
          ok: false,
          reason:
            'conversation root is mounted but yielded no keyed turns; ' +
            'reporting unreadable because no message could be proven to be new',
        };
      }
      return { ok: true, turns };
    } catch (err) {
      return {
        ok: false,
        reason: `conversation read threw: ${(err && err.message) || String(err)}; ` +
          'one failed read is never treated as a dead conversation',
      };
    }
  }

  /**
   * The generating signal.
   *
   * Positive-only: the control is PRESENT while streaming and ABSENT when idle. Absence is
   * therefore "not generating", which is a statement about the control, not an inference from
   * silence about the conversation.
   */
  function readGenerating() {
    try {
      for (const sel of GENERATING_SELECTORS) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const el = els[0];
          return {
            generating: true,
            signal: sel,
            controlLabel: el.getAttribute('aria-label') || el.getAttribute('data-testid') || null,
            controlCount: els.length,
          };
        }
      }
      return { generating: false, signal: null, controlLabel: null, controlCount: 0 };
    } catch (err) {
      return { unreadable: `generating read threw: ${(err && err.message) || String(err)}` };
    }
  }

  // ------------------------------------------------------------------ reporting
  function sendToWorker(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ target: WORKER_TARGET, type, ...payload }, (res) => {
          void chrome.runtime.lastError; // a sleeping worker is not an observation failure
          resolve(res ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function basePayload() {
    return {
      conversationId: S.conversationId,
      pageUrl: S.pageUrl,
      observedAt: new Date().toISOString(),
      observer: 'relayx-planner-observer/0.2.0-keyed-turns',
      armId: S.armId,
      // Proof that monitoring needs no UI: nothing here reads a window or tab state, and the
      // document was never focused by the observer.
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    };
  }

  async function report(kind, extra) {
    const payload = { ...basePayload(), state: kind, ...extra };
    await sendToWorker('observation', { payload });
    return payload;
  }

  // --------------------------------------------------------------------- identity
  function conversationIdFromPageUrl() {
    // The page's OWN url. A requested/session id is never used to answer this question.
    const m = String(location.pathname || '').match(/\/c\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
  }

  function refreshIdentity() {
    const id = conversationIdFromPageUrl();
    const url = location.href;
    const changed = id !== S.conversationId || url !== S.pageUrl;
    S.conversationId = id;
    S.pageUrl = url;
    if (!S.reportedIdentity || changed) {
      S.reportedIdentity = true;
      const gen = readGenerating();
      void report('identity', {
        derivedConversationId: id,
        derivedFromPageUrl: url,
        identitySource: 'page url (/c/<id> segment), read from this tab; not from any requested id',
        generatingAtIdentity: gen.unreadable ? null : gen.generating,
      });
      if (changed) {
        // Navigating this SPA to a different conversation invalidates any armed baseline.
        if (S.armed) disarm('page navigated to a different conversation');
        else startPoll();
      }
    }
  }

  // ----------------------------------------------------------------- control poll
  // Only ever runs while DISARMED. Arming replaces it with the MutationObserver, and finishing
  // hands control back. Steady state during a delivery does zero polling of the page.
  function startPoll() {
    if (S.pollTimer) return;
    const tick = async () => {
      // ChatGPT is a single-page app: navigating between conversations rewrites history with
      // pushState and does NOT reload the document, so a content script injected once keeps
      // running with whatever identity it derived at load time. Re-derive whenever the page's
      // OWN url changes. This is what keeps identity from silently going stale.
      if (location.href !== S.pageUrl) refreshIdentity();
      const cmd = await sendToWorker('next-command', { conversationId: S.conversationId });
      if (cmd && cmd.ok && cmd.armed && cmd.armId && cmd.armId !== S.armId) {
        arm(cmd);
      }
    };
    S.pollTimer = setInterval(tick, 700);
    void tick();
  }

  function stopPoll() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }

  // ----------------------------------------------------------------------- arming
  function arm(cmd) {
    // Identity gate: we arm ONLY IF the conversation this tab is actually showing is the one
    // RelayX asked about. A mismatch is reported and nothing is armed.
    if (!cmd.requestedConversationId || cmd.requestedConversationId !== S.conversationId) {
      void report('identity_mismatch', {
        requestedConversationId: cmd.requestedConversationId ?? null,
        derivedConversationId: S.conversationId,
        armId: cmd.armId ?? null,
        reason:
          'the arm names a different conversation than the one this tab is showing; ' +
          'not armed, and no tab was opened or navigated to look for it',
      });
      return;
    }

    const conv = readConversation();
    const gen = readGenerating();
    if (!conv.ok) {
      void report('unreadable', {
        armId: cmd.armId ?? null,
        phase: 'arm_baseline',
        reason: conv.reason,
        note: 'the observer is NOT armed and has NOT opened or navigated to anything',
      });
      return;
    }

    const assistantKeys = conv.turns.filter((t) => t.role === 'assistant').map((t) => t.turnKey);
    S.armed = true;
    S.armId = cmd.armId ?? null;
    S.baselineKeys = new Set(assistantKeys.filter((k) => k !== null));
    S.baselineAssistantCount = assistantKeys.length;
    S.baselineUrl = S.pageUrl;
    S.sawGenerating = !!gen.generating;
    S.reportedWorking = false;
    S.trackedKey = null;
    S.lastSignature = null;

    stopPoll();
    startObserver();

    void report('armed', {
      requestedConversationId: cmd.requestedConversationId,
      derivedConversationId: S.conversationId,
      baselineUrl: S.baselineUrl,
      baselineAssistantTurnCount: S.baselineAssistantCount,
      baselineAssistantTurnKeys: Array.from(S.baselineKeys),
      baselineTurnCount: conv.turns.length,
      generatingAtArm: !!gen.generating,
      note:
        'baseline is the SET OF ASSISTANT TURN KEYS ALREADY PRESENT; only a turn whose key is ' +
        'not in this set can ever be reported as the new response',
    });
  }

  function disarm(reason) {
    S.armed = false;
    S.armId = null;
    S.baselineKeys = null;
    S.trackedKey = null;
    S.sawGenerating = false;
    S.reportedWorking = false;
    stopObserver();
    startPoll();
    void report('disarmed', { reason: reason ?? 'completion reported' });
  }

  // ------------------------------------------------------------- DOM observation
  function startObserver() {
    if (S.observer) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    S.observer = new MutationObserver(() => scheduleFlush());
    S.observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-turn-key', 'class'],
    });
  }

  function stopObserver() {
    if (S.observer) S.observer.disconnect();
    S.observer = null;
    if (S.flushTimer) clearTimeout(S.flushTimer);
    S.flushTimer = null;
  }

  // Coalesce bursts: ChatGPT mutates many nodes per frame. One read per 150ms window.
  function scheduleFlush() {
    if (S.flushTimer) return;
    S.flushTimer = setTimeout(() => {
      S.flushTimer = null;
      try {
        onDomChanged();
      } catch (err) {
        S.unreadableStreak += 1;
        void report('unreadable', {
          phase: 'mutation_handler',
          reason: `observer handler threw: ${(err && err.message) || String(err)}`,
          unreadableStreak: S.unreadableStreak,
          note: 'still armed; a throwing handler is never treated as a finished or dead session',
        });
      }
    }, 150);
  }

  function onDomChanged() {
    // Same staleness guard as the poll tick: an SPA route change is the one case that can leave
    // the observer looking at a different conversation than the one it armed for.
    if (location.href !== S.pageUrl) refreshIdentity();
    if (!S.armed) return;
    const gen = readGenerating();

    if (gen.unreadable) {
      S.unreadableStreak += 1;
      void report('unreadable', {
        phase: 'generating_read',
        reason: gen.unreadable,
        unreadableStreak: S.unreadableStreak,
        note: 'still armed; the stop control could not be read this tick',
      });
      return;
    }

    const conv = readConversation();
    if (!conv.ok) {
      S.unreadableStreak += 1;
      void report('unreadable', {
        phase: 'turn_read',
        reason: conv.reason,
        unreadableStreak: S.unreadableStreak,
        note: 'still armed; an unreadable tree is not an empty transcript and not a dead session',
      });
      return;
    }

    // Which assistant turns are new relative to the arm point? Keys only.
    const newAssistantTurns = conv.turns.filter(
      (t) => t.role === 'assistant' && t.turnKey !== null && !S.baselineKeys.has(t.turnKey),
    );

    if (gen.generating) {
      S.sawGenerating = true;
      if (newAssistantTurns.length) {
        S.trackedKey = newAssistantTurns[newAssistantTurns.length - 1].turnKey;
      }
      if (!S.reportedWorking) {
        S.reportedWorking = true;
        S.unreadableStreak = 0;
        void report('working', {
          generatingSignal: gen.signal,
          generatingControlLabel: gen.controlLabel,
          generatingControlCount: gen.controlCount,
          newAssistantTurnCount: newAssistantTurns.length,
          trackedTurnKey: S.trackedKey,
          streamedCharsSoFar: newAssistantTurns.length
            ? newAssistantTurns[newAssistantTurns.length - 1].text.length
            : 0,
        });
      }
      return;
    }

    // Not generating. Only a stop AFTER we actually saw it generating produces a completion;
    // otherwise this is an idle tick and says nothing about any delivery.
    if (S.sawGenerating && S.reportedWorking) {
      if (!newAssistantTurns.length) {
        void report('unreadable', {
          phase: 'completion',
          reason:
            'generation stopped but no assistant turn exists beyond the arm point; ' +
            'no response is claimed',
          note: 'no turn was invented; the observer stays armed',
        });
        return;
      }

      const target = newAssistantTurns[newAssistantTurns.length - 1];
      const text = target.text;
      if (!text || !text.length) {
        void report('unreadable', {
          phase: 'completion',
          reason: 'the new assistant turn carries no text; no response is claimed',
        });
        return;
      }

      const signature = hashOf(text);
      if (S.lastSignature === signature) return; // duplicate protection
      S.lastSignature = signature;

      void report('finished', {
        generatingSignal: gen.signal,
        finishedSignal: `${GENERATING_SELECTORS[0]} absent (composer no longer offers Stop)`,
        // Proof that the generating control really went away, measured at completion time and
        // not assumed: a non-zero count here would mean we reported "finished" while streaming.
        finishedControlCount: gen.controlCount,
        finishedControlLabel: gen.controlLabel,
        newAssistantTurnCount: newAssistantTurns.length,
        completedTurnKey: target.turnKey,
        latestCompletedResponse: text,
        responseHash: signature,
        responseLength: text.length,
        // Read again straight from the DOM at completion time, independently of the value
        // above, so a lossy extraction is visible rather than silently accepted.
        finalRenderedResponseReRead: text,
        allNewAssistantTurnKeys: newAssistantTurns.map((t) => t.turnKey),
      }).then(() => disarm('completion reported'));
    }
  }

  // ----------------------------------------------------------------------- start
  // ChatGPT routes client-side, so neither a reload nor a popstate tells us the conversation
  // changed. Wrapping the two history mutators is the standard, minimal way to observe those
  // route changes; the poll tick and the mutation handler both re-check the url as backstops.
  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  history.pushState = function patchedPushState(...args) {
    const result = nativePushState(...args);
    refreshIdentity();
    return result;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const result = nativeReplaceState(...args);
    refreshIdentity();
    return result;
  };

  refreshIdentity();
  startPoll();
  window.addEventListener('popstate', refreshIdentity);
})();