# Releasing

filuflow uses [Semantic Versioning](https://semver.org/) (0.x while the project is young: minor versions may break
things, the changelog says so) and keeps its changes in [CHANGELOG.md](../CHANGELOG.md) in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. A release consists of:

- the git tag `vX.Y.Z` on a commit of `main`
- the Docker images `ghcr.io/mebytede/filuflow:X.Y.Z`, `:X.Y` and `:latest` for linux/amd64 and linux/arm64
  (pre-releases such as `X.Y.Z-rc.1` only get their own tag, never `:X.Y` or `:latest`)
- a GitHub release with the notes from the matching CHANGELOG section

Everything after the version bump is done by `.github/workflows/release.yml`.

## Release procedure

1. **Prepare the release in a pull request** against `main`:
   - set the version in `package.json` and the root entry of `package-lock.json`:
     `npm version X.Y.Z --no-git-tag-version` (changes both files, creates no tag)
   - in `CHANGELOG.md`, rename the section `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (release date), add a new
     empty `## [Unreleased]` above it and update the link references at the end of the file:
     `[Unreleased]: https://github.com/mebytede/filuflow/compare/vX.Y.Z...HEAD` and
     `[X.Y.Z]: https://github.com/mebytede/filuflow/compare/vPREVIOUS...vX.Y.Z` (for the first release:
     `.../releases/tag/v0.1.0`)
   - check the notes locally: `node scripts/changelog-section.mjs X.Y.Z --require-date`
   - if dependencies changed: `node scripts/third-party-licenses.mjs --write`
   - `npm run lint`, `npm test`, `npm run test:compat`
   - merge the pull request once CI is green.
2. **Start the release workflow**: GitHub, tab "Actions", workflow "Release", "Run workflow", branch `main`,
   version `X.Y.Z` (without "v"). The workflow
   1. checks that the version has the form `X.Y.Z`, matches `package.json`, has a dated CHANGELOG section and that the
      tag does not exist yet,
   2. runs lint, unit, browser and golden tests and the build,
   3. creates the annotated tag `vX.Y.Z` on the commit and pushes it (with `GITHUB_TOKEN`; this does not start a second
      run),
   4. builds the image for amd64, starts it and checks `/healthz`, then builds and pushes amd64 and arm64 with OCI
      labels,
   5. creates the GitHub release `filuflow X.Y.Z` with the CHANGELOG section as notes.

   Alternative for people with tag push rights: `git tag -a vX.Y.Z -m "filuflow X.Y.Z" && git push origin vX.Y.Z`
   starts the same workflow without the tag step.
3. **Verify**:
   - the run is green in all jobs ("Check version", "Lint and tests", "Create tag", "Docker image", "GitHub release")
   - the release page shows the notes and is marked "Latest" (pre-releases: "Pre-release")
   - `docker pull ghcr.io/mebytede/filuflow:X.Y.Z` works without login (once the package is public) and
     `docker buildx imagetools inspect ghcr.io/mebytede/filuflow:X.Y.Z` lists `linux/amd64` and `linux/arm64`; `:X.Y`
     and `:latest` point to the same digest
   - `docker run --rm -p 5678:5678 -e FILUFLOW_API_KEY=test ghcr.io/mebytede/filuflow:X.Y.Z` and
     `curl http://127.0.0.1:5678/healthz` answer `{"status":"ok"}`
   - `docker inspect` shows the labels `org.opencontainers.image.version=X.Y.Z`,
     `org.opencontainers.image.licenses=AGPL-3.0-or-later` and `org.opencontainers.image.source`

**If the workflow fails** before "Create tag": fix the problem in a pull request and start it again. If it fails after
the tag exists (image or release job): re-run the failed jobs from the run page ("Re-run failed jobs"); a new run with
the same version is refused because the tag exists. To start over completely, delete the tag
(`git push origin :refs/tags/vX.Y.Z` or on the GitHub tags page) and a partially created release first.

## One-time GitHub settings before going public

Go through these in order. Paths refer to the repository page on github.com unless stated otherwise.

1. **About text and topics** (repository main page, gear icon next to "About"):
   - Description:
     > Self-hosted workflow engine with a browser editor: webhooks, schedules, forms, chat, AI agents and RAG,
     > traceable runs, master and workers for many tenants. Runs workflows in the n8n format without changes.
     > Independent project, not affiliated with n8n GmbH.

     (257 characters)
   - Website: leave empty or `https://github.com/mebytede/filuflow#readme`
   - Topics: `workflow-engine`, `workflow-automation`, `automation`, `low-code`, `self-hosted`, `n8n`, `webhooks`,
     `ai-agents`, `multi-tenant`, `typescript`, `nodejs`
   - Tick "Releases" and "Packages" under "Include in the home page"; untick "Deployments" if unused.
2. **Branch ruleset for `main`** (Settings, Rules, Rulesets, "New ruleset", "New branch ruleset"):
   - Name `main`, enforcement status "Active", target branches "Include default branch"
   - Bypass list: empty (or "Repository admin" for emergencies only; it lets admins merge without checks)
   - Enable "Restrict deletions"
   - Enable "Require a pull request before merging" (required approvals: 0 while there is a single maintainer; allowed
     merge methods: Merge and Squash as you use them)
   - Enable "Require status checks to pass", add the checks `Lint and tests` and `Docker image` (source "GitHub
     Actions"; they appear in the list after the CI has run once on a pull request); optionally "Require branches to be
     up to date before merging"
   - Enable "Block force pushes"
   - Leave "Require linear history" off (merge commits are used)
   - Tags: the release workflow creates `vX.Y.Z` with `GITHUB_TOKEN`. If you later add a tag ruleset that restricts
     creating `v*` tags, the tag step fails unless the ruleset lets GitHub Actions through; without such a ruleset
     nothing needs to be done.
3. **Private vulnerability reporting** (Settings, Advanced Security (or "Code security"), "Private vulnerability
   reporting": Enable). SECURITY.md, CODE_OF_CONDUCT.md and the issue template link to it.
4. **Secret scanning with push protection** (same page: "Secret Protection" or "Secret scanning": Enable, then "Push
   protection": Enable). Free for public repositories. Check the "Secret scanning" alerts under Security once after
   enabling, because the existing history is scanned as well.
5. **Dependabot** (same page): enable "Dependency graph", "Dependabot alerts" and "Dependabot security updates".
   Version updates come from `.github/dependabot.yml` (weekly, minor and patch grouped; the libraries pinned to the n8n
   reference versions are ignored on purpose).
6. **CodeQL default setup** (same page, "Code scanning", "CodeQL analysis", "Set up", "Default"): languages
   JavaScript/TypeScript and GitHub Actions, query suite "Default", then "Enable CodeQL".
7. **Discussions (optional)** (Settings, General, Features, "Discussions"). Without it, questions go to issues. If you
   enable it, add a "Questions" link to `.github/ISSUE_TEMPLATE/config.yml`.
8. **Actions permissions** (Settings, Actions, General):
   - "Actions permissions": "Allow all actions and reusable workflows", or stricter "Allow mebytede, and select
     non-mebytede, actions" with "Allow actions created by GitHub" and the pattern `docker/*`
   - "Approval for running fork pull request workflows from contributors": "Require approval for all external
     contributors"
   - "Workflow permissions": "Read repository contents and packages permissions" (read by default). The workflows
     request more only where needed via their `permissions` block (`packages: write` for the image jobs,
     `contents: write` for creating the tag and the release in `release.yml`).
   - "Allow GitHub Actions to create and approve pull requests": off
9. **GHCR package public and linked** (profile or organization page, tab "Packages", `filuflow`, "Package settings"):
   - "Danger Zone", "Change visibility", "Public". Note: a public package cannot be made private again, and the image
     contains the built application, so do this right before the last step.
   - "Manage Actions access": the repository `mebytede/filuflow` with role "Write" (already the case when the package was
     first pushed by the workflow)
   - The package is linked to the repository through the label `org.opencontainers.image.source` in the Dockerfile and
     the release workflow; if the package page does not show the repository, use "Connect repository".
10. **Social preview** (Settings, General, "Social preview", "Edit", "Upload an image"): upload
    `docs/assets/social-preview.png` (1280 x 640 px, the editor screenshot).
11. **Change the visibility to public** (Settings, General, "Danger Zone", "Change repository visibility", "Change to
    public"). Before that, check once more: no secrets in the history (secret scanning alerts empty), LICENSE and
    THIRD_PARTY_NOTICES.md present, README links work. Afterwards check that the CI badge renders, that
    `docker pull ghcr.io/mebytede/filuflow:main` works without login and that "Report a vulnerability" appears under
    Security.
