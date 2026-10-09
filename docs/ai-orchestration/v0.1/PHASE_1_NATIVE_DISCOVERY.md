# Native OpenCode discovery foundation

`src/relay/providers/nativeOpenCodeDiscovery.ts` adds an isolated read-only native
discovery adapter for RX-04. It requires an explicit managed/adopted server reference;
it does not discover arbitrary processes or treat system services as RelayX-owned.
This reference is a caller contract, not independently verified ownership. Future
process supervision/operator adoption must establish and persist that authority.

The adapter fetches `/doc`, requires OpenAPI 3 and advertised GET operations with
200 responses for `/global/health` and `/provider`, then validates actual health
and provider responses against the implemented contract. It records raw API spec,
SHA-256 digest, declared operations, API version, runtime version, observation time
and provider/model identities. A connected provider means runtime configuration,
not verified account entitlement, pricing, available quota or task qualification.

The implemented contract was inspected in published `@opencode-ai/sdk` 1.18.35:
`dist/v2/gen/types.gen.d.ts` defines health `{ healthy: true, version: string }`
and provider list `{ all: Provider[], default: Record<string,string>, connected:
string[] }`. Provider model IDs and provider IDs must match their owning records.
Inspection source: https://registry.npmjs.org/@opencode-ai/sdk/-/sdk-1.18.35.tgz
with SHA-256 `1d90a963bcc505282dd1242488c8bdee2df8caa8b23ae9d9981de9bc62b121e4`.
Downloaded source is local scratch inspection evidence, not an installed dependency.
Upstream GitHub source URLs attempted first returned 404, so the published SDK was
used instead. Other server contracts (including legacy 2.0.21 API shapes) are not
implicitly translated or assumed supported.

All requests are GETs to the explicitly supplied origin. Redirects are rejected;
URL credentials, query parameters and non-root paths are rejected. Cleartext
endpoints are limited to literal IPv4/IPv6 loopback; remote endpoints require TLS.
Cancellation/deadlines are caller-supplied. Secure-store authorization is accepted
as an input and never returned. Provider keys/options, error bodies and transport
error strings are omitted from results. A failed probe returns an explicit blocker.

`INSPECTED` means only that this discovery contract succeeded. Declared session,
question and event operations are evidence for later compatibility review, not
validated message semantics. `dispatchAuthorized` is always false. No prompts,
session creation, model switches, process launch or GUI/CLI fallback are performed.
Existing shared-session and fixed-server legacy clients are unchanged.

## Verification and remaining work

50 combined native discovery and existing shared-session tests pass. Coverage
includes a real loopback HTTP boundary, GET-only requests, declared API checks,
auth/status/network failures, malformed responses, unhealthy 2xx, unknown ownership,
endpoint validation, ambiguous providers, cross-provider model identities and secret
omission. TypeScript checks pass. Production builds passed before the final
provider-ID consistency check, which was verified by focused tests and TypeScript.
The full suite was not rerun for this isolated adapter; the previous checkpoint is
1,614 passing test cases with the known macOS live-database suite-construction error.

There is no installed OpenCode executable in this environment, so no actual installed
server `/doc`, health, inventory or inference was verified. Process ownership
persistence, startup supervision, exact-session message transport, event recovery,
question response, version-specific capability validation and dispatch integration
remain future work. This draft branch is stacked on the model discovery PR.
