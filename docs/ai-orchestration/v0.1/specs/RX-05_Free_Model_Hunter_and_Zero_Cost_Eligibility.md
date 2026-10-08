# RX-05 — Free Model Hunter & Zero-Cost Eligibility

**Version:** 0.1 · **Status:** Proposed discovery and pricing-gate specification · **Parent:** Architecture v0.1 §§6–7 · **Diagrams:** D04

## 1. What 'free' actually means

For a specific inference, a route is eligible only when the **exact account + provider + serving endpoint + model + runtime configuration** is known to avoid paid AI API/model charges and to satisfy task requirements. A catalog's price-zero field, a `:free` label or a public free-tier claim is insufficient. Endpoint charges may include input, output, cached, reasoning/media tokens, per-request fees, routing fees, BYOK charges or expiring promotional conditions.

**REQ-18:** In Zero-Cost Mode, any unknown, stale, mixed, paid or promotional-credit-only route is non-dispatchable unless a separate explicit user-approved rule covers it.  
**REQ-19:** Model catalogs and benchmark popularity are discovery evidence, not authority for account-specific cost.  
**REQ-20:** Exhausted free quotas cause queue/pausing or a verified-free switch; no paid fallback.  
**REQ-21:** Each qualification must be time-bound, explainable and rechecked on relevant errors.

## 2. Source priority and provenance

| Source class | Examples | What to trust it for |
|---|---|---|
| Provider-specific account/billing APIs | authorized account key/quota/status endpoints | account route/grant state, subject to documented semantics |
| Endpoint/provider catalog | OpenRouter models and endpoint APIs, direct providers | current offered models, visible prices, feature claims |
| Aggregated model metadata | Models.dev | provider aliases, context/tool traits, cross-check |
| Runtime OpenCode API | `/provider`, `/doc`, actual connected server | model/tool support in this server version |
| Controlled probe | low-risk free call with recorded usage | observed behavior; **not** proof of future charge-free operation |
| Web search, provider docs, public benchmark | targeted investigation and background | supplementary, potentially stale evidence |

Store raw source URL, fetch time, ETag/response digest if available, normalized parser version, route identity, account policy hash, and conflict notes. A source conflict is a review event, not a prompt to guess the lowest price.

## 3. Candidate states and eligibility lease

Suggested route states: `DISCOVERED → NORMALIZED → PRICE_CHECKED → ENTITLEMENT_CHECKED → CAPABILITY_CHECKED → VERIFIED_FREE → QUALIFICATION_PENDING → QUALIFIED`. Exception states: `UNKNOWN`, `DENIED`, `EXPIRED`, `RATE_LIMITED`, `UNAVAILABLE`.

A **verification lease** is a bounded permit with basis and expiry; renewed on account connection and before costly or long assignments. `VERIFIED_FREE` alone does not make a model capable of a given coding task. A route is dispatchable only when **verified free + qualified for task requirements + available quota + permitted privacy + healthy runtime**.

## 4. Canonical identity and data contracts

```text
RouteIdentity = provider_id + endpoint_id + published_model_id
              + credential/account_id + runtime_config_fingerprint
EligibilityRecord = route + mode + verified_at + expires_at
                  + pricing_evidence_hash + account_evidence_hash
                  + verdict(VERIFIED_FREE | DENIED | UNKNOWN)
QuotaObservation = route + window_start/end + observed_used + observed_remaining
                 + source + confidence + fetched_at
```

Do not leak auth secrets into logs. Account IDs should be opaque references to secure credential storage. Handle provider aliases carefully: if serving model is unknowable, it is unsuitable for audited attempts that need exact route traceability.

## 5. Refresh and backoff rules

- On startup and on manual refresh: update catalog snapshots with conditional HTTP requests where supported.
- Before new project use: verify account entitlement, provider availability and current price terms.
- Before each dispatch: check the unexpired lease plus observed quota and server availability.
- On 402, 429, unexpected charge or account change: mark route suspect, halt new dispatches, reconcile, and investigate.
- On source/network outage: show stale data with timestamp; **do not** turn stale discovery into fresh authorization.
- Prefer per-source backoff and jitter; limit evaluation probes to protect scarce free quota.

**DESIGN-14:** Cache and show last-known candidate data for browsing, but fail closed for fresh zero-cost authorization when lease expires.  
**DESIGN-15:** Record `NO_ELIGIBLE_MODEL` as an explainable blocker, with alternate verified free/local candidates if known.

## 6. Router contract and dangerous assumptions

`Eligibility.check(route, account, task_capability, privacy_policy, mode) → verdict + evidence + expiry + reasons`. `ModelCatalog.list()` must never imply dispatchability. Local models have zero paid remote inference but still need tool/context/quality evaluation and device availability. A seemingly cheap model that fails tools repeatedly should be rejected for high-risk work despite price.

## 7. Adversarial tests

**MOD-01** published price zero but account plan charges → DENY; **MOD-02** missing output price → UNKNOWN/DENY; **MOD-03** token cache charged separately → deny if paid; **MOD-04** exhausted quota cannot route to paid endpoint; **MOD-05** free alias reveals no exact model → excluded from auditable attempts; **MOD-06** expired lease after catalog outage → no dispatch; **MOD-07** free local model permitted only with adequate capability; **MOD-08** benchmark request itself passes zero-cost gate.

## 8. Registry bootstrap

Bootstrap catalog adapters for OpenRouter and Models.dev, then direct-provider adapters for authorized accounts. Do not hardcode catalog rate limits, plan quotas or specific free-model names. Keep raw evidence and human-readable reasons. Provider contracts and free tiers can change independently of RelayX code.
