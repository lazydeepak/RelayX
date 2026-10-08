# RelayX AI Orchestration — Subordinate Design Pack v0.1

**Baseline:** *RelayX — AI Orchestration, Governance & Free-Model Intelligence*, v0.1, 2026-10-08.  
**Status:** proposed architecture / planning artifacts, **not** evidence of running implementation.  
**Purpose:** independently reviewable subsystem specifications and editable technical flowcharts.

## Reading order

| ID | Subordinate document | Main concern | Relevant diagrams |
|---|---|---|---|
| RX-01 | Product Requirements & Success Criteria | scope, measurable acceptance, quality vs zero-cost | D01, D02 |
| RX-02 | Authority, Governance & Policy Gates | roles, fences, permits, approvals | D01, D05, D07 |
| RX-03 | Task Graph, Assignments & Scheduling | backlog, priorities, atomic claims, lifecycle | D02, D03, D05 |
| RX-04 | Planner & OpenCode Integration | internal sessions, transport, questions, restarts | D01, D05, D06, D09 |
| RX-05 | Free Model Discovery & Eligibility | catalogs, account/endpoint verification, $0 enforcement | D04 |
| RX-06 | Model Evaluation, Ranking & Routing | quality benchmarks, confidence, model routing | D08 |
| RX-07 | Supervision & Planner-first Recovery | incidents, evidence, safe interventions | D06, D07, D09 |
| RX-08 | Data Contracts, Security & Audit | immutable records, schemas, API contracts | D05, D10 |
| RX-09 | UI, Delivery Roadmap & Verification | user views, milestone gates, test matrix | D02, D09 |

## Repository packaging

Editable Markdown, DOT, SVG and CSV files are checked into this directory. The full original 57-file publication (including Word documents, PDF atlas and PNG previews) is preserved in `deliverables/RelayX_AI_Subordinate_Documentation_v0.1.zip`. The paths below describe the layout **inside that archive**, except for the source formats also checked into the repository.

## File layout

- `specs/*.md`: editable independent specifications with requirement IDs.
- `diagrams/source/*.dot`: editable Graphviz source; **source of truth** for each diagram.
- `diagrams/svg/*.svg`: vector drawings for documents and applications.
- `diagrams/png/*.png`: preview images.
- `deliverables/RX-01*.docx` through `RX-09*.docx`: nine separately editable Word specifications.
- `deliverables/RelayX_Subordinate_Specifications_v0.1.docx`: combined 19-page editable review handbook.
- `deliverables/RelayX_Flowchart_Atlas_v0.1.pdf`: one diagram per landscape PDF page.
- `deliverables/Requirement_Traceability.csv`: requirement-to-diagram-and-test mapping.
- `deliverables/Decision_Register.csv`: unresolved architectural choices, not assumed decisions.
- `reference/`: a copy of the original v0.1 parent architecture for context.

## Normative language and precedence

**REQ** is user-established or directly inherited from the v0.1 parent spec; **DESIGN** is a proposed implementation rule; **OPEN** requires a deliberate decision. 'Must' in a DESIGN statement is a proposed future constraint, not a claim that code already enforces it.

The parent architecture is authoritative where any divergence is discovered. A subordinate specification adds details, but may not weaken the following invariants:

1. Recovery **always routes to the Planner** for errors, ambiguous delivery, stalls, or unusable Worker results.
2. RelayX Engine, not any model or prompt, owns state transitions, dispatch authority and budget enforcement.
3. Zero-Cost Mode never permits paid AI inference or a silent paid fallback.
4. A Worker question is an **intermediate correlated interaction**, not a final result.
5. The existing UI-based transport and disabled CLI transport are separate from the proposed server-native API transport. No implicit fallback.
6. In-house Planner/Worker messaging does **not** require a browser; browser use for web-app QA is a separate capability.
7. Reuse or migrate existing Project/Pair/Assignment/Attempt/Delivery data after repository audit; do not create a competing source of truth.

## Important non-goals

These files are not implementation plans with confirmed repository filenames, live endpoint credentials, migrations or verified API response shapes. Exact OpenCode `/doc`, provider account entitlements, browser-test tooling, data schema and compatibility must be inspected before coding.

## Rebuilding diagrams

```bash
for file in diagrams/source/*.dot; do
  name=$(basename "$file" .dot)
  dot -Tsvg "$file" -o "diagrams/svg/$name.svg"
  dot -Tpng -Gdpi=160 "$file" -o "diagrams/png/$name.png"
done
```

## Revision history

- v0.1 — 2026-10-08: subordinate specifications and diagrams generated from parent v0.1.
