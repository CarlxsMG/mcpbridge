/**
 * Stryker mutation-testing backstop for src/routes/config-io.ts — domain 8.
 * Baseline: 129 mutants, 18 killed / 111 survived (an existing hand-written
 * test file, routes-config-io.test.ts, covers only the plain-JSON export/
 * import happy paths and is left untouched). This file gap-fills: YAML
 * export/import, the bare-document and format-detection ternaries, a
 * genuine non-dry-run import's persistence + audit gating, and the entire
 * snapshots subsystem (list/create/get/delete/diff/rollback), which had
 * zero coverage of any kind before this. All line:col citations below were
 * read directly from reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { getConsumerByName, createConsumer, deleteConsumer } from "../../admin/entities/consumers.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-config-io-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { configIoRoutes } = await import("../../routes/config-io.js");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  configIoRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const EMPTY_DOC = {
  version: 1,
  exportedAt: 0,
  bundles: [],
  alertRules: [],
  clients: [],
  guardrails: [],
  consumers: [],
};

describe("GET /admin-api/config/export", () => {
  // Kills 3/4 (the "config.export"/"config" audit literals emptied).
  test("records the exact audit action", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        await fetch(`${baseUrl}/admin-api/config/export`, { headers: bearer() });
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "config.export", "config");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 6/8/9/10 (the `format === "yaml"` branch forced-false/emptied,
  // and the "application/yaml" content-type literal emptied).
  test("returns YAML with the exact content-type when format=yaml", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/export?format=yaml`, { headers: bearer() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/yaml");
      const text = await res.text();
      expect(text).toContain("version: 1");
      expect(text).not.toContain("{");
    });
  });
});

describe("POST /admin-api/config/import", () => {
  // Kills 14 (the `body.dryRun === true` condition forced-true, which would
  // make EVERY import a no-op preview regardless of the caller's intent)
  // and 38/39/40/41/42/43/44 (the `!dryRun` audit-gating cluster) via a
  // genuine non-dry-run import that both persists AND is audited.
  test("a non-dry-run import actually persists changes and is audited", async () => {
    await withApp(async (baseUrl) => {
      const doc = { ...EMPTY_DOC, consumers: [{ name: "cfg-io-import-consumer", monthlyQuota: 100 }] };
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/config/import`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ data: doc }),
        });
        expect(res.status).toBe(200);
        const result = (await res.json()) as { dryRun: boolean; applied: { consumers: number } };
        expect(result.dryRun).toBe(false);
        expect(result.applied.consumers).toBe(1);
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "config.import", "config", {
          applied: result.applied,
          skipped: 0,
        });
        expect(getConsumerByName("cfg-io-import-consumer")).not.toBeNull();
      } finally {
        spy.mockRestore();
        const c = getConsumerByName("cfg-io-import-consumer");
        if (c) deleteConsumer(c.id);
      }
    });
  });

  // Complementary direction: a dry-run import does not persist and is not
  // audited (the existing hand-written test already checks `dryRun: true`
  // in the response, but never that recordAudit was skipped).
  test("a dry-run import does not record an audit entry", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/config/import`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ dryRun: true, data: EMPTY_DOC }),
        });
        expect(res.status).toBe(200);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 19/20/21/22/23/24/25/27/28 (the `format==="yaml" && typeof
  // raw==="string"` compound condition and its try-body) via a genuine YAML
  // document that must actually be parsed to succeed.
  test("imports a YAML document via format:yaml + raw", async () => {
    await withApp(async (baseUrl) => {
      const raw =
        "version: 1\nexportedAt: 0\nbundles: []\nalertRules: []\nclients: []\nguardrails: []\nconsumers: []\n";
      const res = await fetch(`${baseUrl}/admin-api/config/import`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ dryRun: true, format: "yaml", raw }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { dryRun: boolean };
      expect(result.dryRun).toBe(true);
    });
  });

  // Kills the complementary direction of 20/22/24/25: format is "yaml" but
  // raw is NOT a string, so the compound `&&` must be false and the request
  // falls through to the `else` branch (using body.data), not into the YAML
  // try/catch (which would otherwise call parseYaml(undefined) and 400).
  test("format:yaml without a string raw falls back to body.data, not YAML parsing", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/import`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ dryRun: true, format: "yaml", data: EMPTY_DOC }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 29/30/31 (the catch-block's IMPORT_ERROR sendError call, code, and
  // message template emptied) via genuinely malformed YAML.
  test("malformed YAML returns the exact IMPORT_ERROR 400", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/import`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ format: "yaml", raw: "bundles: [unterminated" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("IMPORT_ERROR");
      expect(body.error.message).toContain("invalid YAML: ");
    });
  });

  // Kills 21 (the `body.format === "yaml"` sub-condition forced-true): with
  // format OMITTED but a string `raw` field present, real code must take
  // the `else` branch (using `body.data`, here an invalid-version doc that
  // 400s) rather than the forced-true mutant's YAML-parsing branch (which
  // would instead parse `raw` -- a valid document -- and succeed with 200).
  test("a string `raw` field without format:yaml is not treated as YAML", async () => {
    await withApp(async (baseUrl) => {
      const raw =
        "version: 1\nexportedAt: 0\nbundles: []\nalertRules: []\nclients: []\nguardrails: []\nconsumers: []\n";
      const res = await fetch(`${baseUrl}/admin-api/config/import`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ raw, data: { version: 999 } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("IMPORT_ERROR");
    });
  });

  // Kills 33 (the `body.data !== undefined ? body.data : body` ternary
  // forced-true, which would always use `body.data` -- even when it's
  // undefined -- and never fall back to treating the whole body as a bare
  // document).
  test("a bare document with no `data` wrapper is accepted", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/import`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify(EMPTY_DOC),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { dryRun: boolean };
      expect(result.dryRun).toBe(false);
    });
  });

  // Kills 46 (the outer catch's "IMPORT_ERROR" literal emptied) -- the
  // existing hand-written test only asserts the 400 status, never the code.
  test("import rejects an unsupported version with the exact IMPORT_ERROR code", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/import`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ data: { version: 999 } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("IMPORT_ERROR");
    });
  });
});

describe("GET /admin-api/config/snapshots", () => {
  // Kills 49 (the `{ items: listSnapshots() }` object literal emptied).
  test("lists created snapshots", async () => {
    await withApp(async (baseUrl) => {
      await fetch(`${baseUrl}/admin-api/config/snapshots`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: "cfg-io-list-snap" }),
      });
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { label: string }[] };
      expect(body.items.some((s) => s.label === "cfg-io-list-snap")).toBe(true);
    });
  });
});

describe("POST /admin-api/config/snapshots", () => {
  // Kills 53/54/55/56/57/58 (the `typeof body.label === "string"` ternary
  // cluster): a non-string label must behave like an empty/missing one.
  test("a non-string label fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("label is required (<= 120 chars)");
    });
  });

  // Kills 59/60/61/62 (the `!label` half of the guard) via a missing label.
  test("a missing label fails validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 63/64/65 (the `label.length > 120` boundary): 121 chars fails,
  // exactly 120 chars succeeds.
  test("a label over 120 chars fails, exactly 120 chars succeeds", async () => {
    await withApp(async (baseUrl) => {
      const tooLong = "x".repeat(121);
      const resTooLong = await fetch(`${baseUrl}/admin-api/config/snapshots`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: tooLong }),
      });
      expect(resTooLong.status).toBe(400);

      const exactly120 = "y".repeat(120);
      const resOk = await fetch(`${baseUrl}/admin-api/config/snapshots`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ label: exactly120 }),
      });
      expect(resOk.status).toBe(201);
      const body = (await resOk.json()) as { label: string };
      expect(body.label).toBe(exactly120);
    });
  });

  // Kills 57 (the `.trim()` call on the label removed) plus 68/69/70 (the
  // "config.snapshot.create" audit action / template literal / detail
  // object emptied).
  test("trims the label and records the exact audit entry", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "  cfg-io-trimmed  " }),
        });
        expect(res.status).toBe(201);
        const snap = (await res.json()) as { id: number; label: string };
        expect(snap.label).toBe("cfg-io-trimmed");
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "config.snapshot.create", `snapshot:${snap.id}`, {
          label: "cfg-io-trimmed",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("GET /admin-api/config/snapshots/:id", () => {
  // Kills 73/74/75/76/77/78 (the `!snap` guard and the SNAPSHOT_NOT_FOUND
  // code/message literals).
  test("an unknown snapshot id returns the exact SNAPSHOT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/999999`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SNAPSHOT_NOT_FOUND");
      expect(body.error.message).toBe("Snapshot not found");
    });
  });

  // Complementary direction: a known id returns the full snapshot detail.
  test("a known snapshot id returns its detail", async () => {
    await withApp(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-get-detail" }),
        })
      ).json()) as { id: number };
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${created.id}`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: number; label: string; config: { version: number } };
      expect(body.id).toBe(created.id);
      expect(body.label).toBe("cfg-io-get-detail");
      expect(body.config.version).toBe(1);
    });
  });
});

describe("DELETE /admin-api/config/snapshots/:id", () => {
  // Kills 81/82/83/84/85/86 (the `!ok` guard and SNAPSHOT_NOT_FOUND
  // literals).
  test("an unknown snapshot id returns the exact SNAPSHOT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/999999`, {
        method: "DELETE",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SNAPSHOT_NOT_FOUND");
      expect(body.error.message).toBe("Snapshot not found");
    });
  });

  // Kills 87/88/89/90 (the "config.snapshot.delete" audit action / template
  // literal / "deleted" status literal / response object emptied) via a
  // genuine delete confirmed by a follow-up 404.
  test("a successful delete is audited and the snapshot is actually gone", async () => {
    await withApp(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-delete-me" }),
        })
      ).json()) as { id: number };
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${created.id}`, {
          method: "DELETE",
          headers: bearer(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "deleted", id: created.id });
        expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "config.snapshot.delete", `snapshot:${created.id}`);
        const getRes = await fetch(`${baseUrl}/admin-api/config/snapshots/${created.id}`, { headers: bearer() });
        expect(getRes.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("GET /admin-api/config/snapshots/:id/diff", () => {
  // Kills 93/94/95/96/97 (the `typeof against === "string"` ternary and the
  // "current" fallback literal) via an omitted `against` query param.
  test("omitting `against` defaults to diffing against current", async () => {
    await withApp(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-diff-default" }),
        })
      ).json()) as { id: number };
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${created.id}/diff`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { to: string };
      expect(body.to).toBe("current");
    });
  });

  // Kills 98/99/100/101/102 (the `againstRaw === "current"` ternary): an
  // explicit numeric snapshot id must resolve to that snapshot's own label,
  // not "current".
  test("against=<snapshot id> diffs against that snapshot's label", async () => {
    await withApp(async (baseUrl) => {
      const from = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-diff-from" }),
        })
      ).json()) as { id: number };
      const to = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-diff-to" }),
        })
      ).json()) as { id: number };
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${from.id}/diff?against=${to.id}`, {
        headers: bearer(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { to: string };
      expect(body.to).toBe(`#${to.id} cfg-io-diff-to`);
    });
  });

  // Kills 103/104/105/106/107/108/109/110/111 (the validation compound
  // cluster: `against !== "current" && !Number.isInteger(against)`).
  test("a non-numeric against value fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-diff-badagainst" }),
        })
      ).json()) as { id: number };
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${created.id}/diff?against=not-a-number`, {
        headers: bearer(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("against must be 'current' or a snapshot id");
    });
  });

  // Kills 112/113/114/115/116/117 (the `!result` guard and
  // SNAPSHOT_NOT_FOUND literals): both an unknown :id and an unknown
  // `against` id must independently 404.
  test("an unknown snapshot id in the URL returns the exact SNAPSHOT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/999999/diff`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SNAPSHOT_NOT_FOUND");
      expect(body.error.message).toBe("Snapshot not found");
    });
  });

  test("an unknown `against` snapshot id returns the exact SNAPSHOT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/admin-api/config/snapshots`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ label: "cfg-io-diff-unknownagainst" }),
        })
      ).json()) as { id: number };
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${created.id}/diff?against=999999`, {
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SNAPSHOT_NOT_FOUND");
    });
  });
});

describe("POST /admin-api/config/snapshots/:id/rollback", () => {
  // Kills 120/121/122/123/124/125 (the `!result` guard and
  // SNAPSHOT_NOT_FOUND literals).
  test("an unknown snapshot id returns the exact SNAPSHOT_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/config/snapshots/999999/rollback`, {
        method: "POST",
        headers: bearer(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SNAPSHOT_NOT_FOUND");
      expect(body.error.message).toBe("Snapshot not found");
    });
  });

  // Kills 126/127/128 (the "config.snapshot.rollback" audit action /
  // template literal / detail object emptied) via a genuine rollback that
  // actually re-creates a consumer deleted after the snapshot was taken.
  test("a successful rollback is audited and genuinely re-applies the snapshot", async () => {
    await withApp(async (baseUrl) => {
      const consumer = createConsumer({ name: "cfg-io-rollback-consumer", monthlyQuota: 50, actor: null });
      try {
        const snap = (await (
          await fetch(`${baseUrl}/admin-api/config/snapshots`, {
            method: "POST",
            headers: bearer(),
            body: JSON.stringify({ label: "cfg-io-rollback-snap" }),
          })
        ).json()) as { id: number };
        deleteConsumer(consumer.id);
        expect(getConsumerByName("cfg-io-rollback-consumer")).toBeNull();

        const spy = spyOn(auditMod, "recordAudit");
        try {
          const res = await fetch(`${baseUrl}/admin-api/config/snapshots/${snap.id}/rollback`, {
            method: "POST",
            headers: bearer(),
          });
          expect(res.status).toBe(200);
          const result = (await res.json()) as { applied: { consumers: number } };
          expect(result.applied.consumers).toBe(1);
          expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "config.snapshot.rollback", `snapshot:${snap.id}`, {
            applied: result.applied,
            skipped: 0,
          });
          const restored = getConsumerByName("cfg-io-rollback-consumer");
          expect(restored).not.toBeNull();
        } finally {
          spy.mockRestore();
          const restored = getConsumerByName("cfg-io-rollback-consumer");
          if (restored) deleteConsumer(restored.id);
        }
      } finally {
        const leftover = getConsumerByName("cfg-io-rollback-consumer");
        if (leftover) deleteConsumer(leftover.id);
      }
    });
  });
});
