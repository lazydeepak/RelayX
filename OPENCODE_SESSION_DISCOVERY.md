# OpenCode Session Discovery

> **PRESERVATION CONTRACT — VERIFIED INFRASTRUCTURE**
>
> The discovery, creation, confirmation, and adoption paths documented here
> have been verified against the installed OpenCode runtime. Do not redesign,
> rename, replace, or simplify these boundaries. Any behavioral change requires
> a focused preservation test and explicit provider evidence. Discovery must
> remain read-only; creation must remain a single explicit provider-owned act.

## Purpose

RelayX discovers the existing OpenCode sessions associated with a local project without creating, modifying, moving, or prompting any session. Discovery observes the same persisted `ses_*` records used by the human-facing OpenCode application.

Session creation is a separate, explicit workflow. It is not part of discovery and must not be used as a discovery fallback.

## Authority model

RelayX keeps three facts separate:

1. **Authoritative session identity** comes from OpenCode's shared service, or from the read-only persisted-session compatibility query. A real OpenCode session ID such as `ses_*` is required for binding.
2. **Project eligibility** is established by comparing the session's directory with the selected project's canonical path and Git root.
3. **Visible UI correlation** is supporting evidence only. A parsed window title can help RelayX locate or present a session, but it cannot establish the session identity used for binding.

RelayX therefore never binds a worker from application activation, a window title, recency, or list ordering alone.

## Primary discovery path

The preferred path is implemented by `OpenCodeSessionClient` and `OpenCodeProvider`:

```text
selected local project directory
        |
        v
read ~/.local/state/opencode/service.json
        |
        | validate URL and service password
        v
connect to the already-running shared OpenCode service
        |
        | HTTP Basic auth: opencode:<service password>
        v
GET /api/session?directory=<project-directory>&limit=<limit>
        |
        v
map returned records to authoritative session summaries
        |
        v
match session directory against canonical path / Git root
        |
        v
return eligible ses_* candidates
```

The relevant implementation is:

- `src/relay/providers/opencodeSessionClient.ts`
  - `discoverOpenCodeService()` reads and validates `service.json`.
  - `discoverOpenCodeSessionClient()` constructs a client for that registered service.
  - `OpenCodeSessionClient.listSessionsByDirectory()` issues the directory-scoped HTTP GET.
  - `OpenCodeSessionClient.mapSession()` preserves the session ID, OpenCode project ID, directory, title, agent, model, and timestamps.
- `src/relay/providers/adapters.ts`
  - `OpenCodeProvider.discoverSessionsViaSharedService()` calls the shared-service client and reports failures truthfully.
  - `OpenCodeProvider.matchAuthoritativeSessions()` evaluates project eligibility and optionally correlates visible UI runtimes.
  - `OpenCodeProvider.matchSessionsByPath()` coordinates the primary path and compatibility fallbacks.

The service password is used only to authenticate the request and is not included in returned diagnostics.

## Read-only guarantee

The discovery client only issues HTTP `GET` requests. It does not:

- start an OpenCode server or private `--standalone` instance;
- issue `POST`, `PUT`, `PATCH`, or `DELETE` requests;
- create, fork, rename, move, interrupt, or prompt a session;
- change a model or agent;
- mutate OpenCode persistence.

The primary path connects to the user-wide service already registered in `service.json`. If that service is missing, malformed, unreachable, unauthorized, or returns invalid data, RelayX records the specific failure. It does not reinterpret the failure as proof that no sessions exist.

## Matching rules

Each authoritative session is scored using its stored directory:

- exact canonical-path match: strongest;
- path-segment relationship: eligible but weaker;
- Git-root relationship: additional evidence;
- visible-window correlation: presentation and focus evidence only.

Path containment is segment-aware. For example, `/dev/Relay/packages/app` can match `/dev/Relay`, while `/dev/RelayX` cannot match `/dev/Relay` merely because the string starts with the same characters.

Every eligible result carries evidence including:

- `authoritativeSessionId`;
- the human-readable OpenCode session title when available;
- workspace path;
- OpenCode project ID when available;
- match score and matching method;
- whether a visible UI runtime was correlated;
- canonical project path and Git root.

`authoritativeSessionId` comes from the shared service or persisted-session query. Any session ID parsed from a window remains observed UI evidence and cannot replace it.

## Unique and ambiguous results

When there is one uniquely strongest eligible session, RelayX may select it automatically.

When multiple sessions tie at the strongest score, discovery is marked ambiguous. RelayX must not select the first row, newest row, or currently visible window. The provider returns the full set of eligible authoritative candidates separately from the empty automatic-selection result.

The staged discovery state then:

- preserves all candidate sessions;
- leaves `selectedSessionId` unset;
- reports that explicit selection is required;
- becomes valid only after the user chooses a concrete candidate.

The Add Project wizard presents this as an amber **Select a Session** state. Selecting a candidate records its exact `ses_*` ID. Project setup cannot complete until `isOpenCodeBindingValid()` confirms a non-empty `selectedSessionId`.

For humans, worker choices display the OpenCode session title as the primary label and retain the shortened or full `ses_*` ID as secondary identity. If OpenCode supplies no title, the UI falls back to the session ID. The title is presentation metadata only; changing or duplicating a title never changes which session RelayX binds.

This distinction is intentional:

```text
eligible session != selected session
observed window    != authoritative session
service success    != valid binding
```

## Compatibility fallback

If the shared-service path is unavailable, `OpenCodeProvider.matchSessionsByPath()` falls back to persisted-session discovery through the OpenCode CLI. This path queries existing records and remains read-only.

Visible-window inspection is the final compatibility surface. It can produce candidates and diagnostics, but it does not override the requirement for an authoritative session ID before binding.

Fallback order:

```text
shared service directory query
        |
        | unavailable or failed
        v
read-only CLI persisted-session query
        |
        | unavailable or insufficient
        v
visible UI inspection for compatibility evidence
```

## Binding invariant

The final invariant is:

> RelayX binds an OpenCode worker only to an explicitly identified authoritative `ses_*` session that is eligible for the selected project. Discovery itself performs no mutation.

This prevents activation-only success, cross-project prefix collisions, accidental selection among tied sessions, and replacement of provider truth with UI-derived identity.

## OpenCode Session Ground Truth / Preservation Contract

### Authoritative identity and evidence

- A bindable OpenCode identity is an external ID beginning with `ses_`.
- RelayX `runtime_*` IDs identify RelayX database rows and never substitute for
  an OpenCode session ID.
- Authoritative identity originates in a shared-service or persisted-session
  record, or in the exact result of explicit provider-owned creation followed
  by provider confirmation.
- Window titles, PIDs, application activation, titles, recency, and list order
  are supporting observations only. They cannot create authoritative identity.
- Pairing eligibility requires a verified association row for the exact tuple
  `(runtime_session_id, provider_type, external_session_id, project_id)` with an
  authoritative provenance (`discovery`, `adoption`, or `setup`). Historical
  `manual_registration` and `pair_binding` rows do not authorize pairing.

### Discovery hierarchy

1. `OpenCodeSessionClient.listSessionsByDirectory()` performs the primary,
   directory-scoped shared-service `GET` using the registration read from
   `~/.local/state/opencode/service.json`.
2. If that service is unavailable or fails, `discoverPersistedSessions()` uses
   the read-only CLI session listing compatibility path.
3. UI/window inspection remains presentation and correlation evidence. A
   window-derived ID is reported as observed and is never promoted to
   `authoritativeSessionId`.

A successful empty shared-service result is authoritative emptiness and does
not trigger CLI or UI fallback. Discovery never creates a server or session and
never issues a mutating request.

### Workspace/project matching

- Exact canonical-directory match scores highest.
- Segment-aware parent/child paths are weaker eligible matches.
- Git-root relationship is additive evidence.
- Title correlation is weaker presentation evidence and cannot overcome an
  unrelated directory.
- Segment boundaries are mandatory: `/dev/RelayX` does not match `/dev/Relay`.
- Equal strongest candidates are ambiguous. Enumeration preserves every
  eligible candidate, while automatic selection remains empty until a human
  selects an exact `ses_*` identity.

### Creation semantics

- Creation means OpenCode actually creates one external session and returns its
  authoritative `ses_*` ID.
- `RelayApiService.createOpenCodeWorkerSession()` delegates exactly once to
  `OpenCodeProvider.createWorkerSession()`.
- The provider owns authentication/service negotiation and invokes the proven
  OpenCode CLI API mechanism. The service layer must not reconstruct Basic auth,
  issue its own POST, or retry after an uncertain/failed provider result.
- The creation payload contains session metadata and workspace location only;
  it does not contain or inject a chat message.
- A returned `ses_*` is retained in a truthful partial result if later workspace
  validation or adoption fails. RelayX does not create a replacement session.

The Basic-auth implementation in `OpenCodeSessionClient` is reserved for the
proven read-only shared-service GET discovery client. It is not a session-
creation mechanism.

### Adoption, binding, registration, and confirmation

- Creation and adoption are separate. Creation produces an external session;
  adoption persists it as a RelayX runtime and verified project association.
- Adoption of a caller-supplied or newly created ID requires `ses_*`, an
  authoritative provider confirmation of that exact ID, and matching project
  workspace.
- Manual registration creates a RelayX runtime record only. It is not external
  creation or authoritative adoption and cannot authorize pairing.
- Adoption is idempotent for the same external session and workspace.
- A session already associated with another workspace, already bound to an
  active pair, ambiguous among strongest candidates, or lacking exact verified
  association cannot be paired.

### Prohibited regressions

- Replacing `ses_*` with a RelayX runtime ID or window-derived ID.
- Loose string-prefix or title-only project matching.
- Treating `Relay` and `RelayX` as the same path/title token.
- Falling back after a successful empty authoritative service query.
- Creating, prompting, renaming, moving, or otherwise mutating a session during
  discovery or confirmation.
- Adding service-layer credentials, a manually constructed creation request, or
  a second creation attempt.
- Treating manual registration or historical placeholder evidence as creation,
  adoption, or verified pairing authority.
- Selecting the first/newest/visible session from an ambiguous set.

### Production responsibility map

| Responsibility | Production boundary |
| --- | --- |
| Parse and validate `service.json`; read-only authenticated GET client | `src/relay/providers/opencodeSessionClient.ts`: `parseServiceRegistration`, `discoverOpenCodeService`, `discoverOpenCodeSessionClient`, `OpenCodeSessionClient` |
| Primary service discovery and fallback ordering | `src/relay/providers/adapters.ts`: `OpenCodeProvider.resolveSharedServiceClient`, `discoverSessionsViaSharedService`, `matchSessionsByPath` |
| Segment-aware eligibility, exact/prefix/git-root ranking, ambiguity, UI correlation | `src/relay/providers/adapters.ts`: `segmentPathContains`, `exactBasenameInTitle`, `matchAuthoritativeSessions`, `matchSessionsByPath` |
| Provider-owned, message-free external creation | `src/relay/providers/adapters.ts`: `OpenCodeProvider.createWorkerSession` |
| Exact provider confirmation of ID and project | `src/relay/providers/adapters.ts`: `OpenCodeProvider.confirmSessionForProject` |
| Creation orchestration, single-attempt rule, workspace validation | `src/relay/application/RelayApiService.ts`: `createOpenCodeWorkerSession` |
| Adoption, idempotency, authoritative association persistence | `src/relay/application/RelayApiService.ts`: `adoptOpenCodeSession`, `recordAssociationEvidence` |
| Pairing/rebinding gates | `src/relay/application/RelayEngine.ts`: `assertPrePairAuthoritativeAssociation`, `createPair`, `updatePair` |
| UI requires explicit selected identity | `src/relay/application/stagedDiscovery.ts`: `isOpenCodeBindingValid`; `src/components/AddProjectWizard.tsx`; `src/components/PairModal.tsx` |

### Executable preservation map

| Invariant | Focused tests |
| --- | --- |
| Shared-service registration/auth, GET-only discovery, typed `ses_*` records | `tests/opencode_shared_session_client.test.ts` |
| Service primary; CLI fallback only on failure; no window-manufactured authority | `tests/opencode_shared_session_client.test.ts`, `tests/authoritative_opencode_discovery.test.ts` |
| Exact/prefix/git-root ranking, ambiguity, Relay/RelayX boundaries, title cannot override path | `tests/adapters_match_regression.test.ts`, `tests/authoritative_opencode_discovery.test.ts` |
| Selected `ses_*` required; ambiguous discovery cannot auto-bind | `tests/staged_discovery.test.ts`, `tests/discovery_semantic_correction.test.ts` |
| Single provider creation, no service-layer fetch/auth fallback, workspace and identity confirmation, verified persistence | `tests/open_code_worker_session_creation.test.ts` |
| Provider mechanism remains CLI POST without a message; confirmation remains exact read-only CLI GET | `tests/cli_backed_provider.test.ts` |
| Adoption rejects non-`ses_*`, wrong workspace, absent confirmation, and remains idempotent | `tests/project_session_enumeration.test.ts`, `tests/pair_mutation_association.test.ts`, `tests/open_code_worker_session_creation.test.ts` |
| Manual/historical evidence cannot authorize pairing; exact verified association required | `tests/focused_pairing_association.test.ts`, `tests/pair_mutation_association.test.ts`, `tests/manual_non_null_external_test.test.ts` |
| Cross-project/already-paired/rebinding protections | `tests/focused_pairing_association.test.ts`, `tests/pair_mutation_association.test.ts`, `tests/pair_session_change_isolation.test.ts` |

### Historical evidence

- Commit `f04f192` established authoritative shared-service discovery and the
  read-only binding model documented above.
- Commit `116a77d` introduced the original direct service POST creation path.
  The verified provider correction now lives in `OpenCodeProvider` and owns
  creation/authentication. Preservation tests prohibit restoring the older
  duplicate service-layer Basic-auth path.
