/**
 * ============================================================================
 * RELAY SQLITE PERSISTENCE LAYER — DATABASE & SCHEMA MANAGEMENT
 * ============================================================================
 *
 * This module manages the embedded SQLite database (`node:sqlite`) for RelayX,
 * providing durable relational storage for all projects, runtime sessions,
 * pairs, work assignments, physical attempts, deliveries, handoffs, and audit events.
 *
 * PERSISTENCE GUARANTEES:
 * 1. Foreign Key Enforcement: `PRAGMA foreign_keys = ON;` is explicitly enabled.
 * 2. Additive Schema Migrations: Table columns and indexes are upgraded additively
 *    (`addColumnIfNeeded`), preserving existing historical records without data loss.
 * 3. Atomic Transactions: `runInTransaction()` wraps multi-table state updates in
 *    SQLite transactions (`BEGIN` ... `COMMIT` / `ROLLBACK`).
 * 4. Authoritative Association Uniqueness: `runtime_project_associations` enforces
 *    unique pairing evidence per (runtime_session_id, project_id).
 */

import { DatabaseSync } from 'node:sqlite';
import { IRelayRepositories } from '../interfaces.ts';
import { SqliteAssociationRepository } from './SqliteAssociationRepository.ts';
import {
  SqliteProjectRepository,
  SqlitePairRepository,
  SqlitePairSideIdentityRepository,
  SqlitePairSideCheckpointRepository,
  SqlitePairCheckpointRepository,
  SqliteRuntimeSessionRepository,
  SqliteAssignmentRepository,
  SqliteAttemptRepository,
  SqliteDeliveryRepository,
  SqliteHandoffRepository,
  SqliteEventRepository,
  SqliteActivityRepository,
  SqliteAttentionRepository,
  SqlitePlanFirstRunRepository,
  SqliteWorkUnitRepository,
  SqliteContractRevisionRepository,
  SqliteVerificationResultRepository,
} from './SqliteRepositories.ts';
import { SqliteProviderSettingsRepository } from './SqliteProviderSettingsRepository.ts';
import { SqliteHealthObservationRepository, SqliteHealthIncidentRepository } from './SqliteHealthRepository.ts';
import { SqliteRelayIngressRepository } from './SqliteRelayIngressRepository.ts';

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
  public readonly sideIdentities: SqlitePairSideIdentityRepository;
  public readonly sideCheckpoints: SqlitePairSideCheckpointRepository;
  public readonly checkpoints: SqlitePairCheckpointRepository;
  public readonly runtimes: SqliteRuntimeSessionRepository;
  public readonly assignments: SqliteAssignmentRepository;
  public readonly attempts: SqliteAttemptRepository;
  public readonly deliveries: SqliteDeliveryRepository;
  public readonly handoffs: SqliteHandoffRepository;
  public readonly events: SqliteEventRepository;
  public readonly activities: SqliteActivityRepository;
  public readonly attention: SqliteAttentionRepository;
  public readonly associations: SqliteAssociationRepository;
  public readonly planFirstRuns: SqlitePlanFirstRunRepository;
  public readonly workUnits: SqliteWorkUnitRepository;
  public readonly contractRevisions: SqliteContractRevisionRepository;
  public readonly verificationResults: SqliteVerificationResultRepository;
  public readonly providerSettings: SqliteProviderSettingsRepository;
  public readonly healthObservations: SqliteHealthObservationRepository;
  public readonly healthIncidents: SqliteHealthIncidentRepository;
  public readonly relayIngresses: SqliteRelayIngressRepository;

  constructor(filePath = ':memory:') {
    this.db = new DatabaseSync(filePath);
    this.initSchema();

    this.projects = new SqliteProjectRepository(this.db);
    this.runtimes = new SqliteRuntimeSessionRepository(this.db);
    this.pairs = new SqlitePairRepository(this.db);
    this.sideIdentities = new SqlitePairSideIdentityRepository(this.db);
    this.sideCheckpoints = new SqlitePairSideCheckpointRepository(this.db);
    this.checkpoints = new SqlitePairCheckpointRepository(this.db);
    this.assignments = new SqliteAssignmentRepository(this.db);
    this.attempts = new SqliteAttemptRepository(this.db);
    this.deliveries = new SqliteDeliveryRepository(this.db);
    this.handoffs = new SqliteHandoffRepository(this.db);
    this.events = new SqliteEventRepository(this.db);
    this.activities = new SqliteActivityRepository(this.db);
    this.attention = new SqliteAttentionRepository(this.db);
    this.associations = new SqliteAssociationRepository(this.db);
    this.planFirstRuns = new SqlitePlanFirstRunRepository(this.db);
    this.workUnits = new SqliteWorkUnitRepository(this.db);
    this.contractRevisions = new SqliteContractRevisionRepository(this.db);
    this.verificationResults = new SqliteVerificationResultRepository(this.db);
    this.providerSettings = new SqliteProviderSettingsRepository(this.db);
    this.healthObservations = new SqliteHealthObservationRepository(this.db);
    this.healthIncidents = new SqliteHealthIncidentRepository(this.db);
    this.relayIngresses = new SqliteRelayIngressRepository(this.db);
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
        session_url TEXT,
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
        operational_state TEXT NOT NULL DEFAULT 'IDLE',
        relay_state TEXT NOT NULL DEFAULT 'STOPPED',
        predecessor_pair_id TEXT,
        source_checkpoint_id TEXT,
        last_supervised_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pair_checkpoints (
        id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        objective TEXT,
        current_milestone TEXT,
        summary TEXT,
        pending_work TEXT,
        next_action TEXT,
        latest_assignment_id TEXT,
        latest_attempt_id TEXT,
        latest_delivery_id TEXT,
        planner_context TEXT,
        worker_context TEXT,
        repo_head TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pair_checkpoints_pair_id ON pair_checkpoints(pair_id);
    `);
    addColumnIfNeeded(this.db, 'pairs', 'predecessor_pair_id', 'TEXT');
    addColumnIfNeeded(this.db, 'pairs', 'source_checkpoint_id', 'TEXT');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        target_side_role TEXT NOT NULL DEFAULT 'worker',
        source_handoff_id TEXT,
        source_recovery_delivery_id TEXT,
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
        planner_delivery_evidence_json TEXT,
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
        details_json TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        area TEXT NOT NULL DEFAULT 'engine',
        outcome TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS activity_records (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        correlation_id TEXT,
        evidence_json TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_records(timestamp DESC);
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
    addColumnIfNeeded(this.db, 'runtime_sessions', 'session_url', 'TEXT');

    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_extern ON runtime_sessions(provider_type, external_session_id) WHERE external_session_id IS NOT NULL;`);

    addColumnIfNeeded(this.db, 'pairs', 'active_assignment_id', 'TEXT');
    addColumnIfNeeded(this.db, 'pairs', 'last_supervised_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'pairs', 'operational_state', "TEXT NOT NULL DEFAULT 'IDLE'");
    addColumnIfNeeded(this.db, 'pairs', 'relay_state', "TEXT NOT NULL DEFAULT 'STOPPED'");
    addColumnIfNeeded(this.db, 'pairs', 'stable_pair_id', 'TEXT');

    addColumnIfNeeded(this.db, 'assignments', 'current_attempt_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'active_delivery_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'active_handoff_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'target_side_role', "TEXT NOT NULL DEFAULT 'worker'");
    addColumnIfNeeded(this.db, 'assignments', 'source_handoff_id', 'TEXT');
    addColumnIfNeeded(this.db, 'assignments', 'completed_at', 'INTEGER');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_source_handoff ON assignments(source_handoff_id) WHERE source_handoff_id IS NOT NULL;`);

    // Relay recovery episodes. `source_recovery_delivery_id` names the confirmed Delivery
    // whose unresolved baton episode produced a recovery notice; the UNIQUE partial index
    // makes "at most one recovery notice per triggering Delivery" a schema guarantee, so
    // exactly-once recovery survives a crash without depending on in-memory state. It is
    // a TRANSPORT fact ("a notice was already issued for this episode"), never a semantic
    // outcome — see AssignmentProps.sourceRecoveryDeliveryId.
    addColumnIfNeeded(this.db, 'assignments', 'source_recovery_delivery_id', 'TEXT');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_source_recovery ON assignments(source_recovery_delivery_id) WHERE source_recovery_delivery_id IS NOT NULL;`);

    addColumnIfNeeded(this.db, 'attempts', 'session_pair_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'worker_session_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'external_session_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'finished_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'attempts', 'failure_reason', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'repo_baseline_json', 'TEXT');
    addColumnIfNeeded(this.db, 'attempts', 'repo_observation_json', 'TEXT');

    addColumnIfNeeded(this.db, 'deliveries', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'deliveries', 'delivered_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'deliveries', 'failure_reason', 'TEXT');

    addColumnIfNeeded(this.db, 'handoffs', 'result_summary', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'payload_json', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'planner_delivery_evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'delivered_to_planner_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'handoffs', 'completed_at', 'INTEGER');

    addColumnIfNeeded(this.db, 'events', 'previous_state', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'new_state', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'correlation_id', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'details_json', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'severity', "TEXT NOT NULL DEFAULT 'info'");
    addColumnIfNeeded(this.db, 'events', 'area', "TEXT NOT NULL DEFAULT 'engine'");
    addColumnIfNeeded(this.db, 'events', 'outcome', 'TEXT');
    addColumnIfNeeded(this.db, 'events', 'is_archived', 'INTEGER NOT NULL DEFAULT 0');

    this.db.exec(`
      UPDATE events SET severity = 'info' WHERE severity IS NULL;
      UPDATE events SET area = 'engine' WHERE area IS NULL;
      UPDATE events SET is_archived = 0 WHERE is_archived IS NULL;
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
      CREATE INDEX IF NOT EXISTS idx_events_area ON events(area);
      CREATE INDEX IF NOT EXISTS idx_events_archived ON events(is_archived);
    `);

    addColumnIfNeeded(this.db, 'activity_records', 'correlation_id', 'TEXT');
    addColumnIfNeeded(this.db, 'activity_records', 'evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'activity_records', 'details_json', 'TEXT');

    addColumnIfNeeded(this.db, 'attention_items', 'pair_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'assignment_id', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'suggested_action', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'suggested_tier', 'TEXT');
    addColumnIfNeeded(this.db, 'attention_items', 'resolved_at', 'INTEGER');

    // S5 durable per-side identity evidence. Additive only (§10.1): a new table,
    // no existing table altered, gated on `PRAGMA user_version` below.
    //
    // This is the S5 SUBSET of the §10.3 `side_observations` proposal: dimensions
    // 1-3 plus the mandatory dimensions 8 and 9. Dimensions 4-7 (reachability, UI
    // presence, activity, message evidence) are S2 provider observation and are
    // deliberately NOT present. `valid_until` is omitted because §5.4 leaves the
    // per-capability window UNRESOLVED (U-7) and S8 owns staleness.
    //
    // There is no readiness column and no checkpoint column here. I-5 forbids a
    // persisted readiness value, and checkpoints are S3/S7.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pair_side_identity (
        id TEXT PRIMARY KEY,
        session_pair_id TEXT NOT NULL,
        side_role TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        runtime_session_id TEXT,
        external_session_id TEXT,
        identity_state TEXT NOT NULL,
        identity_value TEXT,
        verification_state TEXT NOT NULL,
        verification_value TEXT,
        existence_state TEXT NOT NULL,
        capability TEXT NOT NULL,
        source_capability TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        reason TEXT,
        evidence_json TEXT,
        UNIQUE (session_pair_id, side_role)
      );
    `);

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
    this.migrateSessionPairOperationsSchema();
    this.migrateSideIdentitySchema();
    this.migrateSideObservationSchema();
    this.migrateSideCheckpointSchema();
    this.migrateProviderSettingsSchema();

    // Phase 1 health domain tables (additive only)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_observations (
        id TEXT PRIMARY KEY,
        check_type TEXT NOT NULL,
        component_type TEXT NOT NULL,
        component_id TEXT,
        result TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        evidence_json TEXT
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_incidents (
        id TEXT PRIMARY KEY,
        incident_type TEXT NOT NULL,
        component_type TEXT NOT NULL,
        component_id TEXT,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        evidence_json TEXT
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_health_incidents_status ON health_incidents(status);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_health_incidents_type ON health_incidents(incident_type);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_health_observations_check ON health_observations(check_type);`);
  }

  /**
   * Explicit operator/provider settings, version 8.
   *
   * ## Why a table and not a config file or an environment variable
   *
   * A model used to serve a delivery is part of the delivery's EVIDENCE, and evidence has to
   * be readable later by someone who was not present when it was written. An env var cannot
   * be audited after the process exits, and a global OpenCode config file would be a
   * machine-wide change made on RelayX's behalf — a silent provider change, which is exactly
   * what must never happen. A RelayX-owned, operator-set, per-provider row is the only form
   * that is simultaneously explicit, scoped, and durable.
   *
   * Keys are namespaced by provider type (`opencode.transportModel`) so a setting for one
   * provider can never be read as a setting for another.
   *
   * Additive only: one new table, no existing table altered, no rows synthesized. A setting
   * that does not exist reads back as `null` and is reported as "unset", never defaulted to
   * a guessed value.
   */
  private migrateProviderSettingsSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        note TEXT,
        set_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * S3 per-side checkpoints schema, version 7.
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §10.3, §6.1-§6.5.
   *
   * Additive only: creates ONE new table `pair_side_checkpoints` and alters no existing table.
   * Checkpoints are append-only rows; existing checkpoint rows are never mutated or deleted in place.
   *
   * ORDERING: must run AFTER migrateSideObservationSchema(), which stamps 6.
   *
   * ## There is deliberately no backfill step
   *
   * Existing pairs have NO checkpoint baseline until an explicit operator initial-baseline
   * operation is invoked. Synthesizing checkpoints for pre-existing pairs would fabricate
   * a baseline comparison that never occurred, violating provenance and baseline freeze rules.
   */
  private migrateSideCheckpointSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pair_side_checkpoints (
        id TEXT PRIMARY KEY,
        session_pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        side_role TEXT NOT NULL,
        message_ref TEXT,
        message_ordinal INTEGER,
        message_text TEXT,
        external_session_id TEXT,
        determinacy TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        source_provider TEXT NOT NULL,
        source_capability TEXT NOT NULL,
        authority_kind TEXT NOT NULL,
        authority_payload_json TEXT NOT NULL,
        audit_reason TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pair_side_checkpoints_lookup 
        ON pair_side_checkpoints(session_pair_id, side_role, captured_at DESC);
    `);
  }

  /**
   * Per-side identity evidence schema, version 5.
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §10.1, §10.3, §5.2, §5.3,
   * I-3, I-6, I-10.
   *
   * Additive only, gated on `PRAGMA user_version` exactly like the v0->v2, v2->v3
   * and v3->v4 steps. It creates ONE new table and alters nothing.
   *
   * ORDERING: this must run AFTER migrateSessionPairOperationsSchema(), which
   * stamps 4, otherwise a v4 database would re-enter the v4 backfill.
   *
   * ## There is deliberately no backfill step
   *
   * §17.3 backfills `operational_state` to IDLE, and I-2 then forbids contacting
   * any provider for such a Pair. A row here can therefore only ever have been
   * written by a real `loadAndActivate` against a real provider. Synthesising
   * "unknown" rows for pre-existing Pairs would fabricate an observation that
   * never happened, which is the same provenance defect I-13 exists to prevent.
   * An absent row honestly means "never activated, nothing known".
   */
  private migrateSideIdentitySchema(): void {
    const versionResult = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const currentVersion = versionResult?.user_version ?? 0;
    if (currentVersion >= 5) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pair_side_identity (
        id TEXT PRIMARY KEY,
        session_pair_id TEXT NOT NULL,
        side_role TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        runtime_session_id TEXT,
        external_session_id TEXT,
        identity_state TEXT NOT NULL,
        identity_value TEXT,
        verification_state TEXT NOT NULL,
        verification_value TEXT,
        existence_state TEXT NOT NULL,
        capability TEXT NOT NULL,
        source_capability TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        reason TEXT,
        evidence_json TEXT,
        UNIQUE (session_pair_id, side_role)
      );
    `);

    this.db.exec('PRAGMA user_version = 5;');
  }

  /**
   * S2 observation dimensions, version 6.
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §10.1, §10.3, §5.2,
   * §5.3, §5.4, I-3, I-6, C-8.
   *
   * Additive only, gated on `PRAGMA user_version` exactly like the v0->v2 through
   * v3->v5 steps. It adds columns and alters no existing value.
   *
   * ## It extends the SAME table rather than creating a second one
   *
   * §10.3's `side_observations` is one row per (pair, side), and that table already
   * exists as `pair_side_identity` (stamped by v5), whose own doc comment calls it
   * "the S5 subset of the §10.3 `side_observations` proposal". S2 supplies the
   * missing dimensions 4-7 to that record. A second observation table keyed on the
   * same (pair, side) would create two competing "latest observed" authorities for
   * one subject, which is the duplicate-authority defect the S1-S6 foundation
   * exists to prevent.
   *
   * ## Columns are NULLable, and that is deliberate
   *
   * Every column here is added WITHOUT a default, so a row written by S5 keeps NULL
   * here. NULL therefore means "this build never wrote this dimension", which is a
   * different fact from "a provider was asked and answered `unknown`". The
   * repository maps NULL to a `null` `observation` object carrying an explicit
   * reason, rather than fabricating `unknown` readings no provider ever returned
   * (I-6, and the same provenance rule the v5 step states for an absent row).
   *
   * §10.1 is explicit that no column may be dropped or narrowed, and this step
   * writes no row values at all: a fresh database (v0 -> v6) and a legacy file
   * (v5 -> v6) both end up with the same columns, and a legacy file's existing
   * S5 rows are left exactly as they were.
   *
   * ORDERING: this must run AFTER migrateSideIdentitySchema(), which stamps 5,
   * otherwise a v5 database would re-enter the v5 step against a table that does
   * not exist yet.
   */
  private migrateSideObservationSchema(): void {
    const versionResult = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const currentVersion = versionResult?.user_version ?? 0;
    if (currentVersion >= 6) return;

    // Dimension 4.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'reachability_state', 'TEXT');
    // Dimension 5.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'ui_presence_state', 'TEXT');
    // Dimension 6.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'activity_state', 'TEXT');
    // Dimension 7.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'message_evidence_state', 'TEXT');
    addColumnIfNeeded(this.db, 'pair_side_identity', 'message_ref', 'TEXT');
    addColumnIfNeeded(this.db, 'pair_side_identity', 'message_role', 'TEXT');
    addColumnIfNeeded(this.db, 'pair_side_identity', 'message_text', 'TEXT');
    addColumnIfNeeded(this.db, 'pair_side_identity', 'message_truncated', 'INTEGER');
    // Provider-supplied ordering, scoped to one provider and one session (I-7).
    addColumnIfNeeded(this.db, 'pair_side_identity', 'message_ordinal', 'INTEGER');
    // Dimension 8 for dimensions 4-7, kept separate from the S4 identity one.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'observation_capability', 'TEXT');
    // Dimension 9 for dimensions 4-7.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'observation_observed_at', 'INTEGER');
    // §5.4 freshness window.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'valid_until', 'INTEGER');
    // The S2 reading's own reason, for the same reason as the evidence column: the
    // existing `reason` explains the S5 identity dimensions, and an S2 explanation
    // written over it would erase why the identity was unknown or mismatched.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'observation_reason', 'TEXT');
    // The S2 provider evidence artifact, kept in its OWN column.
    //
    // This is deliberately not the existing `evidence_json`. That column holds the
    // S4 identity-resolution artifact; writing an S2 observation artifact over it
    // would destroy the provenance of the identity resolution, which is the same
    // overwrite defect §12's provenance model exists to prevent. Two artifacts,
    // two columns, neither shadowing the other.
    addColumnIfNeeded(this.db, 'pair_side_identity', 'observation_evidence_json', 'TEXT');

    this.db.exec('PRAGMA user_version = 6;');
  }

  /**
   * Session Pair operations schema, version 4.
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §10.2, §17.1-17.3.
   *
   * Additive only, following the `addColumnIfNeeded(...)` precedent and gated on
   * `PRAGMA user_version` exactly like the v0->v2 and v2->v3 steps:
   *
   *   operational_state  TEXT NOT NULL DEFAULT 'IDLE'  -- I-1, exactly two values
   *   stable_pair_id     TEXT                          -- C-1 safe prerequisite
   *
   * and, on `handoffs`:
   *
   *   planner_delivery_evidence_json  TEXT              -- §7.3, I-13
   *
   * The handoffs column is declared here rather than in the unconditional audit
   * above so that the version stamp and the column land together. The
   * unconditional audit also contains it, because that audit is what runs for a
   * brand-new database where `user_version` starts at 0; the gate below is what
   * guarantees a legacy file is brought forward explicitly.
   *
   * Backfill policy: every pre-existing Pair gets `operational_state = 'IDLE'`.
   * That is the ONLY safe default (§17.3) because ACTIVE grants a permission to
   * contact providers (I-2) that cannot be justified for a record that predates
   * the permission, and IDLE preserves all last-known evidence (I-3, I-10).
   *
   * `stable_pair_id` is backfilled to the row's own `id` and is never rewritten
   * afterwards, so it is a true immutable identity anchor.
   *
   * ORDERING: this must run AFTER migratePlanFirstSchema(), which stamps 3.
   */
  private migrateSessionPairOperationsSchema(): void {
    const versionResult = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const currentVersion = versionResult?.user_version ?? 0;
    if (currentVersion >= 4) return;

    addColumnIfNeeded(this.db, 'pairs', 'operational_state', "TEXT NOT NULL DEFAULT 'IDLE'");
    addColumnIfNeeded(this.db, 'pairs', 'stable_pair_id', 'TEXT');
    addColumnIfNeeded(this.db, 'handoffs', 'planner_delivery_evidence_json', 'TEXT');

    // Backfill is idempotent and only ever fills NULLs, so a re-run, a partially
    // migrated legacy file, or a column added by the unconditional audit above
    // all converge on the same state without rewriting a decided value.
    this.db.exec(`
      UPDATE pairs
         SET operational_state = 'IDLE'
       WHERE operational_state IS NULL OR operational_state NOT IN ('IDLE', 'ACTIVE');
    `);
    this.db.exec(`
      UPDATE pairs
         SET stable_pair_id = id
       WHERE stable_pair_id IS NULL OR stable_pair_id = '';
    `);

    this.db.exec('PRAGMA user_version = 4;');
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

    // --- relay_ingress: durable bootstrap root (schema v5) ---
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_ingress (
      ingress_id TEXT PRIMARY KEY,
      stable_pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      source_side TEXT NOT NULL DEFAULT 'planner',
      provider_type TEXT NOT NULL,
      external_session_id TEXT NOT NULL,
      provider_turn_identity TEXT NOT NULL,
      observed_text TEXT NOT NULL,
      content_hash TEXT,
      arm_evidence_json TEXT,
      state TEXT NOT NULL DEFAULT 'armed',
      materialized_assignment_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      observed_at INTEGER,
      UNIQUE (stable_pair_id, source_side, external_session_id, provider_turn_identity)
    );`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_ingress_pair_state ON relay_ingress(stable_pair_id, state)`);

    this.db.exec('PRAGMA user_version = 5;');
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
