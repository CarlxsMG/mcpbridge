/**
 * Stryker mutation-testing backstop for src/routes/alerts.ts — domain 8.
 * Baseline: 170 mutants, 68 killed / 102 survived by the existing
 * routes-alerts.test.ts (which covers only: create+list+patch+delete happy
 * path, invalid-eventType 400, non-http-webhook 400, the test-endpoint's
 * happy-path delivery, and a blanket 401). This file gap-fills: the
 * isEventType/isHttpUrl/optNumber helper clusters, PATCH's per-field
 * validation branches (name/enabled/webhookUrl/threshold/minCalls) and its
 * 404, DELETE's 404 + exact response/audit, and POST /test's 404 + failure
 * path + exact audit. All line:col citations below were read directly from
 * reports/mutation/result.json.
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import * as auditMod from "../../admin/audit/audit.js";
import { ALERT_EVENT_TYPES } from "../../observability/alerts.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-alerts-mut";

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { alertRoutes } = await import("../../routes/alerts.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  alertRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

async function create(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/admin-api/alerts`, { method: "POST", headers: bearer(), body: JSON.stringify(body) });
}

const VALID = { name: "cb", eventType: "circuit_breaker_open", webhookUrl: "http://127.0.0.1:9/x" };

describe("POST /admin-api/alerts", () => {
  // Note: mutant 4 (isEventType's `typeof v === "string"` clause forced
  // true) is a confirmed EQUIVALENT, verified by hand-mutating the source
  // and re-running this exact suite (all pass unchanged): ALERT_EVENT_TYPES
  // is an array of string literals, so `.includes(v)` can only ever be
  // true when v genuinely IS one of those strings -- at which point
  // `typeof v === "string"` is independently already true. No non-string
  // input can make `.includes(v)` true, so forcing the typeof clause never
  // changes the compound's outcome for any reachable input.
  test("a non-string eventType is rejected with the exact message", async () => {
    await startApp();
    const res = await create({ ...VALID, eventType: 12345 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe(`eventType must be one of: ${ALERT_EVENT_TYPES.join(", ")}`);
  });

  // Kills 11 (isHttpUrl's `typeof v === "string"` clause forced true):
  // with a non-string webhookUrl, real code short-circuits to false
  // gracefully; the mutant would call `.startsWith` on a number, which
  // has no such method and throws -- the response must stay a clean 400,
  // not a 500/crash.
  test("a non-string webhookUrl is rejected gracefully, not with a crash", async () => {
    await startApp();
    const res = await create({ ...VALID, webhookUrl: 12345 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  // Kills 18 (isHttpUrl's endsWith-vs-startsWith mutation) via a genuine
  // https:// URL: a valid https:// webhook STARTS with "https://" but
  // does not END with it, so the endsWith mutant would wrongly reject it.
  test("an https:// webhook is accepted", async () => {
    await startApp();
    const res = await create({ ...VALID, webhookUrl: "https://example.com/hook" });
    expect(res.status).toBe(201);
  });

  // Kills 72 (the webhookUrl validation message emptied) -- the existing
  // hand-written test only checked the 400 status, never the message.
  test("a non-http webhook is rejected with the exact message", async () => {
    await startApp();
    const res = await create({ ...VALID, webhookUrl: "ftp://nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("webhookUrl must be an absolute http(s) URL");
  });

  // Kills 67 (the `", "` join separator emptied) -- a `.toContain` prefix
  // check can't distinguish a correctly-comma-joined list from one with
  // no separators at all; assert the exact full message.
  test("an invalid eventType lists all valid types comma-separated", async () => {
    await startApp();
    const res = await create({ ...VALID, eventType: "nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(`eventType must be one of: ${ALERT_EVENT_TYPES.join(", ")}`);
  });

  // Kills 47/51/52 (the name typeof/`.trim()`/false-branch-literal
  // cluster): a non-string name must fall back to "" gracefully (not
  // throw calling `.trim()` on a number), and the false branch's fallback
  // must genuinely be the empty string (not some other truthy filler that
  // would let validation wrongly pass).
  test("a non-string name is rejected with the exact required message", async () => {
    await startApp();
    const res = await create({ ...VALID, name: 12345 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("name is required (1-128 chars)");
  });

  // Kills 54/55/57/58/60/61 (the `!name || name.length > 128` cluster and
  // its exact message) -- POST create's own copy of this guard had no
  // missing-name test at all.
  test("a missing name is rejected with the exact message", async () => {
    await startApp();
    const res = await create({ eventType: "circuit_breaker_open", webhookUrl: "http://127.0.0.1:9/x" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("name is required (1-128 chars)");
  });

  // Kills the `name.length > 128` boundary (57/58): 129 chars fails,
  // exactly 128 chars succeeds.
  test("a name over 128 chars fails, exactly 128 chars succeeds", async () => {
    await startApp();
    const tooLong = "x".repeat(129);
    const resTooLong = await create({ ...VALID, name: tooLong });
    expect(resTooLong.status).toBe(400);

    const exactly128 = "y".repeat(128);
    const resOk = await create({ ...VALID, name: exactly128 });
    expect(resOk.status).toBe(201);
    const rule = (await resOk.json()) as { name: string };
    expect(rule.name).toBe(exactly128);
  });

  // Kills 51 (the `.trim()` call itself removed): a padded name must be
  // stored trimmed.
  test("a padded name is trimmed on create", async () => {
    await startApp();
    const res = await create({ ...VALID, name: "  padded-name  " });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as { name: string };
    expect(rule.name).toBe("padded-name");
  });

  // Kills 74/75/78/79 (the `!threshold.ok || !minCalls.ok` cluster): each
  // field's own invalidity must independently 400, proving `||` not `&&`.
  test("an invalid threshold alone is rejected even with a valid minCalls", async () => {
    await startApp();
    const res = await create({ ...VALID, threshold: "nope", minCalls: 5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("threshold and minCalls must be numbers");
  });

  test("an invalid minCalls alone is rejected even with a valid threshold", async () => {
    await startApp();
    const res = await create({ ...VALID, threshold: 5, minCalls: "nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("threshold and minCalls must be numbers");
  });

  // Kills 30/31/32/33/34/35 (optNumber's typeof/isFinite cluster) via a
  // raw non-finite numeric literal that JSON.stringify(Infinity) could
  // never produce (it silently serializes to `null`, itself a VALID
  // value) -- must send a raw overflowing literal to reach Infinity
  // through JSON.parse.
  test("a numeric overflow literal (non-finite) threshold is rejected", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts`, {
      method: "POST",
      headers: bearer(),
      body: `{"name":"cb","eventType":"circuit_breaker_open","webhookUrl":"http://127.0.0.1:9/x","threshold":1e400}`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("threshold and minCalls must be numbers");
  });

  // Kills 36/37/38/39 (optNumber's ok:true/value and ok:false object
  // literals) and 21/26/27 (the undefined-or-null cluster) via a genuine
  // real-number threshold/minCalls that must round-trip exactly, plus an
  // explicit `null` for minCalls.
  test("a valid numeric threshold and null minCalls are persisted exactly", async () => {
    await startApp();
    const res = await create({ ...VALID, threshold: 42, minCalls: null });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as { threshold: number | null; minCalls: number | null };
    expect(rule.threshold).toBe(42);
    expect(rule.minCalls).toBeNull();
  });

  // Kills 81/82 (the "alert.create" audit action / detail object emptied).
  test("records the exact audit action and detail", async () => {
    await startApp();
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await create(VALID);
      const rule = (await res.json()) as { id: number };
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "alert.create", String(rule.id), {
        eventType: "circuit_breaker_open",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("PATCH /admin-api/alerts/:id", () => {
  // Kills 87/88/89/90 (the `!getAlertRule(id)` guard and ALERT_NOT_FOUND
  // literals) -- PATCH's 404 had zero coverage at baseline.
  test("an unknown id returns the exact ALERT_NOT_FOUND 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts/999999`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ALERT_NOT_FOUND");
    expect(body.error.message).toBe("Alert rule not found");
  });

  // Kills 91 (the `?? {}` body fallback flipped to `&&`).
  test("no request body at all does not crash and reports no changes", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  // Kills 93/95/96/97/98/99/100/101/102/103/104/105/106 (the name
  // typeof/trim cluster).
  test("a non-string name fails validation with the exact message", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: 12345 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("name must be a non-empty string");
  });

  test("a whitespace-only name fails validation", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("a valid name update is trimmed and persisted", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "  renamed  " }),
    });
    expect(res.status).toBe(200);
    const rule = (await res.json()) as { name: string };
    expect(rule.name).toBe("renamed");
  });

  // Kills 107/108/109/110/112/115/116 (the enabled typeof-boolean cluster).
  test("a non-boolean enabled fails validation with the exact message", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ enabled: "false" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("enabled must be a boolean");
  });

  // Kills 118/120/121/122/123/124/125 (isHttpUrl reused for the update
  // path).
  test("an invalid webhookUrl update fails validation with the exact message", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ webhookUrl: "ftp://nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("webhookUrl must be an absolute http(s) URL");
  });

  test("a valid webhookUrl update is persisted", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    // Loopback (like VALID) so it passes the store-time SSRF check under the
    // test's ALLOW_PRIVATE_IPS; a distinct path proves the update took effect.
    const updatedUrl = "http://127.0.0.1:9/updated";
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ webhookUrl: updatedUrl }),
    });
    expect(res.status).toBe(200);
    const rule = (await res.json()) as { webhookUrl: string };
    expect(rule.webhookUrl).toBe(updatedUrl);
  });

  // Kills 126/127/128/129/130/131/132/133/134 (threshold's optNumber
  // re-validation on update).
  test("an invalid threshold update fails with the exact message", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ threshold: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("threshold must be a number or null");
  });

  test("a valid threshold update (including null) is persisted", async () => {
    await startApp();
    const created = (await (await create({ ...VALID, threshold: 5 })).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ threshold: null }),
    });
    expect(res.status).toBe(200);
    const rule = (await res.json()) as { threshold: number | null };
    expect(rule.threshold).toBeNull();
  });

  // Kills 135/136/137/138/139/140/141/142/143 (minCalls' optNumber
  // re-validation on update).
  test("an invalid minCalls update fails with the exact message", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ minCalls: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("minCalls must be a number or null");
  });

  test("a valid minCalls update is persisted", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ minCalls: 7 }),
    });
    expect(res.status).toBe(200);
    const rule = (await res.json()) as { minCalls: number | null };
    expect(rule.minCalls).toBe(7);
  });

  // Kills 135 (the `body.minCalls !== undefined` guard forced true):
  // forced-true would always process minCalls (as `undefined`, via
  // optNumber -> {ok:true, value:null}) even when the caller never sent
  // it, wiping an existing value to null. Omitting minCalls entirely from
  // an update to a different field must leave it untouched.
  test("omitting minCalls from an update leaves the existing value untouched", async () => {
    await startApp();
    const created = (await (await create({ ...VALID, minCalls: 5 })).json()) as { id: number; minCalls: number };
    expect(created.minCalls).toBe(5);
    const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "renamed-only" }),
    });
    expect(res.status).toBe(200);
    const rule = (await res.json()) as { minCalls: number | null };
    expect(rule.minCalls).toBe(5);
  });

  // Kills 144/145 (the "alert.update" audit action / {fields} detail
  // emptied) via a genuine multi-field update.
  test("records the exact audit action and changed-fields list", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ enabled: false, minCalls: 3 }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "alert.update", String(created.id), {
        fields: ["enabled", "minCalls"],
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("DELETE /admin-api/alerts/:id", () => {
  // Kills 150/151/152/153 (the `!deleteAlertRule(id)` guard and
  // ALERT_NOT_FOUND literals) -- DELETE's 404 had zero coverage.
  test("an unknown id returns the exact ALERT_NOT_FOUND 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts/999999`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ALERT_NOT_FOUND");
    expect(body.error.message).toBe("Alert rule not found");
  });

  // Kills 154/155/156 (the "alert.delete" audit action / {status,id}
  // response object emptied) -- the existing test only checked status
  // 200, never the response body or the audit call.
  test("a successful delete is audited and returns the exact response shape", async () => {
    await startApp();
    const created = (await (await create(VALID)).json()) as { id: number };
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; id: number };
      expect(body).toEqual({ status: "deleted", id: created.id });
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "alert.delete", String(created.id));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /admin-api/alerts/:id/test", () => {
  // Kills 161/162/163/164 (the `!getAlertRule(id)` guard and
  // ALERT_NOT_FOUND literals) -- this endpoint's 404 had zero coverage.
  test("an unknown id returns the exact ALERT_NOT_FOUND 404", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/alerts/999999/test`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ALERT_NOT_FOUND");
    expect(body.error.message).toBe("Alert rule not found");
  });

  // Kills 165/166/167/168/169 (the "alert.test" audit action / {ok}
  // detail / response {status,reason} emptied) via a genuine DELIVERY
  // FAILURE (unreachable webhook) -- the existing test only exercised the
  // success path.
  test("a failed delivery is audited and returns the exact 502 shape", async () => {
    await startApp();
    const created = (await (await create({ ...VALID, webhookUrl: "http://127.0.0.1:1/unreachable" })).json()) as {
      id: number;
    };
    const spy = spyOn(auditMod, "recordAudit");
    try {
      const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}/test`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("failed");
      expect(spy).toHaveBeenCalledWith("bearer:admin-api-key", "alert.test", String(created.id), { ok: false });
    } finally {
      spy.mockRestore();
    }
  });

  // Kills 168 (the success-path "sent" status literal emptied) -- the
  // existing hand-written test only checked the HTTP status (200) and a
  // delivery counter, never the response body's own `status` field.
  test("a successful delivery returns the exact sent status", async () => {
    await startApp();
    const recv = express();
    recv.post("/hook", (_req, res) => res.json({ ok: true }));
    const recvServer = await new Promise<Server>((resolve) => {
      const s = recv.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (recvServer.address() as AddressInfo).port;
    try {
      const created = (await (await create({ ...VALID, webhookUrl: `http://127.0.0.1:${port}/hook` })).json()) as {
        id: number;
      };
      const res = await fetch(`${baseUrl}/admin-api/alerts/${created.id}/test`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("sent");
    } finally {
      recvServer.close();
    }
  });
});
