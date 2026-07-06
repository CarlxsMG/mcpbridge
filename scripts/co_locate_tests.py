#!/usr/bin/env python3
"""
One-shot test-co-location script — NOT shipped with the repo (rebuilt 2026-07-06).

Moves every src/__tests__/*.test.ts to src/<feat>/__tests__/*.test.ts based on
a filename → feature-folder mapping, then rewrites imports so the moved file
still resolves the same modules:

  - Static:    from "../X.js"                       → from "../../X.js"
  - Dynamic:   import("../X.js")                    → import("../../X.js")
  - Sibling _utils: from "./_utils/X.js"            → from "<depth>/../__tests__/_utils/X.js"
  - import.meta.dir: `import.meta.dir, "../../P"`   → `import.meta.dir, "<depth+1>/../P"`
  - Root-level files (catalog, config-*, etc.)      → stay in src/__tests__/, no rewrite

This version is hardened against the openapi-discovery.test.ts case that
broke P1-4 the first time: it handles `import.meta.dir, "../../<path>"`
references by depth-aware rewrite.

Run:
    python scripts/co_locate_tests.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = ROOT / "src" / "__tests__"

# Map: filename (without ".test.ts") → feature folder under src/
MAPPING: dict[str, str] = {
    # admin/audit
    "audit-chain": "admin/audit",
    # admin/entities
    "consumers": "admin/entities",
    "schedules": "admin/entities",
    "teams": "admin/entities",
    "policies": "admin/entities",
    "approvals": "admin/entities",
    "rbac": "admin/entities",
    "alerts": "admin/entities",
    "anomaly": "admin/entities",
    "monitor": "admin/entities",
    # admin/tool-composition
    "composites": "admin/tool-composition",
    "bundles": "admin/tool-composition",
    # cli
    "cli": "cli",
    "connect-templates": "cli",
    # db
    "leader-election": "db",
    "backup": "db",
    # discovery
    "openapi-discovery": "discovery",
    "openapi-discovery-depth": "discovery",
    "openapi-discovery-pin": "discovery",
    "graphql-discovery": "discovery",
    "curl-postman-discovery": "discovery",
    "mcp-discovery": "discovery",
    # mcp
    "transports": "mcp",
    "transports-bundle": "mcp",
    "transports-sharded": "mcp",
    "transports-session-id": "mcp",
    "system-tools": "mcp",
    "registry": "mcp",
    "registry-alias-index": "mcp",
    "registry-deleting": "mcp",
    "registry-enabled": "mcp",
    "registry-forget-client": "mcp",
    "registry-guards": "mcp",
    "registry-isdeleting": "mcp",
    "registry-mcp-schema": "mcp",
    "registry-reload-on-boot": "mcp",
    "mcp-upstream": "mcp",
    "mcp-resources": "mcp",
    "mcp-progress": "mcp",
    "canary": "mcp",
    "load-balancer": "mcp",
    "tool-index": "mcp",
    "tool-search": "mcp",
    # middleware
    "cors-middleware": "middleware",
    "circuit-breaker": "middleware",
    "rate-limiter": "middleware",
    "rate-limiter-normalize": "middleware",
    "rate-limiter-tool-tier": "middleware",
    "origin-validator": "middleware",
    "origin-validator-envelope": "middleware",
    "ip-validator": "middleware",
    # observability
    "metrics": "observability",
    "tracing": "observability",
    "trace-context": "observability",
    "trace-store": "observability",
    "health-metrics": "observability",
    "traffic": "observability",
    # proxy
    "proxy": "proxy",
    "proxy-guards": "proxy",
    "proxy-mcp-dispatch": "proxy",
    "proxy-key-scope": "proxy",
    "proxy-isdeleting-guard": "proxy",
    "streaming": "proxy",
    "transform": "proxy",
    "backends": "proxy",
    "response-cache": "proxy",
    # routes
    "routes-admin": "routes",
    "routes-auth": "routes",
    "routes-auth-oidc": "routes",
    "routes-bundle-install-links": "routes",
    "routes-bundles": "routes",
    "routes-catalog": "routes",
    "routes-config-io": "routes",
    "routes-connect": "routes",
    "routes-consumers": "routes",
    "routes-discovery": "routes",
    "routes-mcp-keys": "routes",
    "routes-policies": "routes",
    "routes-register": "routes",
    "routes-tags": "routes",
    "routes-upstream-auth": "routes",
    "routes-usage": "routes",
    "routes-alerts": "routes",
    "routes-ws-proxy": "routes",
    # secrets
    "secrets-index": "secrets",
    "vault-provider": "secrets",
    # security
    "auth": "security",
    "cookies": "security",
    "jwt": "security",
    "oidc": "security",
    "oauth": "security",
    "mcp-key-store": "security",
    "mcp-auth-keys": "security",
    "startup-guards": "security",
    "key-hash": "security",
    "upstream-auth": "security",
    # tool-meta
    "tool-sensitivity": "tool-meta",
    # tool-policies
    "tool-alias": "tool-policies",
    "tool-examples": "tool-policies",
    "tool-naming": "tool-policies",
    "tool-overrides": "tool-policies",
    "pagination": "tool-policies",
    "guardrails": "tool-policies",
    "quarantine": "tool-policies",
    "coalesce": "tool-policies",
    "mock": "tool-policies",
    "redaction": "tool-policies",
    "context-budget": "tool-policies",
    "tools-patch-snapshot": "tool-policies",
    # root-level (stay in src/__tests__/, no rewrite)
    "create-app": "root",
    "config-schema": "root",
    "config-versions": "root",
    "config-parsers": "root",
    "config-io": "root",
    "bootstrap-admin": "root",
    "index": "root",
    "ha": "root",
    "ws-proxy": "root",
    "health": "root",
    "catalog": "root",
    "json-depth": "root",
    "json-depth-mounted": "root",
    "secret-box": "root",
    "sanitize": "content-filtering",
    "security-headers": "middleware",
    "session-store": "security",
    "tool-tags": "tool-meta",
    "usage": "observability",
}


def depth_between_src_and(dst_parent: Path) -> int:
    """Count the directories between `src/` and `dst_parent` (which ends in
    `__tests__/`). Used to scale every relative path rewrite.
    """
    return sum(
        1
        for p in dst_parent.relative_to(ROOT).parts
        if p not in ("src", "__tests__")
    )


def rewrite_imports(text: str, depth: int) -> str:
    extra = "../" * depth
    # Static: from "../X"
    text = re.sub(r'from\s+(["\'])\.\./', r'from \1' + extra + r'../', text)
    # Dynamic: import("../X")
    text = re.sub(r'\bimport\(\s*(["\'])\.\./', r'import(\1' + extra + r'../', text)
    # Sibling _utils reference: "./_utils/X" → "<extra>../__tests__/_utils/X"
    # (we keep _utils/ at the original location; consumers point to it
    # explicitly by the longer path).
    text = re.sub(
        r'\./_utils/',
        extra + r'../__tests__/_utils/',
        text,
    )
    # import.meta.dir path: `import.meta.dir, "../../P"` → add `extra` "../"
    # segments at the start of the path string.  This handles the
    # openapi-discovery.test.ts case where the path is two levels up
    # to reach `tests/fixtures/` at the repo root.
    def add_depth(match: re.Match[str]) -> str:
        prefix = match.group(1)  # the quote char
        path = match.group(2)  # the path content
        # Only rewrite if it starts with "../".
        if not path.startswith("../"):
            return match.group(0)
        return f"import.meta.dir, {prefix}{extra}{path}{prefix}"

    text = re.sub(
        r'import\.meta\.dir\s*,\s*(["\'])((?:\.\./)+[^"\']*)\1',
        add_depth,
        text,
    )
    return text


def main() -> None:
    files = sorted(TESTS_DIR.glob("*.test.ts"))
    plan: list[tuple[Path, Path]] = []
    skipped: list[Path] = []
    for f in files:
        stem = f.name.removesuffix(".test.ts")
        feature = MAPPING.get(stem)
        if not feature:
            skipped.append(f)
            continue
        if feature == "root":
            # Stay at src/__tests__/, no rewrite.
            target = TESTS_DIR / f.name
        else:
            target = ROOT / "src" / feature / "__tests__" / f.name
        plan.append((f, target))

    print(f"Total files: {len(files)}")
    print(f"Mapped: {len(plan)}")
    print(f"Skipped (no mapping): {len(skipped)}")

    moved = 0
    for src, dst in plan:
        if src == dst:
            print(f"  keep: {src.relative_to(ROOT)}")
            continue
        depth = depth_between_src_and(dst.parent)
        dst.parent.mkdir(parents=True, exist_ok=True)
        text = src.read_text(encoding="utf-8")
        new_text = rewrite_imports(text, depth)
        dst.write_text(new_text, encoding="utf-8")
        src.unlink()
        moved += 1
        print(f"  move: {src.relative_to(ROOT)} → {dst.relative_to(ROOT)} (depth={depth})")

    print(f"\nMoved {moved} files.")


if __name__ == "__main__":
    main()