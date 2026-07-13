# Releasing

The maintainer runbook for cutting a published, tagged release. Everything here is a
one-time / per-release checklist — the codebase is fully built and CI-green, but it has
**never been published under a real identity**, and this document is the exact path to fix
that.

## Current status (read first)

- **No git tags exist.** `docker-publish.yml` and `release-binaries.yml` both trigger
  **only on `v*` tags**, so the GHCR image and the standalone binaries the README,
  `docker-compose.yml`, and the docs advertise **have never been built**.
- `docker-compose.yml` defaults to `ghcr.io/aico-dot-team-code/mcpbridge:1.0.0` — an image
  that does not exist yet, under a repo slug that does not resolve.
- `CHANGELOG.md` marks `## [1.0.0] - 2026-07-03` as released and its footer links point at
  `.../compare/v1.0.0...HEAD` and `.../releases/tag/v1.0.0` — both **404** until a real slug
  and a real `v1.0.0` tag/release exist.
- The repo slug `aico-dot-team-code/mcpbridge` is a **placeholder** (31 tracked files; the
  top of `README.md` says so). Publishing is gated on picking the real handle.

Because HEAD is far past the `1.0.0` changelog date, tagging `v1.0.0` at HEAD would mislabel
a large body of unreleased work — see [First release](#first-release-decision) for how to
handle the initial cut specifically.

## Prerequisites

- A GitHub repository exists at the real `<org>/<repo>` you intend to publish under, added
  as the `origin` remote (`git remote add origin git@github.com:<org>/<repo>.git`).
- GHCR publishing is enabled for the repo; `docker-publish.yml` uses the built-in
  `GITHUB_TOKEN` (keyless cosign via OIDC), so no extra secrets are required.
- `bun run check` is green on the commit you intend to tag.

## Step 1 — Set the real repository slug (one sweep)

Replace every occurrence of the placeholder with your real `<org>/<repo>` slug, then delete
the now-obsolete find-and-replace comment at the top of `README.md` and `README.es.md`:

```bash
# Run from a clean tree, after everything you want in the release is committed
# (git grep only matches tracked files).
git grep -l 'aico-dot-team-code/mcpbridge' | xargs sed -i 's#aico-dot-team-code/mcpbridge#<ORG>/<REPO>#g'
```

This touches ~31 files across `README*.md`, `package.json`, `docker-compose.yml`,
`helm/`, `SECURITY.md`, `CHANGELOG.md`, `.env.example`, `.github/`, the docs, and the
`monitoring/` runbook URLs. Review the diff, then commit:

```bash
git commit -am "chore(release): set real repository slug"
```

## Step 2 — Bump the version

```bash
bun run version:bump X.Y.Z
```

`scripts/bump-version.ts` does a single targeted pass across `package.json` (root +
`admin-ui/` + `docs/`), `helm/mcp-rest-bridge/Chart.yaml`'s `appVersion`,
`docker-compose.yml`'s default image tag, and cuts a fresh dated `CHANGELOG.md` section.
The Helm **chart** `version` is independent of `appVersion` — bump it too if the chart
templates changed.

## Step 3 — Finalize the CHANGELOG

Confirm the `[Unreleased]` items moved under the new `## [X.Y.Z] - <date>` heading, edit the
date if needed, and update the footer compare/release link definitions at the bottom of the
file to reference the new tag. Commit:

```bash
git commit -am "chore(release): vX.Y.Z"
```

## Step 4 — Tag and push (this triggers the publish workflows)

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Pushing the `v*` tag fires both:

- **`docker-publish.yml`** → multi-arch (amd64 + arm64) image to
  `ghcr.io/<org>/<repo>`, with an SBOM + build-provenance attestation, a keyless cosign
  signature, and a Trivy scan surfaced in the Security tab.
- **`release-binaries.yml`** → standalone compiled binaries.

## Step 5 — Create the GitHub Release

Publish a Release for the `vX.Y.Z` tag with the CHANGELOG section as the body (or let the
release workflow attach the binaries and edit in the notes). This is what makes the
`CHANGELOG.md` `releases/tag/vX.Y.Z` footer link resolve.

## Step 6 — Verify

```bash
# Image exists and is signed (keyless — verify against the workflow identity):
docker pull ghcr.io/<org>/<repo>:X.Y.Z
cosign verify ghcr.io/<org>/<repo>:X.Y.Z \
  --certificate-identity-regexp "https://github.com/<org>/<repo>/.github/workflows/.+" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"

# docker-compose now resolves its default tag:
docker compose config | grep image

# Spot-check the README/CHANGELOG links (live-demo, GHCR, compare/release) resolve.
```

## First-release decision

For the **initial** publish, decide one of:

1. **Roll forward.** Tag the next semver at HEAD (e.g. `v1.1.0`), move the `[1.0.0]` +
   `[Unreleased]` history into that section as appropriate, and treat this as the first
   real artifact. Cleanest, since `1.0.0`'s changelog date is historical.
2. **Backfill `v1.0.0`.** Tag the commit that actually corresponds to the `1.0.0` changelog
   entry, then cut a follow-up for everything since. Only worth it if you want the
   `v1.0.0` artifact to exist for provenance.

Either way, do **not** tag `v1.0.0` at HEAD — it would label months of later work as the
`1.0.0` release.

## Cadence & versioning

This project follows [Semantic Versioning](https://semver.org) and
[Keep a Changelog](https://keepachangelog.com). Breaking changes to the admin API, the
`/mcp` transport contract, the CLI, or the DB migration sequence are **major**; new
backwards-compatible features are **minor**; fixes and doc/polish are **patch**.
