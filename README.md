# RelayX

Local macOS-first AI work orchestration control plane coordinating planners, workers, assignments, recovery, supervision, and observable UI automation.

## Features

- **Observable UI Automation**: Real-time tracking of UI interactions and state changes.
- **Durable SQLite Engine**: Persistent storage for projects, assignments, and events.
- **Control Plane Dashboard**: High-level overview of system metrics, active workers, and recent events.
- **Project Activity Trend**: 7-day visualization of completed assignments per project using `recharts`.
- **Engine Invariant Guard**: Strict rules for evidence verification and delivery ambiguity to ensure reliable automation.

## Project Structure

- `src/components`: React components for the UI, including `DashboardView`.
- `src/types`: TypeScript interfaces for the domain model and UI.
- `src/relay`: Core application logic and service layers.

## Dashboard View

The dashboard provides a centralized view of the orchestration state:

### KPI Metrics
- **Active Workers**: Number of running worker sessions.
- **Assignments Running**: Current assignments under execution.
- **Awaiting Review**: Assignments completed by workers and waiting for planner approval.
- **Open Attention**: Items requiring manual reconciliation or recovery.

### Project Activity Trend
A stacked area chart showing the volume of completed assignments for each project over the last 7 days. This helps visualize project velocity and distribution of work.

## Development

### Prerequisites
- Node.js
- npm

### Setup
```bash
npm install
npm run dev
```

### Building
```bash
npm run build
```

## Documentation

- **Audit Reports**: Various audit and lifecycle reports are maintained in the root directory for traceability.
- **Metadata**: Application metadata is defined in `metadata.json`.
