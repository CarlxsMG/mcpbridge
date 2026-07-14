import type { AuditLogEntry } from "./audit.js";

/**
 * CSV/HTML compliance-evidence serializers for the audit log export route
 * (src/routes/admin.ts's GET /admin-api/audit-log/export). Deliberately hand
 * -rolled rather than pulling in a CSV/templating dependency — both formats
 * are small, well-understood serializations of data the route layer already
 * has in hand (see exportAuditLog in ./audit.ts, which owns all filtering).
 */

/**
 * Escapes one CSV field per RFC 4180 (quote + double embedded quotes if it
 * contains a comma, quote, or line break) AND neutralizes spreadsheet formula
 * injection: a field a spreadsheet would evaluate as a formula (leading =, +, -,
 * @, or a leading tab/CR that can front one) is prefixed with a single quote so
 * Excel/Google Sheets treats it as literal text. `actor`/`action`/`target` derive
 * from user-controlled input, so an auditor opening the export must not trigger a
 * `=HYPERLINK(...)`/`=cmd|...` payload.
 */
function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/**
 * Renders audit entries as CSV: one row per entry (id, actor, action, target,
 * detail as compact JSON, createdAt as ISO-8601, hash). Uses CRLF line endings
 * per RFC 4180; every field is passed through csvField so commas/quotes/
 * newlines embedded in `detail`'s JSON never break the column structure.
 */
export function auditLogToCsv(items: AuditLogEntry[]): string {
  const header = ["id", "actor", "action", "target", "detail", "createdAt", "hash"];
  const lines = [header.join(",")];
  for (const item of items) {
    const row = [
      String(item.id),
      item.actor,
      item.action,
      item.target,
      item.detail ? JSON.stringify(item.detail) : "",
      new Date(item.createdAt).toISOString(),
      item.hash ?? "",
    ];
    lines.push(row.map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The filters that were applied to the exported rows, plus the chain-verification result — rendered near the top of the HTML report as the evidentiary hook. */
export interface AuditExportMeta {
  actor?: string;
  action?: string;
  from?: number;
  to?: number;
  generatedAt: number;
  chain: { ok: boolean; checked: number; brokenAtId?: number };
}

function fmtDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

/**
 * Renders a self-contained, print-ready HTML compliance report: title,
 * applied filters + generated-at timestamp, a prominent tamper-evidence
 * verdict from verifyAuditChain() (the actual evidentiary value-add over a
 * raw dump), then a table of entries. No external assets, no hover/fixed-
 * position styling — this is meant to be handed to an auditor as a plain
 * document (or printed to PDF), not viewed as a themed app screenshot.
 */
export function auditLogToHtml(items: AuditLogEntry[], meta: AuditExportMeta): string {
  const filterRows: string[] = [];
  filterRows.push(`<tr><th>Actor</th><td>${meta.actor ? escapeHtml(meta.actor) : "Any"}</td></tr>`);
  filterRows.push(`<tr><th>Action</th><td>${meta.action ? escapeHtml(meta.action) : "Any"}</td></tr>`);
  filterRows.push(`<tr><th>From</th><td>${meta.from !== undefined ? escapeHtml(fmtDate(meta.from)) : "Any"}</td></tr>`);
  filterRows.push(`<tr><th>To</th><td>${meta.to !== undefined ? escapeHtml(fmtDate(meta.to)) : "Any"}</td></tr>`);

  const chainClass = meta.chain.ok ? "chain-ok" : "chain-broken";
  const chainText = meta.chain.ok
    ? `Chain intact — ${meta.chain.checked} entries cryptographically verified, no tampering detected.`
    : `TAMPERING DETECTED — chain integrity breaks at entry #${meta.chain.brokenAtId} (after ${meta.chain.checked} verified entries). Do not treat entries at or after this point as trustworthy evidence.`;

  const rows = items
    .map(
      (item) => `
      <tr>
        <td>${item.id}</td>
        <td>${escapeHtml(fmtDate(item.createdAt))}</td>
        <td>${escapeHtml(item.actor)}</td>
        <td><code>${escapeHtml(item.action)}</code></td>
        <td>${escapeHtml(item.target)}</td>
        <td><code>${item.detail ? escapeHtml(JSON.stringify(item.detail)) : ""}</code></td>
        <td class="hash">${item.hash ? escapeHtml(item.hash) : ""}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Audit Log Compliance Report</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    background: #fff;
    margin: 2rem;
    font-size: 14px;
    line-height: 1.5;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 0.25rem;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 0.5rem;
  }
  .subtitle {
    color: #444;
    margin: 0 0 1.5rem;
    font-size: 0.9rem;
  }
  .meta-table {
    border-collapse: collapse;
    margin-bottom: 1.5rem;
  }
  .meta-table th, .meta-table td {
    text-align: left;
    padding: 0.3rem 1rem 0.3rem 0;
    font-size: 0.85rem;
    vertical-align: top;
  }
  .meta-table th {
    color: #444;
    font-weight: 600;
    white-space: nowrap;
  }
  .chain-verdict {
    border: 2px solid;
    border-radius: 4px;
    padding: 0.9rem 1.1rem;
    margin-bottom: 1.5rem;
    font-weight: 600;
    font-size: 0.95rem;
  }
  .chain-ok {
    border-color: #1a7a3d;
    background: #eef8f0;
    color: #145a2e;
  }
  .chain-broken {
    border-color: #a11;
    background: #fbeaea;
    color: #7a0e0e;
  }
  table.entries {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
    font-family: "Courier New", monospace;
  }
  table.entries th, table.entries td {
    border: 1px solid #999;
    padding: 0.35rem 0.5rem;
    text-align: left;
    vertical-align: top;
    word-break: break-word;
  }
  table.entries th {
    background: #eee;
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 700;
  }
  td.hash {
    font-size: 0.68rem;
    word-break: break-all;
    max-width: 12rem;
  }
  footer {
    margin-top: 1.5rem;
    color: #666;
    font-size: 0.75rem;
    border-top: 1px solid #999;
    padding-top: 0.5rem;
  }
  @media print {
    body { margin: 1cm; }
    table.entries { font-size: 0.7rem; }
  }
</style>
</head>
<body>
  <h1>Audit Log Compliance Report</h1>
  <p class="subtitle">Generated ${escapeHtml(fmtDate(meta.generatedAt))} &middot; ${items.length} entr${items.length === 1 ? "y" : "ies"}</p>

  <table class="meta-table">
    <tbody>
      ${filterRows.join("\n      ")}
    </tbody>
  </table>

  <div class="chain-verdict ${chainClass}">${escapeHtml(chainText)}</div>

  <table class="entries">
    <thead>
      <tr>
        <th>ID</th>
        <th>When (UTC)</th>
        <th>Actor</th>
        <th>Action</th>
        <th>Target</th>
        <th>Detail</th>
        <th>Hash</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <footer>Exported from MCP REST Bridge admin audit log. This document is a point-in-time export; re-run
  GET /admin-api/audit-log/verify (or re-export) to re-check chain integrity against the live log.</footer>
</body>
</html>
`;
}
