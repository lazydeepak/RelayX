# OpenCode Session Discovery

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
