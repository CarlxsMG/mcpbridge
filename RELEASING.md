# Releasing

The maintainer runbook for cutting a published, tagged release. Everything here is a
one-time / per-release checklist — the codebase is fully built and CI-green, but it has
**never been published under a real identity**, and this document is the exact path to fix
that.

## Current status (read first)

- **No git tags exist.** `docker-publish.yml` and `release-binaries.yml` both trigger
  **only on `v*` tags**, so the GHCR image and the standalone binaries the README,
  `docker-compose.yml`, and the docs advertise **have never been built**.
- `docker-compose.yml` now builds from local source (`build: .`) because no image is
  published; its `image:` tag `ghcr.io/aico-dot-team-code/mcpbridge:1.0.0` won't resolve until
  you publish (at which point comment `build:` back out so it pulls the signed image).
- `CHANGELOG.md` marks `## [1.0.0] - 2026-07-03` as released and its footer links point at
  `.../compare/v1.0.0...HEAD` and `.../releases/tag/v1.0.0` — both **404** until a real slug
  and a real `v1.0.0` tag/release exist.
- The repo slug `aico-dot-team-code/mcpbridge` is a **placeholder** — ~34 tracked files carry
  the token, across both the `<org>/<repo>` slug and the `<owner>.github.io/<repo>` Pages form
  (the top of `README.md` says so). Publishing is gated on picking the real handle; see
  [Step 1](#step-1--set-the-real-repository-slug-one-sweep) for the complete sweep.

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

The placeholder `aico-dot-team-code/mcpbridge` (owner `aico-dot-team-code`, repo `mcpbridge`)
appears in **two distinct URL shapes plus a pair of derived constants**, so a single
find-and-replace on the `<org>/<repo>` form alone is **not** enough — it silently misses the
GitHub Pages host `<owner>.github.io/<repo>` that the README badges, the "Live demo"/"Docs"
links, `.env.example`, and `docs/.vitepress/config.mts` are built from. Replace all of them,
from a clean tree, after everything you want in the release is committed (git grep only matches
tracked files):

```bash
# 1. The Pages host + base path (do this FIRST — it's the more specific pattern):
#    README/docs "Live demo" & "Docs" links, .env.example, DemoReel.vue.
git grep -l 'aico-dot-team-code.github.io/mcpbridge' \
  | xargs sed -i 's#aico-dot-team-code\.github\.io/mcpbridge#<ORG>.github.io/<REPO>#g'

# 2. The repository slug: github.com/<org>/<repo>, ghcr.io/<org>/<repo>, package.json, etc.
git grep -l 'aico-dot-team-code/mcpbridge' \
  | xargs sed -i 's#aico-dot-team-code/mcpbridge#<ORG>/<REPO>#g'

# 3. The two derived constants in the docs config — the seds above don't touch them,
#    because they hold owner and repo SEPARATELY, not the joined slug:
#    docs/.vitepress/config.mts →  GH_USER = "<ORG>";  GH_REPO = "<REPO>";
sed -i 's#"aico-dot-team-code"#"<ORG>"#; s#"mcpbridge"#"<REPO>"#' docs/.vitepress/config.mts

# 4. Verify NOTHING remains — this must print nothing:
git grep -n 'aico-dot-team-code'
```

Then delete the now-obsolete find-and-replace comment at the top of `README.md` and
`README.es.md`. This whole sweep touches ~34 files across `README*.md`, `package.json`,
`docker-compose.yml`, `helm/`, `SECURITY.md`, `CHANGELOG.md`, `.env.example`, `.github/`,
`docs/` (incl. `.vitepress/config.mts` and `DemoReel.vue`), and the `monitoring/` runbook
URLs. Review the diff, then commit:

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
