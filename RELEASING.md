# Releasing

The maintainer runbook for cutting a published, tagged release. Everything here is a
one-time / per-release checklist — the codebase is fully built and CI-green, but it has
**never been published**, and this document is the exact path to fix that.

## Current status (read first)

- **No git tags exist.** `docker-publish.yml` and `release-binaries.yml` both trigger
  **only on `v*` tags**, so the GHCR image and the standalone binaries the README,
  `docker-compose.yml`, and the docs advertise **have never been built**.
- `docker-compose.yml` now builds from local source (`build: .`) because no image is
  published; its `image:` tag `ghcr.io/carlxsmg/mcpbridge:1.0.0` won't resolve until
  you publish (at which point comment `build:` back out so it pulls the signed image).
- `CHANGELOG.md` marks `## [1.0.0] - 2026-07-03` as released and its footer links point at
  `.../compare/v1.0.0...HEAD` and `.../releases/tag/v1.0.0` — both **404** until a real
  `v1.0.0` tag/release exists.
- The repository slug is set to **`CarlxsMG/mcpbridge`** across every tracked file. Its three
  casings are deliberate and **not** interchangeable: `github.com/CarlxsMG/mcpbridge` uses the
  canonical account casing, while `ghcr.io/carlxsmg/mcpbridge` and `carlxsmg.github.io/mcpbridge`
  must stay **lowercase** — Docker rejects uppercase repository names, and GitHub Pages hosts
  are lowercase. `docs/.vitepress/config.mts` derives both forms from one `GH_USER` constant
  via `.toLowerCase()`, so change it there rather than in the derived URLs. See
  [Renaming or forking](#renaming-or-forking-skip-unless-the-slug-changes) if the slug moves.

Because HEAD is far past the `1.0.0` changelog date, tagging `v1.0.0` at HEAD would mislabel
a large body of unreleased work — see [First release](#first-release-decision) for how to
handle the initial cut specifically.

## Prerequisites

- A GitHub repository exists at `CarlxsMG/mcpbridge`, added as the `origin` remote
  (`git remote add origin git@github.com:CarlxsMG/mcpbridge.git`).
- GHCR publishing is enabled for the repo; `docker-publish.yml` uses the built-in
  `GITHUB_TOKEN` (keyless cosign via OIDC), so no extra secrets are required.
- `bun run check` is green on the commit you intend to tag.

## Renaming or forking (skip unless the slug changes)

The slug is already set repo-wide, so this section only matters if you transfer the repo,
rename it, or publish a fork. It lives in **three URL shapes plus a derived constant**, so a
single find-and-replace is **not** enough — and two of the shapes must be lowercased. Replace
them in this order, from a clean tree (`git grep` only matches tracked files):

```bash
# 1. Pages host — lowercase, and the more specific pattern, so do it FIRST.
git grep -l 'carlxsmg\.github\.io' \
  | xargs sed -i 's#carlxsmg\.github\.io#<owner-lowercased>.github.io#g'

# 2. GHCR image path — lowercase; Docker rejects uppercase repository names.
git grep -l 'ghcr\.io/carlxsmg' \
  | xargs sed -i 's#ghcr\.io/carlxsmg#ghcr.io/<owner-lowercased>#g'

# 3. Everything else — canonical account casing: github.com URLs, package.json's
#    repository/homepage/bugs, .github/CODEOWNERS, and the GH_USER constant in
#    docs/.vitepress/config.mts (which derives shapes 1 and 2 via .toLowerCase()).
git grep -l 'CarlxsMG' | xargs sed -i 's#CarlxsMG#<Owner>#g'

# 4. Verify nothing remains — this must print nothing:
git grep -n 'CarlxsMG\|carlxsmg'
```

`docker-publish.yml` lowercases `${{ github.repository }}` itself, so the workflow needs no
edit. If the **repo name** changes too, also update `GH_REPO` in `docs/.vitepress/config.mts`
(it drives the Pages base path). Review the diff, then commit.

## Step 1 — Bump the version

```bash
bun run version:bump X.Y.Z
```

`scripts/bump-version.ts` does a single targeted pass across `package.json` (root +
`admin-ui/` + `docs/`), `helm/mcp-rest-bridge/Chart.yaml`'s `appVersion`,
`docker-compose.yml`'s default image tag, and cuts a fresh dated `CHANGELOG.md` section.
The Helm **chart** `version` is independent of `appVersion` — bump it too if the chart
templates changed.

## Step 2 — Finalize the CHANGELOG

Confirm the `[Unreleased]` items moved under the new `## [X.Y.Z] - <date>` heading, edit the
date if needed, and update the footer compare/release link definitions at the bottom of the
file to reference the new tag. Commit:

```bash
git commit -am "chore(release): vX.Y.Z"
```

## Step 3 — Tag and push (this triggers the publish workflows)

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Pushing the `v*` tag fires both:

- **`docker-publish.yml`** → multi-arch (amd64 + arm64) image to
  `ghcr.io/carlxsmg/mcpbridge`, with an SBOM + build-provenance attestation, a keyless cosign
  signature, and a Trivy scan surfaced in the Security tab.
- **`release-binaries.yml`** → standalone compiled binaries. Note the binary is the
  **backend only** — the admin UI ships as a separate artifact (`admin-ui-dist.tar.gz`). If you
  advertise a binary download anywhere, say so next to it, or `/admin` will 404 for anyone who
  grabs just the binary.

## Step 4 — Create the GitHub Release

Publish a Release for the `vX.Y.Z` tag with the CHANGELOG section as the body (or let the
release workflow attach the binaries and edit in the notes). This is what makes the
`CHANGELOG.md` `releases/tag/vX.Y.Z` footer link resolve.

## Step 5 — Verify

```bash
# Image exists and is signed (keyless — verify against the workflow identity).
# Note the casing: the GHCR path is lowercase, the cosign identity is the canonical slug.
docker pull ghcr.io/carlxsmg/mcpbridge:X.Y.Z
cosign verify ghcr.io/carlxsmg/mcpbridge:X.Y.Z \
  --certificate-identity-regexp "https://github.com/CarlxsMG/mcpbridge/.github/workflows/.+" \
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
