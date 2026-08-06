// ─────────────────────────────────────────────────────────────────────────────
// Demo mutation-fidelity test: proves that a write the admin UI can actually
// perform in demo mode CHANGES the demo's state.
//
// Why this exists as a separate file from demo-contract.test.ts: that test is
// static and, by its own documented design, path-level only — a resource is
// "covered" if ANY demo branch matches its path, regardless of which methods
// that branch handles. Five Administration resources (users, teams, policies,
// composites, schedules) sat inside that blind spot with catch-alls shaped
// like `if (/^\/admin-api\/policies/.test(p)) return ok({ applied: 3 })`,
// which matched EVERY method. A DELETE got back a 200 and a canned body, so
// the UI closed its confirm dialog, reloaded, and rendered the untouched row
// again — no error, nothing to report, on the public "try it" demo. The
// static test could not see it and never will.
//
// So this test asserts BEHAVIOUR instead of coverage: for every entity the UI
// can create or delete, drive demoFetch() end-to-end and assert the
// collection actually grew or shrank. A canned-body regression fails here
// immediately.
//
// Fixture state is module-level and shared across this whole file (the demo's
// arrays are live singletons — that's the point of it being a stateful mock),
// so every assertion is written as a DELTA against a count read immediately
// before the call, never against an absolute number. Tests may run in any
// order and still hold.
import { describe, expect, it } from "vitest";
import { demoFetch } from "../demo";

interface Listing<T> {
  items: T[];
}
interface UserListing {
  users: Array<{ username: string; role: string }>;
}

async function count(path: string): Promise<number> {
  const res = await demoFetch<Listing<unknown>>(path);
  return res.items.length;
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  return demoFetch(path, { method: "POST", body: JSON.stringify(body) });
}

async function del(path: string): Promise<unknown> {
  return demoFetch(path, { method: "DELETE" });
}

describe("demo mutations — creates land in the collection", () => {
  it("POST /admin-api/policies adds a policy", async () => {
    const before = await count("/admin-api/policies");
    await post("/admin-api/policies", { name: "Test policy", rateLimitPerMin: 42, timeoutMs: 1234 });
    expect(await count("/admin-api/policies")).toBe(before + 1);
  });

  it("POST /admin-api/teams adds a team", async () => {
    const before = await count("/admin-api/teams");
    await post("/admin-api/teams", { name: "Test team" });
    expect(await count("/admin-api/teams")).toBe(before + 1);
  });

  it("POST /admin-api/schedules adds a schedule", async () => {
    const before = await count("/admin-api/schedules");
    await post("/admin-api/schedules", {
      targetType: "client",
      clientName: "stripe",
      action: "disable",
      cron: "0 3 * * *",
    });
    expect(await count("/admin-api/schedules")).toBe(before + 1);
  });

  it("POST /admin-api/users adds a user", async () => {
    const before = (await demoFetch<UserListing>("/admin-api/users")).users.length;
    await post("/admin-api/users", { username: "test-user", password: "x", role: "viewer" });
    const after = await demoFetch<UserListing>("/admin-api/users");
    expect(after.users.length).toBe(before + 1);
    expect(after.users.some((u) => u.username === "test-user")).toBe(true);
  });

  // NewCompositePage redirects to `/composites/${composite.name}`, so an empty
  // response body here would navigate the user to `/composites/undefined`.
  it("POST /admin-api/composites adds a composite AND returns it for the redirect", async () => {
    const before = await count("/admin-api/composites");
    const created = await post("/admin-api/composites", {
      name: "test_composite",
      description: "d",
      inputSchema: {},
      steps: [{ tool: "a" }, { tool: "b" }],
    });
    expect(await count("/admin-api/composites")).toBe(before + 1);
    expect((created as { name: string }).name).toBe("test_composite");
  });
});

describe("demo mutations — deletes remove the row", () => {
  // The exact bug that shipped: each of these returned a canned 200 while
  // leaving the fixture array untouched.
  it("DELETE /admin-api/policies/:id removes it", async () => {
    await post("/admin-api/policies", { name: "Doomed policy", rateLimitPerMin: 1, timeoutMs: 1 });
    const list = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/policies");
    const target = list.items.find((x) => x.name === "Doomed policy");
    expect(target).toBeDefined();

    await del(`/admin-api/policies/${target!.id}`);

    const after = await demoFetch<Listing<{ id: number }>>("/admin-api/policies");
    expect(after.items.length).toBe(list.items.length - 1);
    expect(after.items.some((x) => x.id === target!.id)).toBe(false);
  });

  it("DELETE /admin-api/teams/:id removes it", async () => {
    await post("/admin-api/teams", { name: "Doomed team" });
    const list = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/teams");
    const target = list.items.find((x) => x.name === "Doomed team");
    expect(target).toBeDefined();

    await del(`/admin-api/teams/${target!.id}`);

    const after = await demoFetch<Listing<{ id: number }>>("/admin-api/teams");
    expect(after.items.some((x) => x.id === target!.id)).toBe(false);
  });

  it("DELETE /admin-api/schedules/:id removes it", async () => {
    await post("/admin-api/schedules", {
      targetType: "client",
      clientName: "doomed",
      action: "enable",
      cron: "* * * * *",
    });
    const list = await demoFetch<Listing<{ id: number; clientName: string }>>("/admin-api/schedules");
    const target = list.items.find((x) => x.clientName === "doomed");
    expect(target).toBeDefined();

    await del(`/admin-api/schedules/${target!.id}`);

    const after = await demoFetch<Listing<{ id: number }>>("/admin-api/schedules");
    expect(after.items.some((x) => x.id === target!.id)).toBe(false);
  });

  it("DELETE /admin-api/composites/:name removes it", async () => {
    await post("/admin-api/composites", { name: "doomed_composite", inputSchema: {}, steps: [] });
    const before = await count("/admin-api/composites");

    await del("/admin-api/composites/doomed_composite");

    const after = await demoFetch<Listing<{ name: string }>>("/admin-api/composites");
    expect(after.items.length).toBe(before - 1);
    expect(after.items.some((x) => x.name === "doomed_composite")).toBe(false);
  });

  it("DELETE /admin-api/users/:username removes it", async () => {
    await post("/admin-api/users", { username: "doomed-user", password: "x", role: "viewer" });
    const before = (await demoFetch<UserListing>("/admin-api/users")).users.length;

    await del("/admin-api/users/doomed-user");

    const after = await demoFetch<UserListing>("/admin-api/users");
    expect(after.users.length).toBe(before - 1);
    expect(after.users.some((u) => u.username === "doomed-user")).toBe(false);
  });

  // Consumers, alerts and mcp-keys had the SAME catch-all shape as the five
  // Administration resources above — they were just in a different block of
  // route(), which is how the first sweep missed them. Covered here so the
  // next one can't be missed either.
  it("DELETE /admin-api/consumers/:id removes it", async () => {
    await post("/admin-api/consumers", { name: "Doomed consumer", monthlyQuota: 10 });
    const list = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/consumers");
    const target = list.items.find((x) => x.name === "Doomed consumer");
    expect(target).toBeDefined();

    await del(`/admin-api/consumers/${target!.id}`);

    const after = await demoFetch<Listing<{ id: number }>>("/admin-api/consumers");
    expect(after.items.some((x) => x.id === target!.id)).toBe(false);
  });

  it("DELETE /admin-api/alerts/:id removes it", async () => {
    await post("/admin-api/alerts", {
      name: "Doomed alert",
      eventType: "error_rate",
      webhookUrl: "https://example.com/h",
      threshold: 0.5,
      minCalls: 10,
    });
    const list = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/alerts");
    const target = list.items.find((x) => x.name === "Doomed alert");
    expect(target).toBeDefined();

    await del(`/admin-api/alerts/${target!.id}`);

    const after = await demoFetch<Listing<{ id: number }>>("/admin-api/alerts");
    expect(after.items.some((x) => x.id === target!.id)).toBe(false);
  });
});

describe("demo mutations — edits read back as edited", () => {
  it("PATCH /admin-api/users/:username changes the role", async () => {
    await post("/admin-api/users", { username: "role-target", password: "x", role: "viewer" });

    await demoFetch("/admin-api/users/role-target", {
      method: "PATCH",
      body: JSON.stringify({ role: "operator" }),
    });

    const after = await demoFetch<UserListing>("/admin-api/users");
    expect(after.users.find((u) => u.username === "role-target")?.role).toBe("operator");
  });

  // Regression guard for the `*Key` trap: fixture records carry BOTH `name`
  // and a `nameKey` i18n key, and resolve.ts's localize() gives the key
  // priority. Patching `name` without dropping `nameKey` renders the canned
  // fixture translation straight back, so the edit looks like it silently
  // didn't take — the same failure class this file exists to prevent.
  it("PATCH of a translated field wins over the fixture's i18n key", async () => {
    const list = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/policies");
    // Policy id 1 is a seeded fixture and therefore carries a `nameKey`.
    const seeded = list.items.find((x) => x.id === 1);
    expect(seeded).toBeDefined();

    await demoFetch("/admin-api/policies/1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed by hand" }),
    });

    const after = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/policies");
    expect(after.items.find((x) => x.id === 1)?.name).toBe("Renamed by hand");
  });

  it("PATCH /admin-api/consumers/:id changes the quota", async () => {
    await post("/admin-api/consumers", { name: "Quota target", monthlyQuota: 100 });
    const list = await demoFetch<Listing<{ id: number; name: string }>>("/admin-api/consumers");
    const target = list.items.find((x) => x.name === "Quota target");
    expect(target).toBeDefined();

    await demoFetch(`/admin-api/consumers/${target!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Quota target", monthlyQuota: 500, endUserRateLimitPerMin: 20 }),
    });

    const after = await demoFetch<Listing<{ id: number; monthlyQuota: number | null }>>("/admin-api/consumers");
    expect(after.items.find((x) => x.id === target!.id)?.monthlyQuota).toBe(500);
  });

  // Revoke is not a delete — the row stays, but must read back as revoked.
  it("POST /admin-api/mcp-keys/:id/revoke marks the key revoked", async () => {
    const list = await demoFetch<Listing<{ id: number; revokedAt: number | null }>>("/admin-api/mcp-keys");
    const live = list.items.find((x) => x.revokedAt === null);
    expect(live).toBeDefined();

    await demoFetch(`/admin-api/mcp-keys/${live!.id}/revoke`, { method: "POST" });

    const after = await demoFetch<Listing<{ id: number; revokedAt: number | null }>>("/admin-api/mcp-keys");
    expect(after.items.find((x) => x.id === live!.id)?.revokedAt).not.toBeNull();
  });
});
