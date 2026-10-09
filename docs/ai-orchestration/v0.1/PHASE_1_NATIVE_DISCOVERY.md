# Native OpenCode discovery foundation

`src/relay/providers/nativeOpenCodeDiscovery.ts` adds an isolated read-only native
discovery adapter for RX-04. It requires an explicit managed/adopted server reference;
it does not discover arbitrary processes or treat system services as RelayX-owned.
This reference is a caller contract, not independently verified ownership. Future
process supervision/operator adoption must establish that authority. The durable
registration and lifecycle foundation below now persists those references.

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
question and event operations feed the structural compatibility report below;
they are not verified runtime message semantics. `dispatchAuthorized` is always false. No prompts,
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
server `/doc`, health, inventory or inference was verified. Startup supervision,
exact-session message transport, event recovery,
question response, version-specific capability validation and dispatch integration
remain future work. This draft branch is stacked on the model discovery PR.

## Durable ownership and lifecycle foundation

`SqliteRelayDatabase.nativeServers` now stores native server registrations and
append-only revision history in the existing database. Additive tables and a unique
active-endpoint index preserve existing relay data and the v6 schema marker.
Registrations require an actor, ownership evidence reference, opaque secure-store
auth reference and explicit managed/adopted mode. Endpoints use the same validation
as discovery. Managed registrations require literal loopback. Project roots are
stored metadata, not permission grants or independently verified filesystem roots.
The repository does not prove that caller-supplied ownership evidence is valid;
trusted operator adoption/process supervision must establish it.

Lifecycle states are REGISTERED, INSPECTED, BLOCKED and REVOKED. Registration does
not claim a running process. Inspection stores API digest/version, declared operations
and historical healthy time. Failed inspection removes current inspection evidence
while preserving historical healthy time. Revocation is terminal, clears inspection
and frees the endpoint for a new explicit identity. IDs and endpoint bindings cannot
be silently overwritten. No PID is treated as process identity, and no process is
spawned or killed by this foundation.

`probeRegisteredNativeServer` resolves authorization by secure-store reference,
rechecks ownership after asynchronous resolution, performs GET discovery outside
database transactions and applies results only at the captured revision. Revocation
or a newer observation supersedes a delayed probe. Missing secure-store access is
recorded as AUTH_UNAVAILABLE without persisting the credential or exception text.
Registration and each transition commit with their audit revision in one savepoint;
outer RelayX transactions retain rollback authority. Backwards observation clocks
and mismatched server evidence are rejected.

55 focused lifecycle, discovery, catalog persistence and SQLite migration tests pass,
including file-backed reopen, stable identity/endpoint conflicts, terminal revocation,
delayed observation races, secure-store resolution races, exact probe evidence,
missing credential handling, transaction rollback and audit-write failure. TypeScript
checks and production builds pass. The full suite was not rerun for this additive
slice; the prior checkpoint and macOS suite-construction limitation remain as above.

Actual process startup/supervision, credential-store implementation and operator UI
adoption are still pending RX-04 OPEN-04 (macOS deployment and installed version audit).
No new live server, inference call or automatic dispatch authorization was introduced.

## Structural session/question/event compatibility

`nativeApiCompatibility.ts` now checks the running OpenAPI document's declared
response/request subset for five independent capabilities. The report is returned
by discovery and persisted with inspection evidence. Existing inspection records
may omit it; omission must never be treated as compatibility approval.

- Session GET: required string sessionID path parameter and required string id/directory.
- Message GET: exact sessionID path parameter, array envelope, required info/parts,
  and required message id/sessionID with only user/assistant roles. Every declared
  message-info union variant must satisfy correlation fields.
- Pending-question GET: array envelope, question id/sessionID, question/header text
  and option label/description declarations.
- Question reply: exact requestID path parameter, answers as an ordered array of
  string arrays, and boolean acknowledgement schema.
- Event GET: explicit text/event-stream string declaration.

Local JSON references (including escaped names) are resolved with bounded cycle
checks. External/unresolved references, reference siblings with unsupported
constraints and unsupported schema composition fail closed. Each failed capability
has a human-readable reason code; a healthy server with incomplete schemas can be
INSPECTED while reporting all native task capabilities unsupported.

These checks are a structural subset, not full JSON Schema validation or behavioral
proof. In particular, message part types, event payload/order/reconnect semantics,
query-directory isolation and question tool/run correlation still need implemented
runtime validation. Native prompt-send compatibility is not checked or enabled.
Future clients must check these reports and validate every actual payload; the
report does not authorize billing, process ownership or dispatch.

60 focused compatibility/discovery/lifecycle tests pass. They cover exact identities,
ordered answers, option labels, missing schemas, unknown roles, message unions,
wrong event media type, references/cycles, persisted reports and immutable input
documents. TypeScript checks and production builds pass. No full-suite rerun or
installed OpenCode server acceptance was performed for this isolated parser slice.
