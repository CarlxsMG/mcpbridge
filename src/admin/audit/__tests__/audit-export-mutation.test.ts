/**
 * Mutation-testing backstop for src/admin/audit/audit-export.ts (CSV/HTML
 * compliance-evidence serializers). Pure functions over plain data — no DB,
 * no Express — so every test just builds fixture `AuditLogEntry[]` /
 * `AuditExportMeta` values and asserts on the exact string output.
 */
import { describe, test, expect } from "bun:test";
import { auditLogToCsv, auditLogToHtml, type AuditExportMeta } from "../audit-export.js";
import type { AuditLogEntry } from "../audit.js";

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 1,
    actor: "alice",
    action: "client.enable",
    target: "svc",
    detail: null,
    createdAt: Date.UTC(2024, 0, 15, 10, 30, 0),
    hash: null,
    ...overrides,
  };
}

function meta(overrides: Partial<AuditExportMeta> = {}): AuditExportMeta {
  return {
    generatedAt: Date.UTC(2024, 0, 15, 12, 0, 0),
    chain: { ok: true, checked: 0 },
    ...overrides,
  };
}

describe("auditLogToCsv", () => {
  test("header row is exact", () => {
    const csv = auditLogToCsv([]);
    const [header] = csv.split("\r\n");
    expect(header).toBe("id,actor,action,target,detail,createdAt,hash");
  });

  test("empty list produces only the header line, CRLF-terminated", () => {
    const csv = auditLogToCsv([]);
    expect(csv).toBe("id,actor,action,target,detail,createdAt,hash\r\n");
  });

  test("plain fields with no special characters are emitted unquoted", () => {
    const csv = auditLogToCsv([
      entry({ id: 42, actor: "alice", action: "client.enable", target: "svc", hash: "abc123" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("42,alice,client.enable,svc,,2024-01-15T10:30:00.000Z,abc123");
  });

  test("detail is JSON-stringified when present, empty string when null", () => {
    const withDetail = auditLogToCsv([entry({ id: 1, detail: { note: "x" } })]);
    const lines = withDetail.split("\r\n");
    // detail contains a comma-free JSON blob with quotes -> gets CSV-quoted
    // and its internal quotes doubled per RFC 4180.
    expect(lines[1]).toContain(`"{""note"":""x""}"`);

    const withoutDetail = auditLogToCsv([entry({ id: 2, detail: null })]);
    const lines2 = withoutDetail.split("\r\n");
    const fields = lines2[1].split(",");
    // id=2, actor, action, target, detail(empty), createdAt, hash
    expect(fields[4]).toBe("");
  });

  test("hash null becomes empty string, non-null hash passes through", () => {
    const nullHash = auditLogToCsv([entry({ id: 1, hash: null })]);
    const rowNull = nullHash.split("\r\n")[1];
    expect(rowNull.endsWith(",")).toBe(true); // trailing hash field is empty

    const withHash = auditLogToCsv([entry({ id: 1, hash: "deadbeef" })]);
    const rowHash = withHash.split("\r\n")[1];
    expect(rowHash.endsWith(",deadbeef")).toBe(true);
  });

  test("createdAt is rendered as ISO-8601", () => {
    const csv = auditLogToCsv([entry({ createdAt: Date.UTC(2023, 5, 1, 0, 0, 0) })]);
    expect(csv).toContain("2023-06-01T00:00:00.000Z");
  });

  test("id is stringified via String(), not implicit concatenation artifacts", () => {
    const csv = auditLogToCsv([entry({ id: 999 })]);
    expect(csv.split("\r\n")[1].startsWith("999,")).toBe(true);
  });

  test("field containing a comma is quoted", () => {
    const csv = auditLogToCsv([entry({ actor: "a,b" })]);
    expect(csv).toContain(`"a,b"`);
  });

  test("field containing a double quote is quoted and the quote is doubled", () => {
    const csv = auditLogToCsv([entry({ target: 'say "hi"' })]);
    expect(csv).toContain(`"say ""hi"""`);
  });

  test("field containing a CR or LF is quoted", () => {
    const csvLf = auditLogToCsv([entry({ actor: "line1\nline2" })]);
    expect(csvLf).toContain(`"line1\nline2"`);

    const csvCr = auditLogToCsv([entry({ actor: "line1\rline2" })]);
    expect(csvCr).toContain(`"line1\rline2"`);
  });

  test("multiple rows are each terminated with CRLF and preserve order", () => {
    const csv = auditLogToCsv([entry({ id: 1, actor: "first" }), entry({ id: 2, actor: "second" })]);
    const lines = csv.split("\r\n");
    // header + 2 rows + trailing empty (from the final \r\n)
    expect(lines.length).toBe(4);
    expect(lines[3]).toBe("");
    expect(lines[1]).toContain("first");
    expect(lines[2]).toContain("second");
    expect(lines[1].startsWith("1,")).toBe(true);
    expect(lines[2].startsWith("2,")).toBe(true);
  });
});

describe("auditLogToHtml — meta filter rows", () => {
  test("actor/action/from/to all render 'Any' when absent", () => {
    const html = auditLogToHtml([], meta({ actor: undefined, action: undefined, from: undefined, to: undefined }));
    expect(html).toContain("<th>Actor</th><td>Any</td>");
    expect(html).toContain("<th>Action</th><td>Any</td>");
    expect(html).toContain("<th>From</th><td>Any</td>");
    expect(html).toContain("<th>To</th><td>Any</td>");
  });

  test("the meta-table body contains exactly the 4 filter rows, in order, with nothing extra", () => {
    const html = auditLogToHtml([], meta());
    const metaTbodyMatch = html.match(/<table class="meta-table">\s*<tbody>([\s\S]*?)<\/tbody>/);
    expect(metaTbodyMatch).not.toBeNull();
    const metaTbody = metaTbodyMatch![1];
    // Exactly 4 <tr> rows -- guards against a stray extra array entry
    // (e.g. filterRows initialized non-empty) sneaking into the table.
    expect(metaTbody.match(/<tr>/g)?.length).toBe(4);
    expect(metaTbody.match(/<\/tr>/g)?.length).toBe(4);
    // Exact expected content, joined with the real "\n      " separator --
    // catches both a stray leading element AND the join-separator collapsing.
    expect(metaTbody).toBe(
      "\n      " +
        [
          "<tr><th>Actor</th><td>Any</td></tr>",
          "<tr><th>Action</th><td>Any</td></tr>",
          "<tr><th>From</th><td>Any</td></tr>",
          "<tr><th>To</th><td>Any</td></tr>",
        ].join("\n      ") +
        "\n    ",
    );
  });

  test("actor/action render their escaped values when present", () => {
    const html = auditLogToHtml([], meta({ actor: "<alice>", action: "a & b" }));
    expect(html).toContain("<th>Actor</th><td>&lt;alice&gt;</td>");
    expect(html).toContain("<th>Action</th><td>a &amp; b</td>");
  });

  test("from/to render formatted dates when present (boundary: 0 is a valid timestamp, not absent)", () => {
    const html = auditLogToHtml([], meta({ from: 0, to: Date.UTC(2024, 0, 15, 10, 30, 0) }));
    // from=0 must NOT render as "Any" -- `!== undefined` must distinguish 0 from absent.
    expect(html).toContain("<th>From</th><td>1970-01-01 00:00:00 UTC</td>");
    expect(html).toContain("<th>To</th><td>2024-01-15 10:30:00 UTC</td>");
  });
});

describe("auditLogToHtml — chain verdict", () => {
  test("intact chain renders the ok verdict with the checked count", () => {
    const html = auditLogToHtml([], meta({ chain: { ok: true, checked: 7 } }));
    expect(html).toContain(`class="chain-verdict chain-ok"`);
    expect(html).toContain("Chain intact — 7 entries cryptographically verified, no tampering detected.");
    expect(html).not.toContain(`class="chain-verdict chain-broken"`);
  });

  test("broken chain renders the tampering verdict with brokenAtId and checked count", () => {
    const html = auditLogToHtml([], meta({ chain: { ok: false, checked: 3, brokenAtId: 42 } }));
    expect(html).toContain(`class="chain-verdict chain-broken"`);
    expect(html).toContain("TAMPERING DETECTED — chain integrity breaks at entry #42 (after 3 verified entries)");
    expect(html).not.toContain('class="chain-verdict chain-ok"');
  });
});

describe("auditLogToHtml — subtitle pluralization and count", () => {
  test("zero items renders plural 'entries'", () => {
    const html = auditLogToHtml([], meta());
    expect(html).toContain("0 entries");
    expect(html).not.toContain("0 entry<");
  });

  test("exactly one item renders singular 'entry'", () => {
    const html = auditLogToHtml([entry()], meta());
    expect(html).toContain("1 entry<");
    expect(html).not.toContain("1 entries");
  });

  test("two or more items renders plural 'entries'", () => {
    const html = auditLogToHtml([entry({ id: 1 }), entry({ id: 2 })], meta());
    expect(html).toContain("2 entries");
  });

  test("subtitle includes the escaped generatedAt timestamp", () => {
    const html = auditLogToHtml([], meta({ generatedAt: Date.UTC(2024, 2, 3, 4, 5, 6) }));
    expect(html).toContain("Generated 2024-03-03 04:05:06 UTC");
  });
});

describe("auditLogToHtml — entry rows", () => {
  test("renders id, formatted date, actor, action, target for each row", () => {
    const html = auditLogToHtml(
      [
        entry({
          id: 7,
          createdAt: Date.UTC(2024, 4, 20, 15, 45, 30),
          actor: "bob",
          action: "tool.disable",
          target: "svc__tool",
        }),
      ],
      meta(),
    );
    expect(html).toContain("<td>7</td>");
    expect(html).toContain("<td>2024-05-20 15:45:30 UTC</td>");
    expect(html).toContain("<td>bob</td>");
    expect(html).toContain("<code>tool.disable</code>");
    expect(html).toContain("<td>svc__tool</td>");
  });

  test("escapes HTML-significant characters in actor/action/target", () => {
    const html = auditLogToHtml([entry({ actor: "<b>bob</b>", action: "a'b", target: 'x"y' })], meta());
    expect(html).toContain("&lt;b&gt;bob&lt;/b&gt;");
    expect(html).toContain("a&#39;b");
    expect(html).toContain("x&quot;y");
    expect(html).not.toContain("<b>bob</b>");
  });

  test("detail present is JSON-stringified, escaped, and wrapped in <code>; detail null renders empty <code></code>", () => {
    const withDetail = auditLogToHtml([entry({ id: 1, detail: { k: "<v>" } })], meta());
    expect(withDetail).toContain(`<code>{&quot;k&quot;:&quot;&lt;v&gt;&quot;}</code>`);

    const withoutDetail = auditLogToHtml([entry({ id: 2, detail: null })], meta());
    // Row's detail cell renders as an empty <code></code> element.
    expect(withoutDetail).toMatch(/<td><code><\/code><\/td>/);
  });

  test("hash present is escaped and rendered; hash null/falsy renders an empty hash cell", () => {
    const withHash = auditLogToHtml([entry({ id: 1, hash: "abc<def" })], meta());
    expect(withHash).toContain(`<td class="hash">abc&lt;def</td>`);

    const withoutHash = auditLogToHtml([entry({ id: 2, hash: null })], meta());
    expect(withoutHash).toContain(`<td class="hash"></td>`);
  });

  test("multiple rows preserve order and each item's own data", () => {
    const html = auditLogToHtml([entry({ id: 1, actor: "first" }), entry({ id: 2, actor: "second" })], meta());
    const firstIdx = html.indexOf("first");
    const secondIdx = html.indexOf("second");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
    // Each row template itself starts with its own leading newline, and rows
    // are joined with an additional "\n" -- so an intact join separator
    // leaves a blank line (two consecutive newlines) between one row's
    // closing </tr> and the next row's <tr>. If the join separator were
    // collapsed to "", only a single newline would remain.
    expect(html).toContain("</tr>\n\n      <tr>");
  });

  test("zero items renders an empty entries tbody", () => {
    const html = auditLogToHtml([], meta());
    const tbodyMatches = html.match(/<tbody>[\s\S]*?<\/tbody>/g);
    expect(tbodyMatches).not.toBeNull();
    // The second tbody (entries table) should have no <tr> rows.
    const entriesTbody = tbodyMatches![1];
    expect(entriesTbody).not.toContain("<tr>");
  });
});

describe("auditLogToHtml — static structure", () => {
  test("includes the document title, entries table header cells, and footer text", () => {
    const html = auditLogToHtml([], meta());
    expect(html).toContain("<title>Audit Log Compliance Report</title>");
    expect(html).toContain("<h1>Audit Log Compliance Report</h1>");
    expect(html).toContain("<th>ID</th>");
    expect(html).toContain("<th>When (UTC)</th>");
    expect(html).toContain("<th>Actor</th>");
    expect(html).toContain("<th>Action</th>");
    expect(html).toContain("<th>Target</th>");
    expect(html).toContain("<th>Detail</th>");
    expect(html).toContain("<th>Hash</th>");
    expect(html).toContain("Exported from MCP REST Bridge admin audit log.");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
  });
});
