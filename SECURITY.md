# Security policy

## Supported versions

filuflow is in early development (0.x). Security fixes are made on `main` and shipped in the next release.

| Version | Supported |
|---|---|
| Latest release (`ghcr.io/mebytede/filuflow:latest`) | yes |
| `main` (`ghcr.io/mebytede/filuflow:main`) | yes |
| Older releases | no, please update |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub's private vulnerability reporting:
<https://github.com/mebytede/filuflow/security/advisories/new> (repository tab "Security", button "Report a
vulnerability"). Only the maintainers can see the report.

Helpful information:
- affected version (release, image tag or digest, or commit)
- mode (single server, master, worker), installation method (Docker, systemd, CLI)
- a description of the problem and its impact, steps or a minimal workflow to reproduce it
- whether the problem is already public or known to others

Please leave secrets, credentials and personal data out of the report.

What to expect: an acknowledgement as soon as possible, usually within a week, an assessment, and a fix with a GitHub
security advisory for confirmed vulnerabilities. We will credit you in the advisory unless you prefer otherwise. This is
a volunteer project without a bug bounty.

## Security model

filuflow treats workflows, expressions and code nodes as **trusted**: they must come from authors you trust.
`node:vm` and the Python sandbox are a convenience, not a security boundary. A workflow author who can run code can
reach the server process. Reports that only show that trusted workflow code can escape the sandbox are therefore
expected behavior, not vulnerabilities, unless they cross a boundary that filuflow does claim (for example, login,
permissions between users and projects, tenant separation between master and workers, credential encryption, webhook
authentication).

The full model, including login, credentials, master and worker, plugins and the Supervisor, is described in
[docs/SECURITY.md](docs/SECURITY.md).
