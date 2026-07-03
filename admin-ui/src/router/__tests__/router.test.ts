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
});
