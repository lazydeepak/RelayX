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

## Exact-session read-only transcript retrieval

`nativeSessionReader.ts` reads the exact `/session/{sessionID}` and its message
page. It requires INSPECTED ownership, explicit true session/message compatibility,
a caller-supplied inspection freshness window, a valid `ses_*` identity, an exact
registered directory and a positive caller-supplied message limit. Directory and
limit are encoded as query parameters; response session/directory identity must
match before the transcript request is made. No title matching or inferred project
binding is used. Registered directory metadata remains trusted caller configuration,
not an independently established canonical filesystem authority.

Each message must have a unique ID, exact session ID, known user/assistant role,
valid created/completed observation times and model/provider claims. Assistant parent
IDs are retained; unknown parents outside a partial page are not fabricated. Each
part must have unique ID and exact session/message correlation. Text/reasoning parts
must contain string text; other part types retain identity/type only, with tool/file
payload semantics intentionally pending. Returned data is a whitelist projection,
not a raw provider response or diagnostic dump.

Reader and lifecycle probe capture immutable record snapshots across asynchronous
boundaries, recheck revision/ownership after secure-store resolution and reject
superseded results. GET requests reject redirects, retain caller cancellation signals
and never send prompts. Credential, HTTP, identity and malformed-response failures
produce explicit blockers without remote error-body or auth-value exposure.

Every read is a bounded page with `completeHistory: false`. Provider order is
preserved without assuming a cross-page/event ordering guarantee. Completed timestamps
are observations only: reading a transcript does not complete any Assignment,
Attempt or Delivery, authorize inference or select a model. Transcript persistence,
historical pagination and Engine reconciliation remain separate future integration.

90 focused reader, compatibility, discovery and lifecycle tests pass, including a
real loopback HTTP reader, renamed sessions, wrong directory/session/message/part
identities, duplicate IDs, malformed roles/timestamps, paging limits, auth failures,
revocation and mutable-store revision races. TypeScript checks and production builds
pass. No full-suite rerun or live installed-server acceptance was performed for this
isolated reader slice. The previous full-suite checkpoint and macOS limitation remain.

## Durable transcript observations and restart reconciliation

`SqliteRelayDatabase.nativeTranscripts` stores append-only page observations in
the existing database. Each page references the exact native server audit revision,
session ID, directory, API digest and observation time. A SHA-256 payload digest
checks stored canonical evidence on retrieval. Writes reject superseded/revoked
server evidence, unsupported read compatibility, backwards observations and
same-time conflicting content. Identical observations are idempotent. Savepoints
retain outer transaction rollback; prior pages and streaming text are never edited.
Unknown response fields are removed by whitelist projection. Digest checks establish
internal consistency, not authenticity against malicious database replacement.

`reconcileNativeTranscript` performs a fresh GET-only read, loads the last durable
page for the exact scope, compares message identities/content and atomically stores
the new page. On restart it therefore reuses prior evidence rather than redispatching.
Changes are relative to the last observed page: added, changed, unchanged and
notInCurrentPage. A message absent from a partial page is not declared deleted, and
a message returning from an earlier page may be added relative to the immediate
baseline. Provider order and older observations remain intact. Model/provider claims
and completion timestamps remain observations, not free-tier or task-completion proof.

Provider outages preserve the last durable page. Storage failures and ownership
changes before persistence surface as errors rather than successful reconciliation.
No retention pruning or automatic recovery dispatch policy is introduced.

47 focused transcript persistence, reader and SQLite migration tests pass. These
cover file-backed reopen, immutable streaming revisions, scope isolation, idempotency,
clock/conflict rejection, stale server ownership, digest/index corruption, rollback,
provider outage, ownership change before persistence and unchanged task tables.
TypeScript checks pass; production builds passed before the final two test additions,
which changed no production code. No full-suite rerun or installed-server acceptance
was performed for this slice.

This is observation reconciliation, not yet Engine recovery of outstanding Attempts
or Deliveries. Question observation/correlation, SSE event recovery, historical
pagination and integration with authoritative execution boundaries remain pending.

## Pending-question observation and correlation

`nativeQuestionReader.ts` adds a GET-only observation of `/question`, scoped by the
registered project directory and filtered to one exact `ses_*` session. It requires
a current INSPECTED server and explicit question-read compatibility. Each retained
request must include a unique provider request ID plus a tool correlation containing
both message ID and call ID. Missing or duplicate correlations fail the whole read.
Question text/header, nonempty uniquely labelled options, and explicit multiple/custom
flags are normalized into a whitelist projection. Other sessions are omitted.

The successful result is the complete pending set for that exact session at the
observation time, assuming the server honors its documented directory query. This
claim is narrower than transcript page completeness. A later absence can therefore
be recorded as resolved pending state, but it does not prove how it was answered or
that the Worker continued successfully.

`SqliteRelayDatabase.nativeQuestions` stores append-only, internally hashed pending
sets tied to the exact server revision, API digest, session and directory. It rejects
stale ownership, unsupported compatibility, clock rollback, same-time conflicts,
scope/index tampering and malformed correlation. Writes participate in outer RelayX
transactions. `reconcileNativeQuestions` classifies request IDs as appeared, changed,
unchanged or resolved and stores the new observation. Provider outages and storage
failures do not overwrite prior evidence or report success.

This slice does not yet bind a question to an authoritative RelayX Assignment and
Attempt because native dispatch records do not exist. The persisted provider tuple
`sessionId + messageId + callId + requestId` supplies the exact boundary needed for
that later binding. It does not enter WAITING_FOR_QUESTION, generate a Planner prompt,
send an answer or infer completion. Question reply remains disabled.

36 focused question observation, structural compatibility and SQLite migration tests
pass. Coverage includes cross-session filtering, missing/duplicate correlation,
malformed options, freshness/scope checks, appeared/changed/resolved comparison,
idempotency, time conflicts, stored-evidence tampering, rollback, task-table isolation
and ownership loss before persistence. TypeScript checks and production builds pass.
The final scope-integrity addition changed repository validation and was rechecked by
focused tests and TypeScript. No full-suite rerun or installed-server acceptance was
performed for this slice.

## SSE observation and reconnect recovery

`nativeEventObserver.ts` reads a bounded prefix of the inspected server's `/event`
SSE stream for one registered directory and exact session. It requires explicit
event-stream compatibility, current ownership evidence, caller byte/event limits and
caller cancellation. SSE comments are ignored; CRLF, chunk boundaries and multiline
data are supported. Each JSON envelope must match the directory and contain a provider
event ID/type/properties. Exact-session identity is derived only from declared
sessionID fields in event properties, message info or part data. Other sessions are
omitted. SSE `id` and payload ID must agree when both are present.

The result retains provider event ID/type, message/part correlation when available,
an SHA-256 digest of the raw JSON data and observed order within that connection.
Raw event properties are not persisted, avoiding incidental provider configuration
or tool payload retention. Duplicate IDs with identical data are deduplicated;
conflicting reuse of an ID fails the connection. Event order is an observation within
one connection only and is never promoted to a global provider ordering guarantee.

`SqliteRelayDatabase.nativeEvents` stores each connection boundary and each unique
provider event in additive tables tied to the exact server audit revision and API
digest. Replayed event IDs are recorded as batch duplicates without duplicating the
event. Conflicting replay, clock rollback, stale/revoked ownership and unsupported
compatibility roll back atomically. Writes participate in outer RelayX transactions.
No Assignment, Attempt or Delivery state is changed by event persistence.

`recoverNativeEventConnection` loads the durable cursor and sends it as
`Last-Event-ID`. This header is a replay request, not proof that OpenCode honored it.
Every reconnect is therefore marked `UNVERIFIED_RECONNECT`. Every bounded connection
also ends at either EOF or RelayX's event limit; both boundaries require authoritative
transcript and pending-question reconciliation. The recovery result explicitly sets
both requirements. Events alone cannot prove message persistence, question resolution,
Worker completion or safe redispatch.

37 focused SSE observation, structural compatibility and SQLite migration tests pass.
Coverage includes exact-session filtering, comments, CRLF/chunk/multiline parsing,
identity conflicts, provider-ID replay, cursor recovery, content/auth failures, byte
and event limits, stale ownership, rollback and unchanged task tables. TypeScript
checks and production builds pass. No full-suite rerun or installed OpenCode server
acceptance was performed for this slice.

Long-lived connection supervision, retry/backoff policy and combined execution of the
required transcript/question reconciliations remain pending Engine integration. The
published SDK documents an event stream but no replay guarantee was assumed here.

## Combined observation recovery checkpoint

`nativeObservationRecovery.ts` now coordinates the three authoritative observation
paths after restart or an SSE boundary. It loads the durable event cursor, consumes
one bounded SSE connection, reads the exact-session transcript page, then reads the
complete pending-question set. Network operations occur sequentially outside SQLite
transactions. Each response independently rechecks the same server revision and API
digest. This is a coordinated observation window, not a claim that the provider
offers an atomic cross-endpoint snapshot.

If any phase is blocked, the result names EVENTS, TRANSCRIPT or QUESTIONS and none
of the new checkpoint is stored. Once all reads succeed, relative transcript/question
changes are computed and the event batch, transcript page and question set commit in
one existing RelayX transaction. Repository checks run again inside that transaction,
so concurrent revocation or a newer observation causes full rollback. A failure in
the final repository write also rolls back the event and transcript writes.

Successful results explicitly state `taskStateChanged: false` and
`dispatchAttempted: false`. The coordinator does not interpret an event, completed
assistant timestamp or resolved question as Worker completion. It does not reconcile
an Assignment/Attempt because native dispatch records and pre-send boundaries do not
exist yet. Those authority decisions remain an Engine responsibility.

Review found that the durable question canonicalizer emitted fields in a different
order than the reader. Since comparisons intentionally use canonical JSON, unchanged
questions were falsely reported as changed. Canonical ordering now matches the reader,
and the repeated-checkpoint test proves unchanged classification.

43 combined recovery, SSE, transcript and question persistence tests pass. They cover
all-evidence commit, each blocked phase, final-write rollback, ownership loss after
network reads, durable cursor reuse, replay deduplication, unchanged evidence and
unchanged task tables. TypeScript checks and production builds pass. No full-suite
rerun or installed-server acceptance was performed for this isolated coordinator.

## Durable native dispatch preparation

`SqliteRelayDatabase.nativeDispatchIntents` adds a transport-specific adjunct to the
existing Assignment/Attempt/Delivery ledger. It does not create a competing task
state machine. Preparation requires the existing Delivery to be pending, its Attempt
to be prepared, the Assignment's current Attempt/active Delivery to match, frozen
Pair/runtime/session authority to match, and the Delivery idempotency key to equal
the dispatch key. One intent is permitted per Delivery and Attempt.

The intent freezes assignment, attempt, delivery, dispatch key, exact native server
revision, exact `ses_*` session and directory, policy version, canonical text payload
and SHA-256 digest, plus all five model-route fields: provider, endpoint, published
model, opaque account reference and runtime-configuration fingerprint. Unknown input
fields are removed before persistence, preventing accidental auth/config data capture.
The serialized intent also has an independent digest and indexed-field checks.

The pre-send provider boundary must come from the latest transcript, question and
event observations for the exact scope. All three must share one observation time
and current server audit revision; the API digest and optional event cursor are
recorded with transcript/question payload digests. Mixed or stale observations fail
preparation. This relies on the combined checkpoint coordinator for coherent evidence;
it remains a sequential observation window rather than a provider-atomic snapshot.

Every record is `PREPARED_UNAUTHORIZED`. Preparation performs no HTTP request, does
not change Attempt or Delivery status, and cannot be interpreted as eligibility or
permission to send. The payload is retained because future restart-safe exactly-once
submission must reproduce the committed bytes; retention/privacy policy and UI must
account for that content. This slice supports text parts only. Model-route presence
is checked, while verified-free eligibility and task qualification are deliberately
deferred to the future authorization transition.

25 focused dispatch-intent, combined-recovery and SQLite migration tests pass. They
cover authority/session/idempotency mismatches, combined-boundary enforcement, exact
model route, payload and intent digests, idempotency/conflicts, unknown-field removal,
serialized/index tampering, revocation, transaction rollback and unchanged Attempt/
Delivery states. TypeScript checks and production builds pass.

The next slice needs a separate durable authorization decision bound to this exact
intent and eligibility lease before any send method can exist. HTTP acceptance,
provider-persisted message evidence and Worker completion must remain separate states.
