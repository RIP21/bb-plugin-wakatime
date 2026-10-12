/**
 * The plugin's one SQLite schema, shared by heartbeat reporting and the
 * activity dashboard.
 *
 * bb records each statement's hash under its index and refuses to load if a
 * recorded index changes. The dashboard's statements come first, unchanged,
 * because they are what the existing data.db was built with; heartbeat
 * reporting's `activity` table is appended after them. Append only.
 */

export const MIGRATIONS: string[] = [
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      project_name TEXT,
      machine_name TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_open
       ON sessions(thread_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      session_id INTEGER,
      provider_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'unknown',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_unique ON turns(thread_id, turn_id)`,
    `CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_turns_open ON turns(thread_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS poll_cursors (
      thread_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL,
      active_turn_id TEXT,
      pending_interaction_ids TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS session_metadata (
      session_id INTEGER PRIMARY KEY,
      project_id TEXT,
      host_id TEXT,
      quality TEXT NOT NULL DEFAULT 'legacy-unknown',
      closure_reason TEXT NOT NULL DEFAULT 'legacy-unknown'
    )`,
    `CREATE TABLE IF NOT EXISTS turn_metadata (
      turn_row_id INTEGER PRIMARY KEY,
      attribution_quality TEXT NOT NULL DEFAULT 'legacy-unknown',
      closure_reason TEXT NOT NULL DEFAULT 'legacy-unknown'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_session_metadata_project ON session_metadata(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_turn_metadata_quality ON turn_metadata(attribution_quality)`,
    // Per-turn evidence, never the plugin process's heartbeat.
    `CREATE TABLE IF NOT EXISTS turn_observations (
      turn_row_id INTEGER PRIMARY KEY,
      confirmed_at INTEGER NOT NULL
    )`,
    `ALTER TABLE turn_metadata ADD COLUMN accounting_version INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS turn_history_segments (
      turn_row_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      PRIMARY KEY (turn_row_id, ordinal)
    )`,
  // Heartbeat reporting.
    `CREATE TABLE IF NOT EXISTS activity (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       sent_at INTEGER NOT NULL,
       host_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       entity TEXT NOT NULL,
       category TEXT NOT NULL,
       is_write INTEGER NOT NULL,
       line_changes INTEGER,
       ok INTEGER NOT NULL,
       error TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS activity_sent_at ON activity (sent_at DESC)`,
    // Appended, never edited: migration ids are statement indexes.
    `ALTER TABLE activity ADD COLUMN project TEXT`,
];
