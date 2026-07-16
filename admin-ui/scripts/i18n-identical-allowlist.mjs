// Allowlist for check-i18n.mjs's "value-equality" gate (check #4).
//
// The value-equality check flags any leaf key whose es.json value is byte-for-
// byte identical to its en.json value — the signature of a string that was
// added to both bundles but never actually translated, so a Spanish user sees
// English. That check has one false-positive class: strings that are SUPPOSED
// to read the same in both languages. This file enumerates those.
//
// Membership is by full dotted key path (the shape `walk()` yields), NOT by
// value, so each entry is a deliberate, reviewed decision about one specific
// string — and a brand-new untranslated key never slips through just because
// its English text happens to collide with an allowlisted term. Mirrors the
// orphan-check's philosophy: bias toward NOT flagging (enumerate the known-OK
// cases explicitly) so nobody reflexively "translates" a string that must stay
// identical.
//
// Legitimately-identical strings fall into a few buckets:
//   - Brand / product-feature proper nouns this UI keeps in English as domain
//     terms (Bundles, Composites, Consumers, Schedules, Teams, Playground,
//     Guards, Guardrails, Canary/failover, SSO...).
//   - Technical terms & acronyms identical across ES/EN (Endpoint, Token,
//     OAuth, Client ID, Client secret, URL, JSON, CSV, REST, GraphQL, Color,
//     Neutral, round-robin/weighted/least-conn, Model, Slug, Tags...).
//   - Code / config examples, placeholders, and glob/redaction patterns shown
//     verbatim (URLs like https://…, "user.password\nitems.*.token",
//     "payments-svc, inventory-svc", "key: value", "mobile-app", "strict"…).
//   - ICU/format-string skeletons whose translatable words are themselves
//     allowlisted terms ("Tools ({count})", "Bundles: {count}",
//     "{hour}:{minute} {period} UTC", "Diff: #{id} …", "#", "—").
//   - Fixture-derived demo labels that are literal product/vendor names
//     ("Claude Desktop", "Cursor IDE").
//
// When a new string legitimately reads the same in both languages, add its key
// here with the reasoning implied by its bucket. When the check flags a key
// that is actually just untranslated, translate it in es.json instead.

export const identicalAllowlist = new Set([
  // ── Brand / product-feature proper nouns kept in English ────────────────
  "nav.bundles.label",
  "nav.composites.label",
  "nav.keys.label",
  "nav.consumers.label",
  "nav.schedules.label",
  "nav.teams.label",
  "nav.sso.label",
  "command_palette.group_bundles",
  "command_palette.group_keys",
  "components.connect_client_dialog.fields.bundle",
  "components.connect_client_dialog.setup",
  "components.server_detail_playground.title",
  "components.server_detail_tools.table.guards",
  "components.guard_editor_guardrails.title",
  "components.overview.widget_groups.custom",
  "pages.bundles.title",
  "pages.bundles.new.fields.tools",
  "pages.keys.title",
  "pages.server_detail.tabs.tools",
  "pages.config.result.bundles",
  "pages.config.result.guardrails",

  // ── Technical terms & acronyms identical across ES/EN ───────────────────
  "common.endpoint",
  "components.share_install_link.table.token",
  "components.server_detail_upstream_auth.types.bearer",
  "components.server_detail_upstream_auth.fields.token",
  "components.server_detail_oauth.title",
  "components.server_detail_oauth.scope",
  "components.server_detail_oauth.fields.token_url",
  "components.server_detail_oauth.fields.client_id",
  "components.server_detail_oauth.fields.client_secret",
  "components.server_detail_lb.title",
  "components.server_detail_lb.strategy.round_robin",
  "components.server_detail_lb.strategy.weighted",
  "components.server_detail_lb.strategy.least_conn",
  "components.server_detail_lb.fields.target_url",
  "components.server_detail_lb.table.base_url",
  "components.server_detail_canary.title",
  "components.server_detail_canary.mode.canary",
  "components.server_detail_canary.mode.failover",
  "components.server_detail_canary.fields.secondary_url",
  "components.server_detail_tools.table.endpoint",
  "components.guard_editor.timeout_label",
  "components.guard_editor_cache_purge.title",
  "components.guard_editor_coalesce.title",
  "components.guard_editor_presentation.name_label",
  "components.guard_editor_redaction.title",
  "components.guard_editor_tags.title",
  "components.guard_editor_websocket.url_label",
  "components.guard_editor_context_budget.title",
  "components.guard_editor_context_budget.provider.openai",
  "components.guard_editor_context_budget.provider.anthropic",
  "components.guard_editor_context_budget.base_url_label",
  "components.guard_editor_context_budget.model_label",
  "components.guard_editor_context_budget.api_key_label",
  "components.guard_editor_quarantine.title",
  "components.widget_config.fields.color",
  "components.widget_config.fields.ranking",
  "components.widget_config.fields.feed",
  "components.widget_config.tone.default",
  "components.config_import.dry_run",
  "components.config_snapshots.diff_table.path",
  "pages.register_server.kind_graphql",
  "pages.audit_log.filter.actor",
  "pages.audit_log.export.json",
  "pages.audit_log.export.csv",
  "pages.audit_log.table.actor",
  "pages.audit_log.table.target",
  "pages.alerts.test",
  "pages.alerts.table.target",
  "pages.approvals.table.args",
  "pages.composites.new.fields.schema",
  "pages.composites.new.fields.steps",
  "pages.composite_detail.schema_label",
  "pages.catalog.new.kind_rest",
  "pages.catalog.new.fields.slug",
  "pages.catalog.new.fields.health_url",
  "pages.catalog.new.fields.openapi_url",
  "pages.policies.table.rate_limit",
  "pages.policies.table.timeout",
  "pages.schedules.table.target",
  "pages.schedules.table.schedule",
  "pages.schedules.new.fields.tool",
  "pages.sso_settings.fields.issuer",
  "pages.sso_settings.fields.client_id",
  "pages.sso_settings.fields.client_secret",
  "pages.sso_settings.fields.redirect_uri",
  "pages.sso_settings.fields.scopes",
  "pages.sso_settings.provisioning.role",
  "pages.teams.table.id",
  "pages.users.table.username",
  "pages.users.table.team",
  "pages.users.roles.admin",
  "pages.users.roles.auditor",
  "pages.usage.table.tool",
  "pages.usage.table.key",
  "pages.traffic.table.status_error",
  "pages.traffic.table.status_ok",
  "pages.traffic.filters.tool_label",
  "pages.traces.table.tool",
  "pages.traces.table.spans",
  "pages.traces.table.status_ok",
  "pages.traces.table.status_error",

  // ── Code / config examples, placeholders, glob & redaction patterns ─────
  "components.guard_editor_redaction.placeholder",
  "components.guard_editor_tags.placeholder",
  "components.schema_form.json_placeholder",
  "pages.bundles.new.subtitle_p2",
  "pages.keys.new.placeholders.clients",
  "pages.keys.new.placeholders.tools",
  "pages.catalog.new.placeholders.slug",
  "pages.catalog.new.placeholders.name",
  "pages.catalog.new.placeholders.health_url",
  "pages.catalog.new.placeholders.openapi_url",
  "pages.catalog.new.placeholders.mcp_url",
  "pages.consumers.name_placeholder",
  "pages.consumers.new.placeholders.name",
  "pages.policies.new.placeholders.name",
  "pages.ws_proxy_targets.placeholders.name",
  "pages.ws_proxy_targets.placeholders.backend_url",
  "pages.sso_settings.hints.scopes_p2",
  "pages.traces.session_placeholder",

  // ── ICU / format-string skeletons whose words are themselves allowlisted ─
  "components.server_detail_tools.heading",
  "components.widget_config.widget_default_title",
  "components.config_snapshots.diff_heading",
  "components.config_snapshots.table.id",
  "components.schema_form.unset",
  "pages.traces.detail_title",
  "utils.cron.time_of_day",

  // ── Proper nouns: language endonyms, browser/OS/vendor & device names ────
  "pages.account.locale_en",
  "pages.account.locale_es",
  "pages.account.device.edge",
  "pages.account.device.opera",
  "pages.account.device.chrome",
  "pages.account.device.firefox",
  "pages.account.device.safari",
  "pages.account.device.curl",
  "pages.account.device.os.windows",
  "pages.account.device.os.macos",
  "pages.account.device.os.android",
  "pages.account.device.os.ios",
  "pages.account.device.os.linux",
  "demo.fixtures.keys.by_value.Claude Desktop.label",
  "demo.fixtures.keys.by_value.Cursor IDE.label",
  "demo.fixtures.usage.by_value.Claude Desktop.label",
  "demo.fixtures.usage.by_value.Cursor IDE.label",

  // ── Short tokens identical in ES/EN ("No", "OK", "Error", "#", "—") ─────
  "pages.users.no",
]);
