# Installing filuflow

This guide covers installing filuflow on a Linux server, either with the installer script or by hand, in each of the
three operating modes:

| Mode | Command | Use it for | Default port |
|---|---|---|---|
| **Single server** | `filuflow serve` | one team, one server: editor, webhooks, schedules, execution log | 5678 |
| **Master** | `filuflow master` | users, permissions, projects and tenants; executes nothing itself | 5679 |
| **Worker** | `filuflow worker` | runs the workflows of a master in a tenant's environment | 5678 |

Two installation methods are supported:

- **Docker** (default): Docker Engine with the compose plugin; runs the published release image
  `ghcr.io/mebytede/filuflow:<version>` (amd64 and arm64), or with `--build` an image built from source on the server.
- **Native**: Node.js 22 with a systemd service and a dedicated system user; builds the release from its git tag.

Both methods install released versions by default (the latest release, or the one given with `--version`).

Contents: [Requirements](#requirements) · [Quick install](#quick-install-with-the-script) ·
[Manual Docker install](#manual-installation-with-docker) · [Manual native install](#manual-native-installation-with-systemd) ·
[HTTPS](#https-and-reverse-proxy) · [First steps](#first-steps-after-the-installation) ·
[Configuration](#configuration) · [Updating](#updating) · [Backup and restore](#backup-and-restore) ·
[Uninstalling](#uninstalling) · [Troubleshooting](#troubleshooting)

## Requirements

- Linux on x86_64 or arm64. The installer supports Debian and Ubuntu (apt) fully, Fedora, RHEL, Rocky and AlmaLinux (dnf)
  for the prerequisites where this is simple. Other distributions work with a manual installation.
- Root access (or sudo).
- Outgoing HTTPS during installation (GitHub and the GitHub Container Registry, for native installs and `--build` the
  npm registry and Docker Hub or NodeSource, with `--domain` the Caddy repository).
- For HTTPS with Let's Encrypt: a DNS name pointing to the server, ports 80 and 443 reachable from the internet.

Sizing (rough guide values; AI nodes, large payloads and many parallel executions need more):

| | CPU | RAM | Disk |
|---|---|---|---|
| Single server or worker, small team | 1 vCPU | 1 GB | 5 GB |
| Single server or worker, busy | 2 to 4 vCPU | 2 to 4 GB | 20 GB+ (execution log, binary data) |
| Master | 1 vCPU | 512 MB to 1 GB | 2 GB |

Building the Docker image (only with `--build`, `--ref` or `--source`) needs about 2 GB of RAM and 3 GB of disk
temporarily. Executions are kept for 14 days by default
(`FILUFLOW_PRUNE_DAYS`); the database grows with the number and size of executions.

## Quick install with the script

`scripts/install.sh` installs the prerequisites, looks up the latest release, pulls its image (Docker) or builds it from
its git tag (native), writes the configuration with fresh secrets, starts filuflow, waits for `/healthz` and prints a
summary with the installed version.

```bash
curl -fsSL https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh | sudo bash -s -- --mode serve

# or from a checkout
sudo bash scripts/install.sh
```

In a terminal the script asks for the mode, method, port, domain and (master) first admin. Without a terminal, or with
`--yes`, it uses the flags and defaults and asks nothing. It always shows what it will install and change before doing
it.

Examples:

```bash
# single server with HTTPS
sudo bash scripts/install.sh --mode serve --domain flows.example.com --email admin@example.com --yes

# worker, native with systemd, plain HTTP on port 5678 (for a VPN or an internal network)
sudo bash scripts/install.sh --mode worker --method native

# master with HTTPS and the first admin (password generated and shown once)
sudo bash scripts/install.sh --mode master --domain filuflow.example.com --admin-email ada@example.com

# a specific release, and building the image from its source instead of pulling it
sudo bash scripts/install.sh --version 0.1.0 --build

# the development state (branch main), built from source
sudo bash scripts/install.sh --ref main

# see what would happen, without installing anything (writes the generated files to ./preview)
bash scripts/install.sh --dry-run --yes --mode master --dir "$PWD/preview"
```

### Versions

| What is installed | Flags | Docker | Native |
|---|---|---|---|
| latest release | (default) | pulls `ghcr.io/mebytede/filuflow:<version>` | builds the git tag `v<version>` |
| a specific release | `--version 0.1.0` (or `v0.1.0`) | pulls that image tag | builds that tag |
| a release, built on the server | `--build` (with or without `--version`) | builds the git tag `v<version>` | (always) |
| a branch, tag or commit | `--ref main` | builds it from source | builds it |
| a local checkout | `--source <path>` | builds it | builds it |
| an own image | `--image <image>` | pulls it | |

The latest release is the highest version tag `vX.Y.Z` of the repository (pre-releases such as `1.2.0-rc.1` are only
installed when given with `--version`). If it cannot be determined (no git, no access to GitHub), Docker falls back to
the image tag `latest` with a note; building then needs `--version` or `--ref`. Before changing anything the script
checks that the image tag or the git tag exists and stops with a clear error otherwise.

With Docker the chosen image is recorded as `FILUFLOW_IMAGE` in `/opt/filuflow/.env` and the compose file uses it, so
`cd /opt/filuflow && sudo docker compose pull && sudo docker compose up -d` refreshes the installed version by hand, and
editing `FILUFLOW_IMAGE` pins another one. The way of installing (release image, `--build`, `--ref`, `--source` or
`--image`) is stored in `.install.conf` and kept by updates.

### Flags

| Flag | Meaning | Default |
|---|---|---|
| `--mode serve\|master\|worker` | operating mode | `serve` |
| `--method docker\|native` | Docker Compose, or Node.js 22 with systemd | `docker` |
| `--dir <path>` | install directory | `/opt/filuflow` |
| `--data-dir <path>` | native only: data directory | `/var/lib/filuflow` |
| `--port <number>` | local port | `5678`, master `5679` |
| `--domain <name>` | Caddy in front with HTTPS (Let's Encrypt); filuflow listens on 127.0.0.1 only | none |
| `--no-domain` | on update: remove the domain and the Caddy site again | |
| `--email <address>` | contact address for Let's Encrypt (expiry notices) | none |
| `--public-url <url>` | public base URL when you run your own reverse proxy | `http://<server IP>:<port>` |
| `--timezone <zone>` | time zone for schedules and date values | the server's, else `Europe/Berlin` |
| `--version <X.Y.Z\|latest>` | release to install or update to; a leading `v` is optional | latest release |
| `--build` | Docker only: build the image from the release's git tag instead of pulling it | off |
| `--no-build` | Docker only: go back from `--build` to the published image | |
| `--ref <ref>` | build a git branch, tag or commit instead of a release | |
| `--repo <url>` | git repository (for building and for looking up releases) | `https://github.com/mebytede/filuflow.git` |
| `--source <path>` | build from a local checkout instead of cloning | |
| `--image <image>` | Docker only: use this image instead of the release image | |
| `--with-python` | Python 3 for "Python (Native)" in the Code node (Pyodide works without) | off |
| `--api-key <value>` | `FILUFLOW_API_KEY` (serve, worker; at least 16 characters) | generated |
| `--encryption-key <value>` | `FILUFLOW_ENCRYPTION_KEY` (at least 16 characters) | generated |
| `--admin-email <address>` | master: first admin instead of the setup token | |
| `--admin-password <value>` | master: password of the first admin (at least 12 characters) | generated |
| `--update` | update an existing installation to the latest release (or `--version`) | |
| `--uninstall` | stop and remove the service, keep data and settings | |
| `--purge` | with `--uninstall`: delete data, settings and the install directory | |
| `-y`, `--yes` | do not ask | |
| `--dry-run` | show the steps, write the generated files into `--dir`, install and start nothing (no root needed) | |
| `-h`, `--help` | help | |

Secrets can also be passed as environment variables with the same names (`FILUFLOW_API_KEY=... sudo -E bash ...`),
which keeps them out of the process list. Generated secrets are written only to the env file (mode 600) and printed once
at the end. **Store the encryption key in a safe place**: without it, encrypted credentials (and in the master: worker
tokens and TOTP secrets) cannot be decrypted after a restore.

### What the script creates

Docker (`--method docker`):

| Path | Content |
|---|---|
| `/opt/filuflow/app/` | source code (git checkout, or the copy of `--source`); only when building (`--build`, `--ref`, `--source`) |
| `/opt/filuflow/docker-compose.yml` | generated per mode; rewritten on every run |
| `/opt/filuflow/docker-compose.override.yml` | optional, yours: own changes (docker compose reads it automatically) |
| `/opt/filuflow/.env` | settings and secrets (mode 600), passed to the container; `FILUFLOW_IMAGE` names the image |
| `/opt/filuflow/data/` | everything the container writes: workflows, database, credentials, binary data, packages |
| `/opt/filuflow/.install.conf` | the installer's choices and the installed version (no secrets), used for updates |

Native (`--method native`):

| Path | Content |
|---|---|
| `/opt/filuflow/app/` | source code, built (`npm ci`, `npm run build`, dev dependencies removed), owned by root |
| `/etc/filuflow/filuflow.env` | settings and secrets (mode 600) |
| `/etc/filuflow/install.conf` | the installer's choices and the installed version (no secrets) |
| `/etc/systemd/system/filuflow.service` | systemd unit with hardening; own changes via `systemctl edit filuflow` |
| `/var/lib/filuflow/` | data, home and working directory of the system user `filuflow` |

With `--domain`: `/etc/caddy/filuflow.caddy` (the site) and an `import` line in `/etc/caddy/Caddyfile`. The packaged
default Caddyfile (static page on port 80) is replaced after a backup; any other existing Caddyfile is kept and only gets
the import line.

### Re-running the script

Running the script again on a server where filuflow is installed (same `--dir`) applies changed flags (domain, port,
...) and restarts, but keeps the installed version unless `--version` is given. `--update` also moves to the latest
release (or to `--version`) and fails if nothing is installed; see [Updating](#updating). The env file keeps its secrets
and your own additions; only the address settings (`FILUFLOW_WEBHOOK_URL`, `FILUFLOW_PUBLIC_URL`,
`FILUFLOW_TRUST_PROXY`, host and port) and `FILUFLOW_IMAGE` are updated. Mode and method cannot change; uninstall first
for that.

## Manual installation with Docker

Install Docker Engine with the compose plugin ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)),
then:

```bash
sudo mkdir -p /opt/filuflow && cd /opt/filuflow
sudo git clone https://github.com/mebytede/filuflow.git app
sudo mkdir -p data/workflows && sudo chown -R 1000:1000 data   # the container runs as "node" (uid 1000)
```

The repository contains example compose files (`docker-compose.yml`, `docker-compose.master.yml`,
`docker-compose.worker.yml`) that read the settings from environment variables. For a server, a compose file next to an
env file is easier to maintain. Create `/opt/filuflow/.env` with `sudo install -m 600 /dev/null .env` and fill it in per
mode (generate secrets with `openssl rand -hex 32`):

**Single server**

```bash
FILUFLOW_API_KEY=<random, at least 16 characters>
FILUFLOW_ENCRYPTION_KEY=<random, at least 16 characters>
FILUFLOW_WEBHOOK_URL=https://flows.example.com/
FILUFLOW_TIMEZONE=Europe/Berlin
```

**Worker**: the same keys. `FILUFLOW_API_KEY` is the token you enter for this worker in the master (at least 16
characters, required). `FILUFLOW_ENCRYPTION_KEY` encrypts the credentials the master sets on the worker.

**Master**

```bash
FILUFLOW_ENCRYPTION_KEY=<random, at least 16 characters, required>
FILUFLOW_PUBLIC_URL=https://filuflow.example.com
FILUFLOW_TRUST_PROXY=true            # only behind a reverse proxy
# optional instead of the setup token:
# FILUFLOW_ADMIN_EMAIL=ada@example.com
# FILUFLOW_ADMIN_PASSWORD=<at least 12 characters>
```

`/opt/filuflow/docker-compose.yml`:

```yaml
name: filuflow
services:
  filuflow:
    build: ./app                 # or: image: <your registry>/filuflow:<tag>
    image: filuflow:local
    restart: unless-stopped
    env_file: .env
    environment:
      FILUFLOW_PORT: "5678"      # master: "5679"
      FILUFLOW_NODES_DIR: /data/nodes
    ports:
      - "127.0.0.1:5678:5678"    # behind a reverse proxy on the same host; without one: "5678:5678"
    volumes:
      - ./data:/data
    command: ["node", "/app/bin/filuflow.js", "serve"]
    # worker: ["node", "/app/bin/filuflow.js", "worker"]
    # master: ["node", "/app/bin/filuflow.js", "master", "--db", "/data/master.db"]
```

```bash
sudo docker compose up -d --build
curl -fsS http://127.0.0.1:5678/healthz
```

The image keeps workflows in `/data/workflows`, the execution database in `/data/filuflow.db`, credentials from the
interface or the master in `/data/credentials.managed.json`, binary data in `/data/binary` and Pyodide packages in
`/data/pyodide`. A hand-maintained `credentials.json` or `vars.json` goes into `/data` as well. For "Python (Native)" in
the Code node build with `--build-arg WITH_PYTHON=true` (in compose: `build: { context: ./app, args: { WITH_PYTHON: "true" } }`).

Instead of building, use the published image: `image: ghcr.io/mebytede/filuflow:0.1.0` (without `build:`; tags
`X.Y.Z`, `X.Y` and `latest` for releases, `main` for the development state, amd64 and arm64, pulled without login).
Then `sudo docker compose pull && sudo docker compose up -d` instead of `--build`.

## Manual native installation with systemd

1. Node.js 22 (for example from [NodeSource](https://github.com/nodesource/distributions)), git, and for the rare case
   that `better-sqlite3` has no prebuilt binary for your platform: `build-essential` and `python3`.

2. User, code and build:

   ```bash
   sudo useradd --system --user-group --home-dir /var/lib/filuflow --shell /usr/sbin/nologin filuflow
   sudo install -d -m 750 -o filuflow -g filuflow /var/lib/filuflow /var/lib/filuflow/workflows
   sudo git clone https://github.com/mebytede/filuflow.git /opt/filuflow/app
   cd /opt/filuflow/app
   sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
   ```

3. `/etc/filuflow/filuflow.env` (`sudo install -d /etc/filuflow && sudo install -m 600 /dev/null /etc/filuflow/filuflow.env`):

   ```bash
   NODE_ENV=production
   FILUFLOW_API_KEY=<random>                 # serve and worker
   FILUFLOW_ENCRYPTION_KEY=<random>
   FILUFLOW_WEBHOOK_URL=https://flows.example.com/
   FILUFLOW_HOST=127.0.0.1                   # 0.0.0.0 without a reverse proxy
   FILUFLOW_PORT=5678
   FILUFLOW_DIR=/var/lib/filuflow/workflows
   FILUFLOW_DB=/var/lib/filuflow/filuflow.db
   FILUFLOW_MANAGED_CREDENTIALS=/var/lib/filuflow/credentials.managed.json
   FILUFLOW_BINARY_DIR=/var/lib/filuflow/binary
   FILUFLOW_PYTHON_PACKAGES_DIR=/var/lib/filuflow/pyodide
   FILUFLOW_NODES_DIR=/var/lib/filuflow/nodes
   ```

   For the master use `FILUFLOW_ENCRYPTION_KEY`, `FILUFLOW_PUBLIC_URL`, `FILUFLOW_TRUST_PROXY`, `FILUFLOW_HOST`,
   `FILUFLOW_PORT=5679` and `FILUFLOW_MASTER_DB=/var/lib/filuflow/master.db`.

4. `/etc/systemd/system/filuflow.service`:

   ```ini
   [Unit]
   Description=filuflow
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=filuflow
   Group=filuflow
   WorkingDirectory=/var/lib/filuflow
   Environment=HOME=/var/lib/filuflow
   EnvironmentFile=/etc/filuflow/filuflow.env
   ExecStart=/usr/bin/node /opt/filuflow/app/bin/filuflow.js serve
   Restart=on-failure
   RestartSec=5
   UMask=0077
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   ReadWritePaths=/var/lib/filuflow
   PrivateTmp=true
   PrivateDevices=true
   ProtectKernelTunables=true
   ProtectKernelModules=true
   ProtectControlGroups=true
   RestrictSUIDSGID=true
   RestrictNamespaces=true
   LockPersonality=true
   CapabilityBoundingSet=

   [Install]
   WantedBy=multi-user.target
   ```

   Replace `serve` with `worker` or `master`. Do not add `MemoryDenyWriteExecute=true`: the JavaScript JIT needs
   writable and executable memory.

5. `sudo systemctl daemon-reload && sudo systemctl enable --now filuflow`, then `curl -fsS http://127.0.0.1:5678/healthz`.

The installer writes the same unit with a few more hardening options (see `scripts/install.sh`).

## HTTPS and reverse proxy

Run filuflow behind a reverse proxy with HTTPS whenever it is reachable over a network: the API key, passwords and
session cookies travel in every request. Bind filuflow to `127.0.0.1` (Docker: `"127.0.0.1:5678:5678"`, native:
`FILUFLOW_HOST=127.0.0.1`) so it is only reachable through the proxy.

Set the public address so links and webhook URLs are right:

| Mode | Variable | Example |
|---|---|---|
| serve, worker | `FILUFLOW_WEBHOOK_URL` | `https://flows.example.com/` (with a trailing slash) |
| master | `FILUFLOW_PUBLIC_URL` | `https://filuflow.example.com` (cookies get `Secure`, SSO redirect target) |
| master | `FILUFLOW_TRUST_PROXY=true` | the client IP from `X-Forwarded-For` counts for the login limits |

Set `FILUFLOW_TRUST_PROXY` only behind a proxy: without one, anyone could claim any IP address.

### Caddy

Caddy gets and renews a Let's Encrypt certificate on its own. `/etc/caddy/Caddyfile`:

```caddyfile
flows.example.com {
	tls admin@example.com
	reverse_proxy 127.0.0.1:5678 {
		flush_interval -1
	}
}
```

`flush_interval -1` passes streamed responses (webhooks with response mode "streaming", the chat) through immediately.
Reload with `sudo systemctl reload caddy`. The installer does exactly this with `--domain` and `--email`.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name flows.example.com;
    ssl_certificate     /etc/letsencrypt/live/flows.example.com/fullchain.pem;   # e.g. from certbot
    ssl_certificate_key /etc/letsencrypt/live/flows.example.com/privkey.pem;

    client_max_body_size 16m;          # FILUFLOW_PAYLOAD_SIZE_MAX (MB)

    location / {
        proxy_pass http://127.0.0.1:5678;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;           # streamed responses and chat
        proxy_read_timeout 300s;       # long webhook executions
    }
}
server {
    listen 80;
    server_name flows.example.com;
    return 301 https://$host$request_uri;
}
```

Then set the variables above in the env file and restart filuflow. To use your own proxy with the installer, pass
`--public-url https://flows.example.com` instead of `--domain`.

### Workers

The master connects to the workers, never the other way round. Make each worker reachable for the master via HTTPS (Caddy
on the worker with `--domain`) or a VPN. The master verifies the TLS certificate of the worker; a custom CA certificate
can be set per worker in the master.

## First steps after the installation

**Single server.** Open the address and sign in with the API key (`FILUFLOW_API_KEY` in the env file). Create workflows
in the editor, or copy exported workflow files into the workflow directory (`data/workflows` or
`/var/lib/filuflow/workflows`); the server picks up changes automatically. Switch a workflow to **Active** to register
its webhooks and schedules.

**Master.**

1. Create the first admin: with `--admin-email` sign in with that address and password. Otherwise open
   `<address>/#/setup` and enter the setup token from the log (the installer prints it):

   ```bash
   cd /opt/filuflow && sudo docker compose logs | grep setupToken      # Docker
   sudo journalctl -u filuflow | grep setupToken                       # native
   ```

   The token only exists as long as there is no user. Emergency access on the command line:
   `filuflow master user add --email ... --admin --db <master.db>` (Docker: `sudo docker compose exec filuflow node
   /app/bin/filuflow.js master user add --email ada@example.org --name Ada --admin --db /data/master.db`).
2. Set up two-factor login in the profile.
3. Under **Administration**: create a tenant, add a worker with its address (for example
   `https://flows.customer.example`) and its `FILUFLOW_API_KEY` as token, create a project, assign it to the worker and
   add members.

**Worker.** There is nothing to do on the worker itself (its own interface is off; `FILUFLOW_UI=true` turns it on).
Note its address and `FILUFLOW_API_KEY`, and add it in the master as described above. The master distributes workflows
on save.

## Configuration

All settings are environment variables in the env file (`/opt/filuflow/.env` or `/etc/filuflow/filuflow.env`). After a
change restart filuflow: `cd /opt/filuflow && sudo docker compose up -d` (Docker) or `sudo systemctl restart filuflow`
(native). The full list is in the README:

- [Configuration](../README.md#configuration): workflow directory, database, webhooks, concurrency, retention, time zone,
  Code node limits, Python, community packages, Supervisor
- [Master environment variables](../README.md#starting-the-master) and [SSO (OIDC)](../README.md#multiple-users-and-tenants)
- [docs/SECURITY.md](SECURITY.md): security model, login, credentials

Credentials can be created in the interface (stored in `credentials.managed.json`, encrypted with
`FILUFLOW_ENCRYPTION_KEY`) or maintained by hand in `credentials.json` in the data directory.

## Updating

With the installer (keeps settings, secrets and data; the summary at the end of the installation shows the command):

```bash
curl -fsSL https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh | sudo bash -s -- --update
# a specific release (also to go back to an older one; read the changelog before downgrading)
curl -fsSL https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh | sudo bash -s -- --update --version 0.1.0
```

`--update` looks up the latest release again and prints the old and the new version. Docker: it sets `FILUFLOW_IMAGE`
to the new tag, pulls and restarts. Native: it fetches the new tag, rebuilds and restarts. An installation made with
`--build`, `--ref` or `--source` keeps building that way (`--ref`: fetches the ref again; `--source`: copies the
checkout again), one made with `--image` pulls that image again. `--version` switches such an installation to releases
(a `--ref` or `--source` installation keeps building them from source; `--no-build` switches to the published image).

By hand (Docker with the release image):

```bash
cd /opt/filuflow && sudo sed -i 's/^FILUFLOW_IMAGE=.*/FILUFLOW_IMAGE=ghcr.io\/mebytede\/filuflow:0.2.0/' .env
sudo docker compose pull && sudo docker compose up -d
```

By hand (built from source):

```bash
cd /opt/filuflow/app && sudo git fetch --depth 1 origin tag v0.2.0 && sudo git checkout -f v0.2.0   # both methods
cd /opt/filuflow && sudo docker compose up -d --build                  # Docker
cd /opt/filuflow/app && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev && sudo systemctl restart filuflow   # native
```

The databases are migrated on start. Back up before larger updates. Update workers and the master together when the
release notes say so.

## Backup and restore

What to back up:

| What | Docker | Native |
|---|---|---|
| Workflows (single server and worker) | `data/workflows/` | `/var/lib/filuflow/workflows/` |
| Execution log, waiting executions, static data, OAuth tokens | `data/filuflow.db` | `/var/lib/filuflow/filuflow.db` |
| Master: users, projects, versions, workers, shared credentials | `data/master.db` | `/var/lib/filuflow/master.db` |
| Credentials from the interface or the master | `data/credentials.managed.json` | `/var/lib/filuflow/credentials.managed.json` |
| Hand-maintained credentials and variables | `data/credentials.json`, `data/vars.json` | in the working directory `/var/lib/filuflow` |
| Settings and **encryption key** | `.env` | `/etc/filuflow/filuflow.env` |

Keep a copy of `FILUFLOW_ENCRYPTION_KEY` separately (password manager): a backup without the key cannot decrypt the
credentials, and the master's worker tokens and TOTP secrets are lost.

The simplest consistent backup stops filuflow briefly:

```bash
# Docker
cd /opt/filuflow && sudo docker compose stop && sudo tar -czf /root/filuflow-$(date +%F).tgz .env .install.conf data && sudo docker compose start
# native
sudo systemctl stop filuflow && sudo tar -czf /root/filuflow-$(date +%F).tgz /etc/filuflow /var/lib/filuflow && sudo systemctl start filuflow
```

Without downtime, copy the SQLite databases with `sqlite3 filuflow.db ".backup /backup/filuflow.db"` (or
`VACUUM INTO`) and the other files as they are.

Restore: install filuflow with the same mode and method (or copy the install directory), stop it, unpack the backup over
the data directory and env file (Docker: `sudo chown -R 1000:1000 data`; native: `sudo chown -R filuflow:filuflow
/var/lib/filuflow`), start it again.

## Uninstalling

```bash
sudo bash /opt/filuflow/app/scripts/install.sh --uninstall           # stops and removes the service, keeps everything else
sudo bash /opt/filuflow/app/scripts/install.sh --uninstall --purge   # also deletes data, settings and the install directory
```

`--uninstall` removes the containers (Docker) or the systemd unit (native) and the Caddy site, and keeps the data and
settings; running the installer again starts the same installation again. `--purge` asks for confirmation and deletes the
install directory, the data, the env file, the locally built image and (native) the system user. Docker, Node.js and
Caddy themselves stay installed.

## Troubleshooting

**Does it run?**

```bash
curl -fsS http://127.0.0.1:5678/healthz        # {"status":"ok"}; master on 5679: {"status":"ok","mode":"master"}
cd /opt/filuflow && sudo docker compose ps && sudo docker compose logs --tail 100
sudo systemctl status filuflow && sudo journalctl -u filuflow -n 100
```

More detail in the log with `FILUFLOW_LOG_LEVEL=debug`.

**Port already in use.** `sudo ss -ltnp | grep 5678` shows who uses it. Choose another port with `--port`, or change it in
the compose file or `FILUFLOW_PORT`. Caddy needs ports 80 and 443 itself.

**The container restarts or the service fails immediately.** Typical causes in the log:

- `FILUFLOW_API_KEY must be set (at least 16 characters)`: worker without a valid API key.
- `FILUFLOW_ENCRYPTION_KEY is missing or shorter than 16 characters`: master without a valid key.
- `EACCES` / `permission denied` on `/data` or `/var/lib/filuflow`: wrong owner of the data directory. Docker:
  `sudo chown -R 1000:1000 /opt/filuflow/data`; native: `sudo chown -R filuflow:filuflow /var/lib/filuflow`. Files
  outside the data directory are read-only for the native service (`ProtectSystem=strict`); add paths with
  `systemctl edit filuflow` (`ReadWritePaths=...`).
- Wrong encryption key after a restore: credentials cannot be decrypted. Use the original key.

**No certificate.** `sudo journalctl -u caddy -n 100`. Check that the domain resolves to the server (`dig +short
flows.example.com`), ports 80 and 443 are open in the firewall and at the hosting provider, and no other web server uses
them.

**Webhook URLs show `localhost` or HTTP.** Set `FILUFLOW_WEBHOOK_URL` (serve, worker) or `FILUFLOW_PUBLIC_URL` (master)
to the public HTTPS address and restart. External services must reach `/webhook/...`, `/form/...` and
`/webhook-waiting/...` through the proxy.

**Streamed responses arrive in one piece.** The proxy buffers: Caddy `flush_interval -1`, nginx `proxy_buffering off`.

**Large uploads fail with 413.** Raise `FILUFLOW_PAYLOAD_SIZE_MAX` and the proxy limit (nginx `client_max_body_size`).

**Master: login attempts are blocked for everyone.** Behind a proxy without `FILUFLOW_TRUST_PROXY=true` all requests
share the proxy's IP address and therefore its rate limit.

**The master cannot reach a worker.** Check from the master host: `curl -fsS https://flows.customer.example/healthz`.
The token in the master must equal the worker's `FILUFLOW_API_KEY`. With a self-signed certificate, add the CA in the
worker settings of the master.

**Docker and the firewall.** Ports published by Docker bypass ufw and firewalld rules. Publish only on `127.0.0.1`
behind a proxy, or restrict access at the network level.

**Pulling the image fails.** `ghcr.io` and its blob storage (`pkg-containers.githubusercontent.com`) must be reachable;
behind a proxy configure it for the Docker daemon. The error "image ... not found" means the version has no published
image (check the releases page; the image of a new release appears a few minutes after its tag).

**Building the image fails.** It needs about 2 GB of RAM (add swap on small servers) and access to Docker Hub and the npm
registry. Behind a proxy configure it for the Docker daemon and the build.

**`curl | bash` gets a 404.** Check the URL (`https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh`).
Without access to GitHub, copy the script to the server and run `sudo bash install.sh --version X.Y.Z` (and set up a
mirror of the image or the repository with `--image` or `--repo`).
