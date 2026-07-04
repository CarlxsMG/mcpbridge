import { describe, expect, it } from "vitest";
import { router } from "../index";

describe("router", () => {
  const routes = router.getRoutes();

  it("registers the expected top-level paths", () => {
    const paths = routes.map((r) => r.path);

    expect(paths).toContain("/overview");
    expect(paths).toContain("/servers");
    expect(paths).toContain("/login");
    expect(paths).toContain("/catalog");
    expect(paths).toContain("/config");
  });

  it("resolves '/' to a redirect to /servers", () => {
    const root = routes.find((r) => r.path === "/");

    expect(root?.redirect).toBe("/servers");
  });

  it("marks the login and not-found routes as public", () => {
    const login = router.resolve({ name: "login" });
    const notFound = router.resolve("/this-route-does-not-exist");

    expect(login.meta.public).toBe(true);
    expect(notFound.meta.public).toBe(true);
    expect(notFound.name).toBe("not-found");
  });

  it("marks admin-only routes with the admin role meta", () => {
    const users = router.resolve({ name: "users" });
    const config = router.resolve({ name: "config" });

    expect(users.meta.role).toBe("admin");
    expect(config.meta.role).toBe("admin");
  });

  it("resolves dynamic segments for server and bundle detail routes", () => {
    const serverDetail = router.resolve("/servers/my-server");
    const bundleDetail = router.resolve("/bundles/my-bundle");

    expect(serverDetail.name).toBe("server-detail");
    expect(serverDetail.params.name).toBe("my-server");
    expect(bundleDetail.name).toBe("bundle-detail");
    expect(bundleDetail.params.name).toBe("my-bundle");
  });

  it("prefers the static /new create route over the dynamic :name detail route", () => {
    // A bundle or composite literally named "new" is an accepted edge case (same
    // trade-off as /register-server living outside /servers/:name) — Vue Router
    // ranks static segments above dynamic ones regardless of registration order.
    expect(router.resolve("/bundles/new").name).toBe("bundle-new");
    expect(router.resolve("/composites/new").name).toBe("composite-new");
  });

  it("registers a dedicated create route for each list page with an inline-form-turned-page", () => {
    const names = router.getRoutes().map((r) => r.name);
    for (const name of [
      "bundle-new",
      "composite-new",
      "key-new",
      "alert-new",
      "user-new",
      "policy-new",
      "catalog-new",
      "consumer-new",
      "ws-proxy-new",
      "team-new",
      "schedule-new",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("marks the admin-only user-new and team-new routes with the admin role meta, matching /users and /teams", () => {
    expect(router.resolve({ name: "user-new" }).meta.role).toBe("admin");
    expect(router.resolve({ name: "team-new" }).meta.role).toBe("admin");
  });
});
