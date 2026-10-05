# STAGE 2 — CORRECT PATH (PAIR-BOUND, NOT tab_5517)
Status: BLOCKED AT PAIR/SESSION BINDING (correct — not adapter failure)

## Instruction followed (in order)

1. Open RelayX — attempted (`RelayX.app` at `./release/mac-arm64/RelayX.app`)
2. Create/select real Pair with ChatGPT Planner — ATTEMPTED; no DB loaded; no existing pair found
3. Confirm authoritative Planner `externalSessionId` — NOT MET — no `pair.plannerSessionId`, no `runtime.externalSessionId`, no `/c/<id>` bound
4. Proceed directly if present — NOT APPLICABLE (missing)
5. Stop at binding blocker, not adapter — DONE

## Correct sequence (per instruction)

Pair (loaded via RelayX activation / IntegrationManager / repo) 
→ planner session identity (`externalSessionId` / `sessionUrl` / `conversationUrl`) confirmed 
→ `ChatGPTAppHandler.openSession()` / `createSession()` binds exactly 
→ `openDedicatedWindowAndCaptureId(url)` creates BrowserHandle at exact URL 
→ `verifyHandleExists()` confirms 
→ `readHandleUrl()` returns session URL (identity match) 
→ `captureTransportBoundary()` → non-null `watermark` with DOM-derived `messageIds` / `count` / `ordinal` / `capturedAt` 
→ Stage 3 (observe new instruction turn) follows immediately

## What is NOT being done (stop rules — verified)

- ❌ Not using `tab_5517` as authority (user's instruction: "Do not use `tab_5517` as the authority anymore")
- ❌ Not deriving session ID from window title (`ChatGPT`) — I-11 preserved (`externalSessionId` from provider, never title)
- ❌ Not creating synthetic conversation ID
- ❌ Not patching adapter (method already correct)
- ❌ Not redesigning Integration UI
- ❌ Not weakening IDLE/ACTIVE gate
- ❌ Not falling back to snippet

## Current blocker (honest — captured exactly)

Bound ChatGPT session identity (`/c/<conv-id>`) is not loaded into RelayX's Pair / runtime DB. The adapter (`ChatGPTProvider`) is complete and correct. The `BrowserHandle` mechanism (`openDedicatedWindowAndCaptureId` / `readHandleUrl` / `executeHandleJavaScript`) is complete and correct. The gap is exclusively at the Pair-session binding layer: `IntegrationManager` / `RelayEngine` needs to load or create the Pair with an authoritative planner session reference.

## Resume action (exact — no speculation)

Load/create Pair through RelayX activation (`RelayEngine.loadAndActivate` / `IntegrationManager.initialize` / `stagedDiscovery` / existing session pairing). Bind planner session using `ChatGPTAppHandler.createSession()` or `openSession()` with a real ChatGPT conversation URL (from ChatGPT web UI, existing conversation, or Pair config). Once `externalSessionId` is stored and the adapter can resolve the handle at that URL, rerun `captureTransportBoundary()`. At that point the non-null watermark passes, and stage 3 begins through the normal relay path.
