## Persistence Slice — Additive Association Model

### Decision: Add `runtime_project_associations` table (safe, additive, no destructive migration needed)
- No existing `projectId` on `runtime_sessions`; no separate session-project association exists.
- `Pair` records provide session-to-project links but are work-pair records, not session identity/provenance records.
- New table tracks: authoritative external session identity, verification state, provenance, and one active association per session (proposed, clearly labeled).

### Schema addition
Table: `runtime_project_associations`
Columns: `id`, `runtime_session_id` (references runtime_sessions.id), `project_id` (references projects.id), `external_session_id` (authoritative), `verification_state` (`verified`/`unverified`/`manual`/`stale`), `provenance` (`discovery`/`adoption`/`manual_registration`/`pair_creation`/`setup`), `created_at`, `updated_at`.
Unique index proposed (not enforced as absolute invariant yet): `runtime_session_id` (one association per session globally) — aligns with pairing authority (`Pair` loop skips archived; active pair authority prevents cross-project pairing of same session).

### Repository addition
Add `findBySessionId(sessionId)`, `findByProjectIdAndSessionId(sessionId, projectId)`, `findVerifiedBySessionId(sessionId)`, `findAllForSession(sessionId)`, `findAllForProject(projectId)`. Preserve existing rows and pair/assignment history.
