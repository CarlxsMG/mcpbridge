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
  {
    id: 5,
    name: "mcp_api_keys",
    sql: `
      CREATE TABLE IF NOT EXISTS mcp_api_keys (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        label         TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        key_prefix    TEXT NOT NULL,
        scopes_json   TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        expires_at    INTEGER,
        revoked_at    INTEGER,
        last_used_at  INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        created_by    TEXT
      ) STRICT;
    `,
  },
  {
    id: 6,
    name: "client_upstream_auth",
    sql: `
      CREATE TABLE IF NOT EXISTS client_upstream_auth (
        client_name  TEXT PRIMARY KEY REFERENCES clients(name) ON DELETE CASCADE,
        auth_type    TEXT NOT NULL,
        header_name  TEXT,
        secret_enc   TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    id: 7,
    name: "tool_call_log",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_call_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name  TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        key_id       INTEGER,
        status_class TEXT NOT NULL,
        is_error     INTEGER NOT NULL,
        duration_ms  INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tool_call_log_created_at ON tool_call_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_call_log_client_tool ON tool_call_log(client_name, tool_name);
    `,
  },
  {
    id: 8,
    name: "tool_overrides",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_overrides (
        client_name           TEXT NOT NULL,
        tool_name             TEXT NOT NULL,
        description           TEXT,
        param_overrides_json  TEXT,
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 9,
    name: "alert_rules",
    sql: `
      CREATE TABLE IF NOT EXISTS alert_rules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        webhook_url   TEXT NOT NULL,
        threshold     REAL,
        min_calls     INTEGER,
        last_fired_at INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        created_by    TEXT
      ) STRICT;
    `,
  },
  {
    id: 10,
    name: "guard_policies",
    sql: `
      CREATE TABLE IF NOT EXISTS guard_policies (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        name               TEXT NOT NULL UNIQUE,
        rate_limit_per_min INTEGER,
        timeout_ms         INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        created_by         TEXT
      ) STRICT;
    `,
  },
  {
    id: 11,
    name: "tool_tags",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_tags (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        tag         TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name, tag),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tool_tags_tag ON tool_tags(tag);
    `,
  },
  {
    id: 12,
    name: "consumers",
    sql: `
      CREATE TABLE IF NOT EXISTS consumers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL UNIQUE,
        monthly_quota INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        created_by    TEXT
      ) STRICT;

      ALTER TABLE mcp_api_keys ADD COLUMN consumer_id INTEGER REFERENCES consumers(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_tool_call_log_key ON tool_call_log(key_id, created_at);
    `,
  },
  {
    id: 13,
    name: "tool_sensitivity",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_sensitivity (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        sensitive   INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      ALTER TABLE mcp_api_keys ADD COLUMN elevated INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 14,
    name: "tool_redactions",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_redactions (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        paths_json  TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 15,
    name: "expand_admin_roles",
    sql: `
      CREATE TABLE admin_users_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','operator','auditor','viewer')),
        is_active      INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_login_at  INTEGER,
        created_by     TEXT
      ) STRICT;

      INSERT INTO admin_users_new (id, username, password_hash, role, is_active, created_at, updated_at, last_login_at, created_by)
        SELECT id, username, password_hash, role, is_active, created_at, updated_at, last_login_at, created_by FROM admin_users;

      DROP TABLE admin_users;
      ALTER TABLE admin_users_new RENAME TO admin_users;
    `,
  },
  {
    id: 16,
    name: "mcp_upstreams",
    sql: `
      ALTER TABLE clients ADD COLUMN kind TEXT NOT NULL DEFAULT 'rest';
      ALTER TABLE clients ADD COLUMN mcp_url TEXT;
      ALTER TABLE clients ADD COLUMN mcp_transport TEXT;
      ALTER TABLE tools ADD COLUMN upstream_name TEXT;
    `,
  },
  {
    id: 17,
    name: "tool_override_display_name",
    sql: `
      ALTER TABLE tool_overrides ADD COLUMN display_name TEXT;
    `,
  },
  {
    id: 18,
    name: "tool_guardrails",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_guardrails (
        client_name        TEXT NOT NULL,
        tool_name          TEXT NOT NULL,
        deny_patterns_json TEXT,
        block_secrets      INTEGER NOT NULL DEFAULT 0,
        scan_responses     INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
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
