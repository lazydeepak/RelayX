import { DatabaseSync } from 'node:sqlite';
import { IRelayRepositories } from '../interfaces.ts';
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
} from './SqliteRepositories.ts';

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
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_extern ON runtime_sessions(provider_type, external_session_id) WHERE external_session_id IS NOT NULL;`);

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
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        failure_reason TEXT,
        evidence_json TEXT
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

    addColumnIfNeeded(this.db, 'runtime_sessions', 'consecutive_observation_failures', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'last_heartbeat_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'last_observed_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'last_evidence_json', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'archived_at', 'INTEGER');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'archive_reason', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'external_session_id', 'TEXT');
    addColumnIfNeeded(this.db, 'runtime_sessions', 'external_project_ref', 'TEXT');

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

    const versionResult = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const currentVersion = versionResult?.user_version ?? 0;
    if (currentVersion < 1) {
      this.db.exec('PRAGMA user_version = 1;');
    }
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
