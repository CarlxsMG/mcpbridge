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
  {
    id: 19,
    name: "composite_tools",
    sql: `
      CREATE TABLE IF NOT EXISTS composite_tools (
        name              TEXT PRIMARY KEY
                            CHECK (name GLOB '[a-z0-9]*' AND length(name) BETWEEN 1 AND 63),
        description       TEXT,
        input_schema_json TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        created_by        TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS composite_tool_steps (
        composite_name     TEXT NOT NULL REFERENCES composite_tools(name) ON DELETE CASCADE,
        step_order         INTEGER NOT NULL,
        target_client      TEXT NOT NULL,
        target_tool        TEXT NOT NULL,
        args_template_json TEXT NOT NULL,
        PRIMARY KEY (composite_name, step_order)
      ) STRICT;
    `,
  },
  {
    id: 20,
    name: "tool_examples",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_examples (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        label       TEXT NOT NULL,
        args_json   TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        created_by  TEXT,
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tool_examples_tool ON tool_examples(client_name, tool_name);
    `,
  },
  {
    id: 21,
    name: "config_snapshots",
    sql: `
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        label       TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        created_by  TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_config_snapshots_created_at ON config_snapshots(created_at);
    `,
  },
  {
    id: 22,
    name: "schedules",
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type     TEXT NOT NULL CHECK (target_type IN ('client','tool')),
        client_name     TEXT NOT NULL REFERENCES clients(name) ON DELETE CASCADE,
        tool_name       TEXT,
        action          TEXT NOT NULL CHECK (action IN ('enable','disable')),
        cron            TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_run_minute INTEGER,
        created_at      INTEGER NOT NULL,
        created_by      TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_schedules_client ON schedules(client_name);
    `,
  },
  {
    id: 23,
    name: "audit_hash_chain",
    sql: `
      ALTER TABLE admin_audit_log ADD COLUMN prev_hash TEXT;
      ALTER TABLE admin_audit_log ADD COLUMN hash TEXT;
    `,
  },
  {
    id: 24,
    name: "client_canary",
    sql: `
      CREATE TABLE IF NOT EXISTS client_canary (
        client_name           TEXT PRIMARY KEY REFERENCES clients(name) ON DELETE CASCADE,
        secondary_base_url    TEXT NOT NULL,
        secondary_resolved_ip TEXT NOT NULL,
        mode                  TEXT NOT NULL CHECK (mode IN ('canary','failover')),
        weight                INTEGER NOT NULL,
        enabled               INTEGER NOT NULL DEFAULT 1,
        updated_at            INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    id: 25,
    name: "rate_counters",
    sql: `
      CREATE TABLE IF NOT EXISTS rate_counters (
        key          TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count        INTEGER NOT NULL,
        PRIMARY KEY (key, window_start)
      ) STRICT;
    `,
  },
  {
    id: 26,
    name: "teams",
    sql: `
      CREATE TABLE IF NOT EXISTS teams (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT
      ) STRICT;

      ALTER TABLE clients ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;
      ALTER TABLE admin_users ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;
    `,
  },
  {
    id: 27,
    name: "tool_cache",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_cache (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        ttl_seconds INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 28,
    name: "client_load_balancing",
    sql: `
      CREATE TABLE IF NOT EXISTS client_lb (
        client_name    TEXT PRIMARY KEY REFERENCES clients(name) ON DELETE CASCADE,
        strategy       TEXT NOT NULL CHECK (strategy IN ('round-robin','weighted','least-conn')),
        primary_weight INTEGER NOT NULL DEFAULT 1,
        enabled        INTEGER NOT NULL DEFAULT 1,
        updated_at     INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS client_upstreams (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL REFERENCES clients(name) ON DELETE CASCADE,
        base_url    TEXT NOT NULL,
        resolved_ip TEXT NOT NULL,
        weight      INTEGER NOT NULL DEFAULT 1,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_client_upstreams_client ON client_upstreams(client_name);
    `,
  },
  {
    id: 29,
    name: "tool_pagination",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_pagination (
        client_name          TEXT NOT NULL,
        tool_name            TEXT NOT NULL,
        strategy             TEXT NOT NULL CHECK (strategy IN ('cursor','page','link')),
        items_path           TEXT NOT NULL DEFAULT '',
        cursor_response_path TEXT,
        cursor_param         TEXT,
        page_param           TEXT,
        max_pages            INTEGER NOT NULL DEFAULT 10,
        enabled              INTEGER NOT NULL DEFAULT 1,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 30,
    name: "tool_streaming",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_streaming (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        format      TEXT NOT NULL CHECK (format IN ('ndjson','sse')),
        max_events  INTEGER NOT NULL DEFAULT 1000,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 31,
    name: "tool_transforms",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_transforms (
        client_name   TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        request_json  TEXT NOT NULL DEFAULT '[]',
        response_json TEXT NOT NULL DEFAULT '[]',
        enabled       INTEGER NOT NULL DEFAULT 1,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 32,
    name: "tool_mock",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_mock (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        mode        TEXT NOT NULL CHECK (mode IN ('always','fallback')),
        response    TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 33,
    name: "tool_approval",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_approval (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS approvals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name  TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        args_hash    TEXT NOT NULL,
        args_json    TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
        created_at   INTEGER NOT NULL,
        decided_at   INTEGER,
        decided_by   TEXT,
        note         TEXT,
        consumed_at  INTEGER,
        requested_by INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, id);
    `,
  },
  {
    id: 34,
    name: "tool_traffic",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_traffic (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        mcp_tool_name TEXT NOT NULL,
        client_name   TEXT,
        tool_name     TEXT,
        key_id        INTEGER,
        args_json     TEXT NOT NULL,
        preview       TEXT NOT NULL,
        is_error      INTEGER NOT NULL,
        duration_ms   INTEGER NOT NULL,
        created_at    INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tool_traffic_created ON tool_traffic(created_at);
      CREATE INDEX IF NOT EXISTS idx_tool_traffic_client_tool ON tool_traffic(client_name, tool_name);
    `,
  },
  {
    id: 35,
    name: "tool_monitor",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_monitor (
        client_name          TEXT NOT NULL,
        tool_name            TEXT NOT NULL,
        example_id           INTEGER NOT NULL,
        interval_minutes     INTEGER NOT NULL DEFAULT 15,
        enabled              INTEGER NOT NULL DEFAULT 1,
        baseline_schema_hash TEXT NOT NULL,
        last_run_minute      INTEGER,
        last_status          TEXT,
        last_error           TEXT,
        last_checked_at      INTEGER,
        drift_detected       INTEGER NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 36,
    name: "tool_backends",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_graphql (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        query       TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tool_ws (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        ws_url      TEXT NOT NULL,
        resolved_ip TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 37,
    name: "client_oauth",
    sql: `
      CREATE TABLE IF NOT EXISTS client_oauth (
        client_name       TEXT PRIMARY KEY REFERENCES clients(name) ON DELETE CASCADE,
        token_url         TEXT NOT NULL,
        client_id         TEXT NOT NULL,
        client_secret_enc TEXT NOT NULL,
        scope             TEXT,
        updated_at        INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    id: 38,
    name: "tool_coalesce",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_coalesce (
        client_name TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 39,
    name: "approval_levels",
    sql: `
      ALTER TABLE tool_approval ADD COLUMN required_levels INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE approvals ADD COLUMN required_levels INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS approval_decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
        decided_by  TEXT NOT NULL,
        decision    TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
        note        TEXT,
        decided_at  INTEGER NOT NULL,
        UNIQUE (approval_id, decided_by)
      ) STRICT;
    `,
  },
  {
    id: 40,
    name: "tool_quarantine",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_quarantine_policy (
        client_name           TEXT NOT NULL,
        tool_name              TEXT NOT NULL,
        consecutive_threshold  INTEGER NOT NULL DEFAULT 3,
        action                 TEXT NOT NULL CHECK (action IN ('block', 'force_approval', 'observe')),
        recovery_mode          TEXT NOT NULL CHECK (recovery_mode IN ('auto', 'manual')),
        cooldown_ms            INTEGER,
        updated_at             INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tool_quarantine_state (
        client_name      TEXT NOT NULL,
        tool_name        TEXT NOT NULL,
        quarantined      INTEGER NOT NULL DEFAULT 0,
        consecutive_hits INTEGER NOT NULL DEFAULT 0,
        quarantined_at   INTEGER,
        reason           TEXT,
        cooldown_until   INTEGER,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 41,
    name: "tool_ws_persistent",
    sql: `
      ALTER TABLE tool_ws ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 42,
    name: "tool_spans",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_spans (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id        TEXT NOT NULL,
        span_id         TEXT NOT NULL,
        name            TEXT NOT NULL,
        mcp_tool_name   TEXT,
        start_ms        INTEGER NOT NULL,
        end_ms          INTEGER NOT NULL,
        status_code     INTEGER NOT NULL,
        attributes_json TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tool_spans_trace ON tool_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_tool_spans_created ON tool_spans(created_at);
    `,
  },
  {
    id: 43,
    name: "consumer_end_user_rate_limit",
    sql: `
      ALTER TABLE consumers ADD COLUMN end_user_rate_limit_per_min INTEGER;
    `,
  },
  {
    id: 44,
    name: "catalog_entries",
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_entries (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        slug                    TEXT NOT NULL UNIQUE
                                  CHECK (slug GLOB '[a-z0-9]*' AND length(slug) BETWEEN 1 AND 63),
        name                    TEXT NOT NULL,
        description             TEXT,
        kind                    TEXT NOT NULL CHECK (kind IN ('rest', 'mcp')),
        category                TEXT,
        tags_json               TEXT NOT NULL DEFAULT '[]',
        icon                    TEXT,
        openapi_url             TEXT,
        health_url              TEXT,
        base_url                TEXT,
        include_tags_json       TEXT,
        exclude_operations_json TEXT,
        mcp_url                 TEXT,
        mcp_transport           TEXT CHECK (mcp_transport IN ('streamable-http', 'sse')),
        featured                INTEGER NOT NULL DEFAULT 0,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        created_by              TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_catalog_entries_category ON catalog_entries(category);
    `,
  },
  {
    id: 45,
    name: "ws_proxy_targets",
    sql: `
      CREATE TABLE IF NOT EXISTS ws_proxy_targets (
        name                TEXT PRIMARY KEY
                              CHECK (name GLOB '[a-z0-9]*' AND length(name) BETWEEN 1 AND 63),
        backend_ws_url      TEXT NOT NULL,
        resolved_ip         TEXT NOT NULL,
        max_connections     INTEGER NOT NULL DEFAULT 10,
        max_message_bytes   INTEGER NOT NULL DEFAULT 1048576,
        idle_timeout_ms     INTEGER NOT NULL DEFAULT 300000,
        enabled             INTEGER NOT NULL DEFAULT 1,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    id: 46,
    name: "bundle_install_tokens",
    sql: `
      CREATE TABLE IF NOT EXISTS bundle_install_tokens (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_name         TEXT NOT NULL REFERENCES mcp_bundles(name) ON DELETE CASCADE,
        token_hash          TEXT NOT NULL UNIQUE,
        token_prefix        TEXT NOT NULL,
        mcp_key_id          INTEGER NOT NULL REFERENCES mcp_api_keys(id) ON DELETE CASCADE,
        mcp_key_secret_enc  TEXT NOT NULL,
        created_by          TEXT,
        created_at          INTEGER NOT NULL,
        expires_at          INTEGER,
        revoked_at          INTEGER,
        last_used_at        INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_bundle_install_tokens_bundle ON bundle_install_tokens(bundle_name);
    `,
  },
  {
    id: 47,
    name: "tool_override_drift_note",
    sql: `
      ALTER TABLE tool_overrides ADD COLUMN drift_note TEXT;
    `,
  },
  {
    id: 48,
    name: "tool_spans_session_id",
    sql: `
      ALTER TABLE tool_spans ADD COLUMN session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_tool_spans_session ON tool_spans(session_id);
    `,
  },
  {
    id: 49,
    name: "tool_context_budget",
    sql: `
      CREATE TABLE IF NOT EXISTS tool_context_budget (
        client_name        TEXT NOT NULL,
        tool_name          TEXT NOT NULL,
        mode               TEXT NOT NULL CHECK (mode IN ('truncate', 'llm_summarize')) DEFAULT 'truncate',
        max_response_bytes INTEGER NOT NULL,
        llm_provider       TEXT CHECK (llm_provider IN ('openai', 'anthropic')),
        llm_base_url       TEXT,
        llm_model          TEXT,
        llm_api_key_ref    TEXT,
        updated_at         INTEGER NOT NULL,
        PRIMARY KEY (client_name, tool_name),
        FOREIGN KEY (client_name, tool_name) REFERENCES tools(client_name, name) ON DELETE CASCADE
      ) STRICT;
    `,
  },
  {
    id: 50,
    name: "oidc_sso",
    sql: `
      -- Single-row/single-provider by design (v1 scope) — the CHECK(id = 1)
      -- singleton pattern already used by _leader_lease above. client_secret_ref
      -- is an opaque blob from getSecretsProvider().encryptSecret(), NEVER a raw
      -- secret column. default_role is constrained to 'viewer' at the schema
      -- level: auto-provisioned SSO users must never default to an elevated
      -- role, so there is no configurable path (even a future UI bug) that
      -- could write anything else here — an admin must manually promote a new
      -- SSO user after reviewing them.
      CREATE TABLE IF NOT EXISTS oidc_config (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        issuer             TEXT NOT NULL,
        client_id          TEXT NOT NULL,
        client_secret_ref  TEXT NOT NULL,
        redirect_uri       TEXT NOT NULL,
        scopes             TEXT NOT NULL DEFAULT 'openid profile email',
        enabled            INTEGER NOT NULL DEFAULT 0,
        default_role       TEXT NOT NULL DEFAULT 'viewer' CHECK (default_role = 'viewer'),
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      ) STRICT;

      -- (provider, subject) -> admin_users.id, so a second IdP (or Google-vs-Okta
      -- at once) is a clean additional row rather than overloading a column on
      -- admin_users directly.
      CREATE TABLE IF NOT EXISTS admin_user_identities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        provider    TEXT NOT NULL,
        subject     TEXT NOT NULL,
        user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        UNIQUE (provider, subject)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_admin_user_identities_user ON admin_user_identities(user_id);

      -- Short-lived server-side correlator for the Authorization Code + PKCE
      -- round trip: state is the random, unguessable primary key (also sent
      -- to the IdP as the OAuth state param, so it doubles as CSRF
      -- protection), mapped to the code_verifier the callback needs to
      -- complete the token exchange. Rows are deleted the moment they're
      -- consumed (single-use) and opportunistically pruned by expiry on every
      -- read/write — see src/security/oidc.ts.
      CREATE TABLE IF NOT EXISTS oidc_auth_state (
        state          TEXT PRIMARY KEY,
        code_verifier  TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL
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
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT;`,
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
