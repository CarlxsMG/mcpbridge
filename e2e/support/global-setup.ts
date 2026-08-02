/**
 * Playwright globalSetup: brings up the fake upstream the bridge proxies to.
 *
 * The server itself lives in support/fixture-server.ts — it grew past the point
 * where inlining it here made sense once specs needed to drive its behaviour
 * (the control channel) and consume its documents (the extended OpenAPI doc,
 * the GraphQL introspection payload).
 *
 * The bridge backend (started separately by playwright.config.ts's webServer)
 * reaches it over plain loopback HTTP during discovery/registration and at
 * tool-call time — ALLOW_PRIVATE_IPS=true is what lets the backend's SSRF guard
 * accept a loopback target at all.
 *
 * Returning an async function from globalSetup makes Playwright treat it as the
 * globalTeardown — it runs in the same process, so the server handle never
 * needs to leave this module.
 */
import { startFixtureServer } from "./fixture-server";

export default async function globalSetup(): Promise<() => Promise<void>> {
  return startFixtureServer();
}
