# Contributing to filuflow

Thank you for your interest in filuflow.

## Pull requests are not accepted yet

filuflow is maintained by a small team (GitHub: [mebytede](https://github.com/mebytede)) and is still changing quickly.
For now we do **not accept external pull requests**; they will be closed without review. This keeps the licensing of the
code base simple while the project settles (no contributor agreement is needed as long as all code comes from the
maintainers) and keeps the review effort manageable. This may change later; this file will say so.

What helps a lot instead:
- **Bug reports** and **feature requests** as [issues](https://github.com/mebytede/filuflow/issues/new/choose)
- reports about **n8n workflows that behave differently** in filuflow (see below)
- **security reports**, privately, as described in [SECURITY.md](SECURITY.md)

You are of course free to fork filuflow under the terms of its license ([AGPL-3.0-or-later](LICENSE)).

## Reporting bugs

Please search the existing issues first. A good report contains:
- filuflow version (release, image tag or commit) and how it runs (Docker, systemd, CLI; single server, master, worker)
- Node.js version and operating system when not using the Docker image
- what you did, what you expected, what happened instead
- a minimal workflow (JSON) that shows the problem, and input data if needed
- for differences from n8n: the n8n version you compared with and the output n8n produces
- relevant log lines (`FILUFLOW_LOG_LEVEL=debug` gives more detail)

Remove credentials, tokens, personal data and internal URLs from workflows and logs before posting them. For anything
security related, do not open an issue; use private vulnerability reporting ([SECURITY.md](SECURITY.md)).

## Building and testing locally

Requirements: Node.js 22 and npm. Chromium is optional (browser tests are skipped without it).

```bash
git clone https://github.com/mebytede/filuflow.git
cd filuflow
npm ci
npm run lint         # eslint and TypeScript
npm test             # unit tests, comparison tables, browser tests (Chromium)
npm run test:compat  # golden tests against recorded n8n results in fixtures/
npm run build        # CLI, server and interface to dist/
npx filuflow serve --dir ./workflows --port 5678
```

Install Chromium for the browser tests with `node node_modules/playwright-core/cli.js install chromium`. The Docker image
is built with `docker build -t filuflow .`. Installation options are described in [docs/INSTALL.md](docs/INSTALL.md).

## Coding rules

The rules for the code base are in [CLAUDE.md](CLAUDE.md) (language, stack, conventions, security model) and in the
documents under [docs/](docs/): [SPEC.md](docs/SPEC.md) (specification and milestones), [STATUS.md](docs/STATUS.md)
(state per milestone), [DECISIONS.md](docs/DECISIONS.md) (decisions and dependencies) and
[SECURITY.md](docs/SECURITY.md) (security model). In short: TypeScript strict with ESM, English code and docs, n8n
behavior is rebuilt from the n8n source as a reference without copying code, unknown node types or versions are always
reported, and every change comes with tests.

## License headers

filuflow is licensed under the GNU Affero General Public License v3.0 or later; the [LICENSE](LICENSE) file applies to
the whole repository, so source files do not need a header. Where a header is useful (for example in a file that is
copied elsewhere), use the SPDX form:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright the filuflow authors
```

Third-party material keeps its own license and is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Code of Conduct

Everyone taking part in the project's issues and discussions is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
