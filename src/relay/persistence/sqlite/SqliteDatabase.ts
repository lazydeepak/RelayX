import { DatabaseSync } from 'node:sqlite';
import { IRelayRepositories } from '../interfaces.ts';
import { SqliteAssociationRepository } from './SqliteAssociationRepository.ts';
import {
  SqliteProjectRepository,
  SqlitePairRepository,
  SqliteRuntimeSessionRepository,
  SqliteAssignmentRepository,
  SqliteAttemptRepository,
  SqliteDeliveryRepository,
  SqliteHandoffRepository,
  SqliteEventRepository,
  SqliteAttentionRepository,
  SqlitePlanFirstRunRepository,
  SqliteWorkUnitRepository,
  SqliteContractRevisionRepository,
  SqliteVerificationResultRepository,
} from './SqliteRepositories.ts';

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .all(tableName) as Array<{ name: string }>;
  return rows.length > 0;
}

function columnExists(db: DatabaseSync, tableName: string, columnName: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
    return rows.some(r => r.name.toLowerCase() === columnName.toLowerCase());
  } catch {
    return false;
  }
}

function addColumnIfNeeded(db: DatabaseSync, tableName: string, columnName: string, columnDef: string): void {
  if (!columnExists(db, tableName, columnName)) {
    try {
      db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnDef};`);
    } catch {}
  }
}

export class SqliteRelayDatabase implements IRelayRepositories {
  public readonly db: DatabaseSync;
  public readonly projects: SqliteProjectRepository;
  public readonly pairs: SqlitePairRepository;
  public readonly runtimes: SqliteRuntimeSessionRepository;
  public readonly assignments: SqliteAssignmentRepository;
  public readonly attempts: SqliteAttemptRepository;
  public readonly deliveries: SqliteDeliveryRepository;
  public readonly handoffs: SqliteHandoffRepository;
  public readonly events: SqliteEventRepository;
  public readonly attention: SqliteAttentionRepository;
  public readonly associations: SqliteAssociationRepository;
  public readonly planFirstRuns: SqlitePlanFirstRunRepository;
  public readonly workUnits: SqliteWorkUnitRepository;
  public readonly contractRevisions: SqliteContractRevisionRepository;
  public readonly verificationResults: SqliteVerificationResultRepository;

  constructor(filePath = ':memory:') {
    this.db = new DatabaseSync(filePath);
    this.initSchema();

    this.projects = new SqliteProjectRepository(this.db);
    this.runtimes = new SqliteRuntimeSessionRepository(this.db);
    this.pairs = new SqlitePairRepository(this.db);
    this.assignments = new SqliteAssignmentRepository(this.db);
    this.attempts = new SqliteAttemptRepository(this.db);
    this.deliveries = new SqliteDeliveryRepository(this.db);
    this.handoffs = new SqliteHandoffRepository(this.db);
    this.events = new SqliteEventRepository(this.db);
    this.attention = new SqliteAttentionRepository(this.db);
    this.associations = new SqliteAssociationRepository(this.db);
    this.planFirstRuns = new SqlitePlanFirstRunRepository(this.db);
    this.workUnits = new SqliteWorkUnitRepository(this.db);
    this.contractRevisions = new SqliteContractRevisionRepository(this.db);
    this.verificationResults = new SqliteVerificationResultRepository(this.db);
  }

  private initSchema(): void {
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        canonical_path TEXT,
        git_root TEXT,
        planner_project_url TEXT,
        worker_workspace_path TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL,
        name TEXT NOT NULL,
        bundle_identifier TEXT,
        window_title TEXT,
        application_pid INTEGER,
        status TEXT NOT NULL,
        consecutive_observation_failures INTEGER NOT NULL DEFAULT 0,
        last_heartbeat_at INTEGER,
        last_observed_at INTEGER,
        last_evidence_json TEXT,
        archived_at INTEGER,
        archive_reason TEXT,
        external_session_id TEXT,
        external_project_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        planner_session_id TEXT REFERENCES runtime_sessions(id),
        worker_session_id TEXT REFERENCES runtime_sessions(id),
        active_assignment_id TEXT,
        status TEXT NOT NULL,
        last_supervised_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        current_attempt_id TEXT,
        active_delivery_id TEXT,
        active_handoff_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        session_pair_id TEXT REFERENCES pairs(id),
        worker_session_id TEXT REFERENCES runtime_sessions(id),
        external_session_id TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        failure_reason TEXT,
        evidence_json TEXT,
        repo_baseline_json TEXT,
        repo_observation_json TEXT
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        target_runtime_id TEXT NOT NULL REFERENCES runtime_sessions(id),
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        instruction_snippet TEXT NOT NULL,
        evidence_json TEXT,
        delivered_at INTEGER,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

  CREATE TABLE IF NOT EXISTS repo_observations (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    classification TEXT NOT NULL,
    baseline_head TEXT,
    observed_head TEXT,
    change_summary TEXT,
    observation_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

        CREATE TABLE IF NOT EXISTS verification_results (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    check_id TEXT,
    result TEXT NOT NULL DEFAULT 'not_run',
    evidence_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS planner_assistances (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
    assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
    planner_session_id TEXT NOT NULL REFERENCES runtime_sessions(id),
    planner_external_session_id TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    correlation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS planner_action_requests (
    id TEXT PRIMARY KEY,
    assistance_id TEXT REFERENCES planner_assistances(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
    assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
    planner_session_id TEXT NOT NULL REFERENCES runtime_sessions(id),
    planner_external_session_id TEXT,
    requested_action TEXT NOT NULL,
    payload TEXT,
    received_at INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'pending',
    rejected_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        result_summary TEXT,
        payload_json TEXT,
        evidence_json TEXT,
        delivered_to_planner_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        previous_state TEXT,
        new_state TEXT,
        evidence_json TEXT,
        correlation_id TEXT,
        details_json TEXT
      );

      CREATE TABLE IF NOT EXISTS attention_items (
        id TEXT PRIMARY KEY,
        pair_id TEXT,
        assignment_id TEXT,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        suggested_action TEXT,
        suggested_tier TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_pairs_project ON pairs(project_id);
      CREATE INDEX IF NOT EXISTS idx_assignments_pair ON assignments(pair_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_assignment ON deliveries(assignment_id);
      CREATE INDEX IF NOT EXISTS idx_handoffs_assignment ON handoffs(assignment_id);
      CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resource_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_attention_status ON attention_items(status);
    `);

    // Comprehensive column migration audit (idempotent, safe for existing databases)
    addColumnIfNeeded(this.db, 'projects', 'canonical_path', 'TEXT');
    addColumnIfNeeded(this.db, 'projects', 'git_root', 'TEXT');
    addColumnIfNeeded(this.db, 'projects', 'planner_project_url', 'TEXT');
    addColumnIfNeeded(this.db, 'projects', 'worker_workspace_path', 'TEXT');
    addColumnIfNeeded(this.db, 'projects', 'status', "TEXT NOT NULL DEFAULT 'active'");

    addColumnIfNeeded(this.db, 'runtime_sessions', 'bundle_identifier', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'window_title', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'application_pid', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'consecutive_observation_failures', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'last_heartbeat_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'last_observed_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'last_evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'archived_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'archive_reason', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'external_session_id', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'external_project_ref', 'TEXT');

    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_extern ON runtime_sessions(provider_type, external_session_id) WHERE external_session_id IS NOT NULL;`);

    addColumnIfNeeded(this.db, 'pairs', 'active_assignment_id', 'TEXT');
    addColumnIfNeeded(this.db, 'pairs', 'last_supervised_at', 'INTEGER');

    addColumnIfNeeded(this.db, 'assignments', 'current_attempt_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'active_delivery_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'active_handoff_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'completed_at', 'INTEGER');

    addColumnIfNeeded(this.db, 'attempts', 'finished_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'attempts', 'failure_reason', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'evidence_json', 'TEXT');

    addColumnIfNeeded(this.db, 'deliveries', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'deliveries', 'delivered_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'deliveries', 'failure_reason', 'TEXT');

    addColumnIfNeeded(this.db, 'handoffs', 'result_summary', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'payload_json', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'delivered_to_planner_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'handoffs', 'completed_at', 'INTEGER');

    addColumnIfNeeded(this.db, 'events', 'previous_state', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'new_state', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'correlation_id', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'details_json', 'TEXT');

    addColumnIfNeeded(this.db, 'attention_items', 'pair_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'assignment_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'suggested_action', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'suggested_tier', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'resolved_at', 'INTEGER');

    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_project_associations (
      id TEXT PRIMARY KEY,
      runtime_session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_type TEXT,
      external_session_id TEXT,
      verification_state TEXT NOT NULL DEFAULT 'unverified',
      provenance TEXT NOT NULL DEFAULT 'manual_registration',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    // Additive only: legacy rows remain readable but have no provider evidence
    // and therefore cannot satisfy the authoritative pairing gate.
    addColumnIfNeeded(this.db, 'runtime_project_associations', 'provider_type', 'TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_session ON runtime_project_associations(runtime_session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_project ON runtime_project_associations(project_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_verified_identity ON runtime_project_associations(runtime_session_id, provider_type, external_session_id, project_id, verification_state)`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assoc_session_project ON runtime_project_associations(runtime_session_id, project_id)`);

    const versionResult = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const currentVersion = versionResult?.user_version ?? 0;
    if (currentVersion < 2) {
      if (currentVersion < 1) {
        this.db.exec('PRAGMA user_version = 1;');
      }
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS set_null_planner_session
        AFTER DELETE ON runtime_sessions
        BEGIN
          UPDATE pairs SET planner_session_id = NULL WHERE planner_session_id = old.id;
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS set_null_worker_session
        AFTER DELETE ON runtime_sessions
        BEGIN
          UPDATE pairs SET worker_session_id = NULL WHERE worker_session_id = old.id;
        END;
      `);
      this.db.exec('PRAGMA user_version = 2;');
    }

    // Plan-First execution domain: contract_revisions / plan_first_runs / work_units.
    // Speculative scaffolding created `work_units` and `plan_first_runs` with a dangling
    // FK to a `contract_revisions` table that was never created, so neither was ever
    // writable and neither can hold rows. The frozen layout (PLAN_FIRST_DOMAIN_FREEZE.md
    // §E) replaces them; see migratePlanFirstSchema() for the guarded rebuild.
    //
    // ORDERING (freeze §E.5): this MUST run after the v0 -> v2 step above, because it
    // stamps user_version = 3 and would otherwise make the `currentVersion < 2` guard
    // skip the orphan triggers on a legacy database.
    this.migratePlanFirstSchema();
  }

  /**
   * Plan-First execution domain schema, version 3.
   *
   * Frozen source: PLAN_FIRST_DOMAIN_FREEZE.md §E.
   *
   * The speculative scaffolding created `work_units` (with an unparsed `dependencies`
   * blob and no ordering column) and `plan_first_runs` (with a derived cursor, a
   * rejected `Strategy` pointer, and an INVERTED `current_attempt_id ... ON DELETE
   * CASCADE` that would have deleted a run whenever an Attempt was deleted). Both
   * referenced a `contract_revisions` table that was never created, so with
   * `PRAGMA foreign_keys = ON` neither table was ever writable and neither can contain
   * rows.
   *
   * Data-loss policy: the legacy tables are dropped ONLY when they are empty. If a
   * legacy table is ever found holding rows we refuse to proceed rather than destroy
   * data silently.
   */
  private migratePlanFirstSchema(): void {
    const versionResult = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const currentVersion = versionResult?.user_version ?? 0;
    if (currentVersion >= 3) return;

    const dropLegacyIfEmpty = (table: string, legacyColumn: string): void => {
      if (!tableExists(this.db, table)) return;
      if (columnExists(this.db, table, legacyColumn)) {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
        if (row.n > 0) {
          throw new Error(
            `Refusing to migrate Plan-First schema: legacy table "${table}" holds ${row.n} row(s). ` +
              `Manual reconciliation is required; RelayX will not drop that data.`,
          );
        }
        this.db.exec(`DROP TABLE "${table}";`);
      }
    };

    dropLegacyIfEmpty('work_units', 'dependencies');
    dropLegacyIfEmpty('plan_first_runs', 'current_work_unit_id');

    // --- contract_revisions (NEW) ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS contract_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      canonical_text TEXT NOT NULL,
      canonical_digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      source_ref TEXT,
      approved_by TEXT,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (project_id, canonical_digest)
    );`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_contract_revisions_project ON contract_revisions(project_id)`);

    // --- plan_first_runs (frozen layout) ---
    // current_work_unit_id  -> DROPPED, the cursor is derived (freeze N6 / §D.2)
    // current_strategy_id   -> DROPPED, Strategy rejected (freeze §B.6)
    // current_attempt_id    -> DROPPED, derived via the unit's assignment, and the old FK
    //                         was ON DELETE CASCADE FROM attempts (inverted data loss)
    // contract_revision_id  -> ON DELETE RESTRICT: executed intent is not deletable
    // session_pair_id       -> NO FK, soft reference: immutable historical provenance that
    //                         must survive pair replacement and pair deletion
    this.db.exec(`CREATE TABLE IF NOT EXISTS plan_first_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      contract_revision_id TEXT NOT NULL REFERENCES contract_revisions(id) ON DELETE RESTRICT,
      contract_digest TEXT NOT NULL,
      session_pair_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_first_runs_project ON plan_first_runs(project_id)`);
    // At most one non-terminal run per (project, revision) — Invariant 6.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_first_runs_active
      ON plan_first_runs(project_id, contract_revision_id)
      WHERE status NOT IN ('completed','cancelled')`);

    // --- work_units (frozen layout) ---
    // project_id    -> DROPPED, derivable through the revision; a second ownership pointer
    // dependencies  -> DROPPED, no DAG in V1 (freeze N9)
    // instruction   -> NOT NULL (was nullable, which allowed a silent generic fallback)
    // ordinal       -> ADDED, the only ordering primitive
    // assignment_id -> ADDED, written once, ON DELETE RESTRICT so the binding can never
    //                  be orphaned into a silent re-dispatch (freeze N11)
    this.db.exec(`CREATE TABLE IF NOT EXISTS work_units (
      id TEXT PRIMARY KEY,
      contract_revision_id TEXT NOT NULL REFERENCES contract_revisions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      objective TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignment_id TEXT REFERENCES assignments(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (contract_revision_id, ordinal)
    );`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_work_units_revision_status ON work_units(contract_revision_id, status)`);
    // At most one executing unit per revision — V1 is strictly sequential.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_work_units_in_progress
      ON work_units(contract_revision_id)
      WHERE status = 'in_progress'`);

    // --- verification_results: one verification result per attempt ---
    // Required by the controller's verification-resume idempotency guard (freeze §F.1).
    // If legacy rows already violate it, fall back to a non-unique index rather than
    // failing startup or deleting data.
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_verification_results_attempt
        ON verification_results(attempt_id)`);
    } catch {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_verification_results_attempt
        ON verification_results(attempt_id)`);
    }

    this.db.exec('PRAGMA user_version = 3;');
  }

  public async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const result = await work();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public close(): void {
    this.db.close();
  }
}
