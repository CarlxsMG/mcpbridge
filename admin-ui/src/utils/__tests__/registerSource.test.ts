import { describe, expect, it } from "vitest";
import {
  clientNameIssue,
  deriveFromSourceUrl,
  detectSource,
  looksLikeSchemelessUrl,
  parseHttpUrl,
  slugifyClientName,
  SOURCE_IDS,
  SOURCE_TARGETS,
} from "../registerSource";

describe("detectSource", () => {
  it("stays silent on empty input", () => {
    expect(detectSource("")).toEqual({ hasInput: false, detected: null, ambiguous: [], unsupported: null });
    expect(detectSource("   \n ")).toEqual({ hasInput: false, detected: null, ambiguous: [], unsupported: null });
  });

  it("detects a cURL paste from the leading command", () => {
    expect(detectSource("curl https://api.example.com/users").detected).toBe("curl");
    // Leading whitespace and a capitalized command are both real pastes.
    expect(detectSource("  CURL -X POST https://api.example.com/users").detected).toBe("curl");
  });

  it("does not treat a host that merely starts with 'curl' as a cURL command", () => {
    // The separating whitespace is what makes it a command; `curltest.io` is a host.
    expect(detectSource("https://curltest.io/openapi.json").detected).toBe("openapi");
  });

  it("detects a Postman collection from either export marker", () => {
    const byId = JSON.stringify({ info: { _postman_id: "abc-123", name: "Payments" }, item: [] });
    expect(detectSource(byId).detected).toBe("postman");

    const bySchema = JSON.stringify({
      info: { name: "Payments", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [],
    });
    expect(detectSource(bySchema).detected).toBe("postman");
  });

  it("detects a manual tool list from a top-level JSON array", () => {
    expect(detectSource('[{"name":"get_user","method":"GET","endpoint":"/users/1"}]').detected).toBe("manual");
  });

  it("makes no guess for JSON that is neither a collection, a tool array nor a spec", () => {
    const other = JSON.stringify({ name: "payments", tools: {} });
    expect(detectSource(other)).toEqual({ hasInput: true, detected: null, ambiguous: [], unsupported: null });
  });

  it("calls a pasted OpenAPI document unregisterable rather than a source to pick", () => {
    // POST /register takes a spec URL, never a spec body, so every source the
    // chooser could offer would fail on this input — `unsupported` is what lets
    // the form say "give me the URL" instead of offering six wrong answers.
    for (const spec of [
      JSON.stringify({ openapi: "3.1.0", info: { title: "Payments" }, paths: {} }),
      JSON.stringify({ swagger: "2.0", info: { title: "Payments" }, paths: {} }),
    ]) {
      expect(detectSource(spec)).toEqual({
        hasInput: true,
        detected: null,
        ambiguous: [],
        unsupported: "inline-openapi",
      });
    }
  });

  it("recognizes a spec pasted as YAML, including after a document marker or comment", () => {
    expect(detectSource("openapi: 3.1.0\ninfo:\n  title: Payments\n").unsupported).toBe("inline-openapi");
    expect(detectSource("# exported 2026-08-17\n---\nswagger: '2.0'\ninfo:\n").unsupported).toBe("inline-openapi");
  });

  it("does not call a nested openapi key a spec document", () => {
    // The version marker only means "this is a spec" at the top level. Firing on
    // it anywhere would claim a tool list or a config blob that merely mentions it.
    expect(detectSource('{"x-vendor":{"openapi":"3.1.0"}}').unsupported).toBeNull();
    expect(detectSource("info:\n  openapi: 3.1.0\n").unsupported).toBeNull();
  });

  it("lets a collection or tool list carrying an openapi key still register as itself", () => {
    const collection = JSON.stringify({ info: { _postman_id: "abc-123", name: "Payments" }, openapi: "3.1.0" });
    expect(detectSource(collection).detected).toBe("postman");
    const tools = JSON.stringify([{ name: "get_user", method: "GET", endpoint: "/users/1", openapi: "3.1.0" }]);
    expect(detectSource(tools).detected).toBe("manual");
  });

  it("makes no guess for malformed JSON, but registers that there is input", () => {
    expect(detectSource('{"info": {')).toEqual({ hasInput: true, detected: null, ambiguous: [], unsupported: null });
  });

  it("detects OpenAPI from a spec file extension", () => {
    expect(detectSource("https://api.example.com/openapi.json").detected).toBe("openapi");
    expect(detectSource("https://api.example.com/v3/openapi.yaml").detected).toBe("openapi");
    expect(detectSource("http://api.example.com/swagger.YML").detected).toBe("openapi");
  });

  it("detects GraphQL from the path, in preference to a spec extension", () => {
    expect(detectSource("https://api.example.com/graphql").detected).toBe("graphql");
    expect(detectSource("https://api.example.com/api/GraphQL").detected).toBe("graphql");
    expect(detectSource("https://api.example.com/graphql.json").detected).toBe("graphql");
  });

  it("refuses to guess between OpenAPI and MCP for an extension-less URL", () => {
    for (const url of ["https://mcp.example.com/mcp", "https://api.example.com/v1", "https://api.example.com"]) {
      const result = detectSource(url);
      expect(result.detected).toBeNull();
      expect(result.ambiguous).toEqual(["openapi", "mcp"]);
    }
  });

  it("makes no guess for a non-http(s) URL or free text", () => {
    expect(detectSource("ftp://api.example.com/spec.json")).toEqual({
      hasInput: true,
      detected: null,
      ambiguous: [],
      unsupported: null,
    });
    expect(detectSource("the payments API")).toEqual({
      hasInput: true,
      detected: null,
      ambiguous: [],
      unsupported: null,
    });
  });
});

describe("SOURCE_TARGETS", () => {
  it("covers every offered source id", () => {
    for (const id of SOURCE_IDS) expect(SOURCE_TARGETS[id]).toBeDefined();
  });

  it("maps each source to the kind POST /register expects", () => {
    expect(SOURCE_TARGETS.openapi.kind).toBe("rest");
    expect(SOURCE_TARGETS.curl.kind).toBe("rest");
    expect(SOURCE_TARGETS.postman.kind).toBe("rest");
    expect(SOURCE_TARGETS.manual.kind).toBe("rest");
    expect(SOURCE_TARGETS.graphql.kind).toBe("graphql");
    expect(SOURCE_TARGETS.mcp.kind).toBe("mcp");
  });

  it("gives each REST source its own discovery mode", () => {
    expect(SOURCE_TARGETS.openapi.mode).toBe("openapi");
    expect(SOURCE_TARGETS.curl.mode).toBe("curl");
    expect(SOURCE_TARGETS.postman.mode).toBe("postman");
    expect(SOURCE_TARGETS.manual.mode).toBe("manual");
  });
});

describe("parseHttpUrl", () => {
  it("accepts http and https only", () => {
    expect(parseHttpUrl("https://a.example.com/x")?.origin).toBe("https://a.example.com");
    expect(parseHttpUrl(" http://a.example.com ")?.origin).toBe("http://a.example.com");
    expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseHttpUrl("not a url")).toBeNull();
  });
});

describe("looksLikeSchemelessUrl", () => {
  it("recognizes a host paste that is only missing its scheme", () => {
    expect(looksLikeSchemelessUrl("api.example.com/openapi.json")).toBe(true);
    expect(looksLikeSchemelessUrl("localhost:8080/mcp")).toBe(true);
  });

  it("does not claim input that is already a URL, or is prose", () => {
    expect(looksLikeSchemelessUrl("https://api.example.com/openapi.json")).toBe(false);
    expect(looksLikeSchemelessUrl("the payments API")).toBe(false);
    expect(looksLikeSchemelessUrl("curl https://api.example.com")).toBe(false);
  });
});

describe("slugifyClientName", () => {
  it("reduces arbitrary text to the backend's name shape", () => {
    expect(slugifyClientName("Payments Service")).toBe("payments-service");
    expect(slugifyClientName("ACME — Billing (v2)")).toBe("acme-billing-v2");
  });

  it("never emits the reserved '__' separator, even from underscored input", () => {
    // Underscores are mapped to hyphens rather than kept: `a__b` would otherwise
    // survive verbatim and be rejected at registration.
    expect(slugifyClientName("a__b")).toBe("a-b");
    expect(slugifyClientName("payments_api")).toBe("payments-api");
    expect(slugifyClientName("Payments  ___  API")).toBe("payments-api");
  });

  it("truncates to the 63-char limit without leaving a trailing hyphen", () => {
    const slug = slugifyClientName(`${"a".repeat(62)} tail`);
    expect(slug).toHaveLength(62);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns empty string when nothing usable is left", () => {
    expect(slugifyClientName("___")).toBe("");
    expect(slugifyClientName("!!!")).toBe("");
    expect(slugifyClientName("")).toBe("");
  });
});

describe("clientNameIssue", () => {
  it("accepts a name the backend accepts", () => {
    expect(clientNameIssue("payments-svc")).toBeNull();
    expect(clientNameIssue("a")).toBeNull();
    expect(clientNameIssue("a_b")).toBeNull();
  });

  it("reports an empty name as required", () => {
    expect(clientNameIssue("")).toBe("required");
  });

  it("reports the reserved separator distinctly from a bad shape", () => {
    expect(clientNameIssue("pay__ments")).toBe("separator");
    expect(clientNameIssue("Payments")).toBe("shape");
    expect(clientNameIssue("-leading")).toBe("shape");
    expect(clientNameIssue("has space")).toBe("shape");
    expect(clientNameIssue("a".repeat(64))).toBe("shape");
  });
});

describe("deriveFromSourceUrl", () => {
  it("derives a name from the distinctive part of the host", () => {
    expect(deriveFromSourceUrl("https://api.payments.example.com/v3/openapi.json")?.name).toBe("payments-example-com");
    expect(deriveFromSourceUrl("https://www.example.com/graphql")?.name).toBe("example-com");
    expect(deriveFromSourceUrl("http://127.0.0.1:8731/openapi.json")?.name).toBe("127-0-0-1");
  });

  it("proposes the pasted URL itself as the health URL, not its origin", () => {
    // The origin is an untested guess and a health failure auto-evicts the
    // client; the pasted URL is the one the preview just fetched successfully.
    expect(deriveFromSourceUrl("https://api.example.com/v3/openapi.json")?.healthUrl).toBe(
      "https://api.example.com/v3/openapi.json",
    );
  });

  it("normalizes the URL it proposes", () => {
    expect(deriveFromSourceUrl("  http://127.0.0.1:8731/openapi.json  ")?.healthUrl).toBe(
      "http://127.0.0.1:8731/openapi.json",
    );
  });

  it("returns null for input that is not a URL", () => {
    expect(deriveFromSourceUrl("curl https://api.example.com/users")).toBeNull();
    expect(deriveFromSourceUrl('[{"name":"x"}]')).toBeNull();
  });
});
