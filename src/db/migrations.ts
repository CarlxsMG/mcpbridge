import type { Database } from "bun:sqlite";
import { log } from "../logger.js";

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "clients_tools_guards",
    sql: `
      CREATE TABLE IF NOT EXISTS clients (
        name                    TEXT PRIMARY KEY
                                  CHECK (name GLOB '[a-z0-9]*' AND length(name) BETWEEN 1 AND 63),
        ip                      TEXT NOT NULL,
        health_url              TEXT NOT NULL,
        base_url                TEXT NOT NULL,
        resolved_ip             TEXT NOT NULL,
        retry_non_safe_methods  INTEGER NOT NULL DEFAULT 0,
        enabled                 INTEGER NOT NULL DEFAULT 1,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tools (
        client_name   TEXT NOT NULL REFERENCES clients(name) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        method        TEXT NOT NULL,
        endpoint      TEXT NOT NULL,
        description   TEXT NOT NULL,
        input_schema  TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (client_name, name)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS client_guards (
        client_name             TEXT PRIMARY KEY REFERENCES clients(name) ON DELETE CASCADE,
        cb_failure_threshold    INTEGER,
        cb_reset_timeout_ms     INTEGER,
        cb_half_open_timeout_ms INTEGER,
        cb_window_ms            INTEGER,
        extra_json              TEXT,
        updated_at              INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tool_guards (
        client_name          TEXT NOT NULL,
        tool_name             TEXT NOT NULL,
        rate_limit_per_min    INTEGER,
        timeout_ms            INTEGER,
        allowed_key_hashes    TEXT,
        extra_json             TEXT,
        updated_at             INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 2,
    name: "leader_lease",
    sql: `
      CREATE TABLE IF NOT EXISTS _leader_lease (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        holder_id         TEXT NOT NULL,
        lease_expires_at  INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    id: 3,
    name: "admin_auth",
    sql: `
      CREATE TABLE IF NOT EXISTS admin_users (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')),
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_login_at  INTEGER,
        created_by     TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        token_hash     TEXT NOT NULL UNIQUE,
        csrf_token     TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        revoked_at     INTEGER,
        ip_address     TEXT,
        user_agent     TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id ON admin_sessions(user_id);

      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        actor         TEXT NOT NULL,
        action        TEXT NOT NULL,
        target        TEXT NOT NULL,
        detail_json   TEXT,
        created_at    INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at);
    `,
  },
  {
    id: 4,
    name: "mcp_bundles",
    sql: `
      CREATE TABLE IF NOT EXISTS mcp_bundles (
        name         TEXT PRIMARY KEY
                       CHECK (name GLOB '[a-z0-9]*' AND length(name) BETWEEN 1 AND 63),
        description  TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        created_by   TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mcp_bundle_tools (
        bundle_name  TEXT NOT NULL REFERENCES mcp_bundles(name) ON DELETE CASCADE,
        client_name  TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (bundle_name, client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_mcp_bundle_tools_client_tool ON mcp_bundle_tools(client_name, tool_name);
    `,
  },
];

/**
 * Applies all not-yet-applied migrations in order, each inside its own transaction.
 * SQLite DDL is transactional, so a failure partway through a migration cannot
 * leave `_migrations` and the schema out of sync.
 */
export function runMigrations(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT;`
  );

  const appliedRows = db.query("SELECT id FROM _migrations").all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));

  const pending = migrations.filter((m) => !applied.has(m.id)).sort((a, b) => a.id - b.id);

  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
    });
    run();
    log("info", "Applied database migration", { id: m.id, name: m.name });
  }
}
