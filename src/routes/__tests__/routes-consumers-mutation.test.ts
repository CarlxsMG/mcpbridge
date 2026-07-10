/**
 * Stryker mutation-testing backstop for src/routes/consumers.ts — domain 8.
 * Baseline: 125 mutants, 58 killed / 67 survived — the existing
 * `routes-consumers.test.ts` (left untouched here) covers the create/list/
 * duplicate/usage/delete happy path, non-integer monthlyQuota validation,
 * and endUserRateLimitPerMin validation+patch+null-clear, but never
 * exercises PATCH's `name` field AT ALL, never exercises the name-length
 * boundary, never tests an unknown id on PATCH/DELETE/usage (only on
 * neither), and never asserts exact codes/messages/audit details anywhere.
 * All line:col citations below were read directly from
 * reports/mutation/result.json.
 *
 * One survivor is an accepted EQUIVALENT, not chased with a dedicated
 * test: 4:19:37-50 ObjectLiteral (`optPositiveIntOrNull`'s `{ ok: false }`
 * emptied to `{}`). Every call site consumes the result only through
 * `!x.ok`, and `!undefined` and `!false` are both `true` — there is no
 * reachable path where the emptied object's `ok` being `undefined` instead
 * of `false` changes any observable behavior.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import * as auditMod from "../../admin/audit/audit.js";

const ADMIN_KEY = "test-admin-key-consumers-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { consumerRoutes } = await import("../../routes/consumers.js");
  const app = express();
  app.use(express.json());
  consumerRoutes(app);
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

async function createConsumer(baseUrl: string, body: Record<string, unknown>): Promise<{ id: number }> {
  const res = await fetch(`${baseUrl}/admin-api/consumers`, {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify(body),
  });
  return (await res.json()) as { id: number };
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /admin-api/consumers — validation", () => {
  // Kills 18/22/23 (the name typeof-ternary's forced-true direction,
  // which would call `.trim()` on a non-string, throwing; the `.trim()`
  // call dropped; and the "" fallback replaced with a truthy
  // placeholder).
  test("a non-string name fails validation gracefully (not a crash)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  test("a whitespace-padded name is trimmed before storage", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "  padded-name  " }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("padded-name");
    });
  });

  // Kills 25/26/28/29/31/32 (the `!name || name.length > 128` cluster and
  // its exact message) via the length boundary itself.
  test("a missing name fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("name is required (1-128 chars)");
    });
  });

  test("a 129-character name fails validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "a".repeat(129) }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  test("an exactly-128-character name passes validation", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "a".repeat(128) }),
      });
      expect(res.status).toBe(201);
    });
  });

  // Kills 36/37 (the CONSUMER_EXISTS code/message emptied) -- the
  // existing duplicate test only checks the status.
  test("a duplicate name returns the exact CONSUMER_EXISTS 409", async () => {
    await withApp(async (baseUrl) => {
      await createConsumer(baseUrl, { name: "svc-consumers-dup" });
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-dup" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONSUMER_EXISTS");
      expect(body.error.message).toBe("A consumer with that name already exists");
    });
  });

  // Kills 42 (the monthlyQuota validation message emptied).
  test("an invalid monthlyQuota fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-badquota", monthlyQuota: 1.5 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("monthlyQuota must be a positive integer or null");
    });
  });

  // Kills 47 (the endUserRateLimitPerMin validation message emptied).
  test("an invalid endUserRateLimitPerMin fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-badrate", endUserRateLimitPerMin: -1 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("endUserRateLimitPerMin must be a positive integer or null");
    });
  });
});

describe("POST /admin-api/consumers — success", () => {
  // Kills 49/50 (the recordAudit action string and detail object
  // emptied).
  test("a successful creation is audited with the exact action and detail", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/consumers`, {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ name: "svc-consumers-create-ok" }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { id: number };
        expect(spy).toHaveBeenCalledWith(expect.any(String), "consumer.create", String(body.id), {
          name: "svc-consumers-create-ok",
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("PATCH /admin-api/consumers/:id", () => {
  // Kills 55/56/57/58 (the !existing guard's forced-false/block/exact
  // code+message) -- no existing test PATCHes an unknown id.
  test("an unknown id returns the exact CONSUMER_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers/999999`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "whatever" }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONSUMER_NOT_FOUND");
      expect(body.error.message).toBe("Consumer not found");
    });
  });

  // Kills 61/63 (the `body.name !== undefined` guard forced-false and its
  // block emptied) -- no existing test PATCHes the `name` field at all.
  // Kills 84 (`.trim()` dropped on the stored value) via checking the
  // ACTUAL persisted name is trimmed.
  test("updating name is applied, trimmed, and persisted", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-name-old" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "  svc-consumers-patch-name-new  " }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("svc-consumers-patch-name-new");
    });
  });

  // Kills 64/65/66/67/68/69 (the non-string-name-typeof cluster).
  test("a non-string name on PATCH fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-badtype" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: 12345 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("name must be a non-empty string");
    });
  });

  // Kills 70/71/72/73 (the `!body.name.trim()` negation-removed/MethodExpression
  // directions) via a whitespace-only name, which must fail even though
  // it's non-empty BEFORE trimming.
  test("a whitespace-only name on PATCH fails validation", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-whitespace" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "   " }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("name must be a non-empty string");
    });
  });

  // Kills 74/75/76/77/78 (the duplicate-name-on-update cluster's
  // forced-true direction, which would treat a same-name no-op PATCH as a
  // duplicate).
  test("PATCHing a consumer's name to its own current value (a no-op) succeeds", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-noop" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-patch-noop" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills the complementary "always false" direction of 74/75/76 (must
  // NOT let a genuine collision through) plus 81/82/83 (the 409 branch
  // body/exact code+message).
  test("PATCHing a consumer's name to ANOTHER existing consumer's name fails with CONSUMER_EXISTS", async () => {
    await withApp(async (baseUrl) => {
      await createConsumer(baseUrl, { name: "svc-consumers-patch-taken" });
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-mine" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-patch-taken" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONSUMER_EXISTS");
      expect(body.error.message).toBe("A consumer with that name already exists");
    });
  });

  // Kills 79 (the FIRST `.trim()` at `body.name.trim() !== existing.name`
  // dropped): with an UNPADDED no-op test alone, dropping trim() is
  // invisible since both sides already match without trimming. A
  // WHITESPACE-PADDED same-name PATCH only proves trim() ran on the LEFT
  // side -- real code short-circuits `!==` to false BEFORE ever checking
  // existence; the mutant's raw (untrimmed) comparison wrongly differs,
  // proceeds to check existence, and finds the consumer's OWN row
  // (`consumerNameExists` has no self-exclusion), wrongly 409ing.
  test("PATCHing a consumer's name to its own current value WITH padding (a no-op) succeeds", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-noop-pad" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "  svc-consumers-patch-noop-pad  " }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 80 (the SECOND `.trim()` at `consumerNameExists(body.name.trim())`
  // dropped): needs the FIRST clause to be genuinely TRUE (a real rename,
  // not a no-op) so the second clause actually gets evaluated -- renaming
  // to a PADDED version of another consumer's real name. Real code trims
  // before checking existence and correctly detects the collision (409);
  // the mutant checks existence for the raw padded string, which no
  // consumer is literally named, and wrongly lets the rename through.
  test("PATCHing a consumer's name to a WHITESPACE-PADDED collision with another consumer's name fails", async () => {
    await withApp(async (baseUrl) => {
      await createConsumer(baseUrl, { name: "svc-consumers-patch-pad-taken" });
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-pad-mine" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "  svc-consumers-patch-pad-taken  " }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CONSUMER_EXISTS");
    });
  });

  // Kills 85/86/87 (the `body.monthlyQuota !== undefined` guard's
  // forced-true direction, which would wrongly reset an OMITTED quota to
  // null) and 88 (the whole quota-update block emptied, via the
  // complementary genuine-update case below).
  test("omitting monthlyQuota on PATCH leaves the existing value untouched", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-quota-omit", monthlyQuota: 100 });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-patch-quota-omit" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { monthlyQuota: number | null };
      expect(body.monthlyQuota).toBe(100);
    });
  });

  test("updating monthlyQuota is applied", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-quota-update", monthlyQuota: 100 });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ monthlyQuota: 250 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { monthlyQuota: number | null };
      expect(body.monthlyQuota).toBe(250);
    });
  });

  // Kills 89/90/91/92/93 (the monthlyQuota `!q.ok` cluster + exact
  // message on PATCH -- distinct call site from POST's own copy).
  test("an invalid monthlyQuota on PATCH fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-quota-bad" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ monthlyQuota: 1.5 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("monthlyQuota must be a positive integer or null");
    });
  });

  // Kills 94 (the `body.endUserRateLimitPerMin !== undefined` guard's
  // forced-true direction, which would wrongly reset an OMITTED value to
  // null).
  test("omitting endUserRateLimitPerMin on PATCH leaves the existing value untouched", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, {
        name: "svc-consumers-patch-rate-omit",
        endUserRateLimitPerMin: 20,
      });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ name: "svc-consumers-patch-rate-omit" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { endUserRateLimitPerMin: number | null };
      expect(body.endUserRateLimitPerMin).toBe(20);
    });
  });

  // Kills 102 (the endUserRateLimitPerMin validation message on PATCH).
  test("an invalid endUserRateLimitPerMin on PATCH fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-rate-bad" });
      const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ endUserRateLimitPerMin: 1.5 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe("endUserRateLimitPerMin must be a positive integer or null");
    });
  });

  // Kills 103/104 (the recordAudit action string and `{fields}` detail
  // object emptied) via an exact fields-array assertion.
  test("a successful update is audited with the exact action and updated-fields list", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-patch-audit" });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, {
          method: "PATCH",
          headers: bearer(),
          body: JSON.stringify({ monthlyQuota: 50 }),
        });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith(expect.any(String), "consumer.update", String(id), {
          fields: ["monthlyQuota"],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("DELETE /admin-api/consumers/:id", () => {
  // Kills 109/110/111/112 (the !deleteConsumer guard's forced-false/
  // block/exact code+message) -- no existing test deletes an unknown id.
  test("an unknown id returns the exact CONSUMER_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers/999999`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONSUMER_NOT_FOUND");
      expect(body.error.message).toBe("Consumer not found");
    });
  });

  // Kills 113 (the recordAudit action string emptied) and 114/115 (the
  // response object/"deleted" literal emptied).
  test("a successful delete is audited and returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      const { id } = await createConsumer(baseUrl, { name: "svc-consumers-delete-ok" });
      const spy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/consumers/${id}`, { method: "DELETE", headers: bearer() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; id: number };
        expect(body).toEqual({ status: "deleted", id });
        expect(spy).toHaveBeenCalledWith(expect.any(String), "consumer.delete", String(id));
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("GET /admin-api/consumers/:id/usage", () => {
  // Kills 120/121/122/123 (the !consumer guard's forced-false/block/exact
  // code+message) -- the existing usage test only exercises a known id.
  test("an unknown id returns the exact CONSUMER_NOT_FOUND 404", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/consumers/999999/usage`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CONSUMER_NOT_FOUND");
      expect(body.error.message).toBe("Consumer not found");
    });
  });
});
