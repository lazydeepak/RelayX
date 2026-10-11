# Phase 1: model catalog and eligibility contracts

Implemented the first isolated RX-05/RX-06 foundation in
`src/relay/model-intelligence/eligibility.ts`.

Catalog entries carry provider, endpoint, published model identity and source
provenance. They contain no dispatch permission. Account eligibility is a separate
time-bounded lease bound to all five route fields: provider, endpoint, published
model, opaque account reference and runtime configuration fingerprint.

The pure evaluator returns a dispatch decision and all blocking reason codes.
It requires current verified-free account evidence, pricing/account provenance,
unchanged account policy, no conflicts and explicit free/not-applicable status for
every cost dimension. Missing, paid, mixed and promotional-credit-only dimensions
fail closed. It also requires available quota, approved privacy and healthy runtime.
Task dispatch requires current accepted evidence for the exact route and task class.
Evaluation establishes qualification and therefore does not require prior task
qualification, but still requires the same cost gate and separate evaluation quota.
Local routes also require qualification. No fallback route is selected.

This is a typed policy boundary, not an evidence verifier: trusted account adapters
must establish billing authority before creating leases. Source hashes are references,
not cryptographic authentication of callers. The evaluator receives current quota,
privacy and runtime decisions from future authoritative adapters; it does not measure
them. Lease and qualification lifetimes are supplied, with no invented TTL or quota
defaults. Times are numeric milliseconds on one caller-supplied clock.

## Verification

- 66 focused tests pass, covering each cost dimension, exact route changes,
  missing account evidence, missing output pricing, expiry boundary, future/invalid
  clocks, policy changes, conflicts, provenance, local qualification, task classes,
  exhausted/unknown quota and evaluation cost/quota enforcement.
- TypeScript check and production renderer/Electron builds pass.
- The prior full-suite checkpoint remains 1,521 passed test cases, zero failed
  test cases and one skipped case, with an additional suite-construction error
  from the hard-coded macOS live database in `bootstrap_regression.test.ts`.
  That full suite was not rerun for this isolated module.

## Public discovery adapters

`catalog.ts` now provides OpenRouter and Models.dev structured parsers and an
injected-fetch public GET refresh operation. Snapshots include raw response text,
SHA-256 digest, source URL, parser version, fetch/check times and optional ETag.
Prices remain uninterpreted values: tiny decimal strings are not rounded to zero,
and missing prices remain unknown. No snapshot produces an eligibility lease.

Conditional refresh retains original evidence on 304 while updating check time.
Network/HTTP/parse failures retain stale browsing data without refreshing timestamps.
Cross-source caches, duplicate model identities and clock rollback are rejected.
Malformed records and providers with unknown endpoints produce warnings; endpoints
are never inferred from provider names. The caller supplies cancellation/deadline
signals and owns scheduling, backoff, persistence and snapshot retention. Raw public
response data is retained in snapshots, while transport error strings are omitted.

Verification on 2026-10-09: 86 combined catalog/eligibility tests pass and TypeScript
checks pass. Production builds passed before the final warning/clock guard changes;
those changes were rechecked by tests and TypeScript. Public unauthenticated GETs
returned catalogs parsed as 469 OpenRouter models and 6,895 Models.dev models.
Models.dev had 25 providers without an API endpoint; these were explicitly excluded.
No inference request or account-specific request was made. Downloaded live snapshots
are local scratch evidence, not pinned test fixtures or account billing proof.

## Next integration work

Authoritative account evidence acquisition, capability checks, qualification measurement/ranking,
quota observations, charge/402/429 invalidation and dispatch integration remain
unimplemented. No inference, billing probe, source upload, live account verification
or legacy dispatch behavior changed in this slice. No model is newly authorized.

This branch is stacked on the Phase 0 repair branch for independent review. Human
policy choices in the decision register remain open; this foundation does not decide
code egress, evaluation budget or approval boundaries.

## Durable discovery cache

`SqliteRelayDatabase.modelCatalogs` now stores append-only catalog observations in
the existing RelayX database. The additive `model_catalog_snapshots` table does not
change the v6 migration marker, existing relay rows or execution permissions.
Repeated identical observations are idempotent; earlier timestamps and conflicting
observations at the same timestamp are rejected. No history is pruned while the
evidence-retention decision remains open.

On save and load, the repository reparses raw evidence and checks the normalized
snapshot, digest, source, parser version and timestamp/index consistency. Corrupt
evidence is surfaced as an error rather than silently trusted. This checks internal
consistency, not authenticity against malicious database replacement. Savepoints
preserve atomicity and participate in existing outer database transactions.
`refreshStoredCatalog` reads persisted ETags and saves successful refreshes only;
outages retain the prior durable snapshot and storage errors remain visible.

Verification: 99 focused catalog, eligibility, persistence and migration tests pass.
These include file-backed reopen, upgrading an existing v6 file, preservation of
existing projects, exact public prices, duplicate writes, history preservation,
evidence tampering, index corruption, outer transaction rollback, conditional
refresh, HTTP outage and storage failure. TypeScript checks pass. Production builds
passed before the final index consistency guard; the guard was checked by focused
tests and TypeScript. The broader `npm test` run completed in 114 seconds:
1,614 passing test cases, zero failed test cases, one skipped case (333 suites).
The command still exits 1 because `bootstrap_regression.test.ts` fails during
suite construction when opening the hard-coded macOS live database path on Linux.
This is the same previously documented limitation; live acceptance remains unverified.

Account-evidence review: the current environment reports no configured provider
credentials or account identities. Public discovery offers no account-specific
proof for the eleven billing dimensions required by RX-05. No account adapter is
allowed to manufacture a VERIFIED_FREE lease from this cache, and no default quota,
lease duration or automatic model choice has been introduced. Provider-specific
account semantics and authorized account access must be established before live
eligibility integration. This does not block native transport or capability work.
