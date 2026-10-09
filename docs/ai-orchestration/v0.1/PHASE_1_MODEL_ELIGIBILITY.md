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

## Next integration work

Public OpenRouter/Models.dev discovery adapters, catalog persistence, authoritative
account evidence acquisition, capability checks, qualification measurement/ranking,
quota observations, charge/402/429 invalidation and dispatch integration remain
unimplemented. No inference, billing probe, source upload, live account verification
or legacy dispatch behavior changed in this slice. No model is newly authorized.

This branch is stacked on the Phase 0 repair branch for independent review. Human
policy choices in the decision register remain open; this foundation does not decide
code egress, evaluation budget or approval boundaries.
