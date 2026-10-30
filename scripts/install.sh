#!/usr/bin/env bash
# filuflow installer: single server (serve), master or worker, with Docker (default) or natively with Node.js 22 and
# systemd, optionally behind Caddy with an automatic Let's Encrypt certificate.
#
#   curl -fsSL https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh | sudo bash -s -- --mode serve
#   sudo bash scripts/install.sh --help
#
# Installs the latest release by default (Docker: the published image, native: built from the release tag).
# Full guide: docs/INSTALL.md. Re-running the installer applies changed settings to an existing installation, --update
# moves it to the latest release (both keep settings, secrets and data). Everything runs inside main(), so a partially
# downloaded script does nothing.
set -euo pipefail

REPO_DEFAULT="https://github.com/mebytede/filuflow.git"
# Release images (tags X.Y.Z, X.Y and latest, see .github/workflows/release.yml)
IMAGE_REPO="ghcr.io/mebytede/filuflow"
RAW_URL="https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh"
SERVICE_NAME="filuflow"
SERVICE_USER="filuflow"
# uid of the user "node" in the official node images (the container runs as this user)
CONTAINER_UID="1000"

# ---------------------------------------------------------------------------------------------------------------------
# Options (empty = not given; defaults are filled in after loading an existing installation)
ACTION="install"
MODE=""
METHOD=""
DOMAIN=""
EMAIL=""
DIR=""
DATA_DIR=""
PORT=""
REF=""
VERSION=""
BUILD=""
IMAGE=""
SOURCE=""
REPO=""
PUBLIC_URL=""
TIMEZONE=""
WITH_PYTHON=""
YES=0
DRY_RUN=0
PURGE=0
NO_DOMAIN=0
API_KEY="${FILUFLOW_API_KEY:-}"
ENC_KEY="${FILUFLOW_ENCRYPTION_KEY:-}"
ADMIN_EMAIL="${FILUFLOW_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${FILUFLOW_ADMIN_PASSWORD:-}"

# State
INTERACTIVE=0
EXISTING=0
GENERATED_API_KEY=""
GENERATED_ENC_KEY=""
GENERATED_ADMIN_PASSWORD=""
# What is installed: release (a released version: Docker image, or built from its git tag with --build or natively),
# ref (a git branch, tag or commit, built from source), source (a local checkout) or image (an own image)
KIND=""
VERSION_CHECKED=0
# The stored installation (from load_state)
S_KIND=""
S_VERSION=""
S_BUILD=""
S_REF=""
S_IMAGE=""
S_SOURCE=""
OS_ID=""
OS_LIKE=""
OS_CODENAME=""
OS_UBUNTU_CODENAME=""
OS_NAME=""
PKG=""

# ---------------------------------------------------------------------------------------------------------------------
# Output

if [ -t 2 ]; then
  C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_GREEN=$'\033[32m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_RED=""; C_YELLOW=""; C_GREEN=""; C_RESET=""
fi

info() { printf '%s==>%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
note() { printf '    %s\n' "$*" >&2; }
warn() { printf '%sWarning:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() { printf '%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
filuflow installer

Usage:
  sudo bash install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/mebytede/filuflow/main/scripts/install.sh | sudo bash -s -- [options]

Actions (default: install, or update if an installation exists in --dir):
  --update                 update an existing installation to the latest release (or --version), restart;
                           keeps settings, data and the way it was installed
  --uninstall              stop and remove the service; keeps data and settings
  --purge                  with --uninstall: also delete data, settings and the install directory

Installation:
  --mode serve|master|worker   operating mode (default: serve)
  --method docker|native       Docker Compose (default) or Node.js 22 with a systemd service
  --dir <path>                 install directory (default: /opt/filuflow)
  --data-dir <path>            native only: data directory (default: /var/lib/filuflow)
  --port <number>              local port (default: 5678, master 5679)
  --domain <name>              put Caddy in front with HTTPS (Let's Encrypt) for this domain;
                               filuflow then listens on 127.0.0.1 only
  --no-domain                  remove a previously configured domain on update
  --email <address>            contact address for Let's Encrypt (recommended with --domain)
  --public-url <url>           public base URL when you run your own reverse proxy (instead of --domain)
  --timezone <zone>            time zone for schedules (default: the server's, else Europe/Berlin)
  --version <X.Y.Z|latest>     release to install (default: the latest release; "v" prefix optional)
  --build                      Docker only: build the image from the release's source instead of pulling
                               ghcr.io/mebytede/filuflow:<version>
  --no-build                   Docker only: go back from --build to the published image
  --ref <git ref>              build a branch, tag or commit from source instead of a release (e.g. main)
  --repo <url>                 git repository (default: https://github.com/mebytede/filuflow.git)
  --source <path>              build from a local checkout instead of cloning
  --image <image>              Docker only: use this image instead of the release image
  --with-python                install Python 3 for "Python (Native)" in the Code node

Secrets (generated when not given; environment variables with the same names work too):
  --api-key <value>            FILUFLOW_API_KEY (serve and worker, at least 16 characters)
  --encryption-key <value>     FILUFLOW_ENCRYPTION_KEY (at least 16 characters)
  --admin-email <address>      master only: create this first admin instead of using the setup token
  --admin-password <value>     master only: password of the first admin (at least 12 characters; generated if omitted)

Behavior:
  -y, --yes                    do not ask, assume yes (required when no terminal is available)
  --dry-run                    show what would be done and write the generated files into --dir,
                               without installing packages or starting services (no root needed)
  -h, --help                   show this help

Examples:
  sudo bash install.sh --mode serve --domain flows.example.com --email admin@example.com --yes
  sudo bash install.sh --mode worker --method native --port 5678
  sudo bash install.sh --mode master --domain filuflow.example.com --admin-email ada@example.com
  sudo bash install.sh --update                  # latest release
  sudo bash install.sh --update --version 0.1.0  # a specific release
  sudo bash install.sh --uninstall
EOF
}

# ---------------------------------------------------------------------------------------------------------------------
# Helpers

# Prints a command in a readable, shell-quoted form.
show_cmd() {
  local out="" a
  for a in "$@"; do out+=" $(printf '%q' "$a")"; done
  printf '%s' "${out# }"
}

# Runs a command, or only prints it in dry-run mode.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] %s\n' "$(show_cmd "$@")" >&2
    return 0
  fi
  printf '    + %s\n' "$(show_cmd "$@")" >&2
  "$@"
}

# Runs a shell snippet (pipes, redirections), or only prints it in dry-run mode. Never pass secrets here.
run_sh() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] %s\n' "$1" >&2
    return 0
  fi
  printf '    + %s\n' "$1" >&2
  bash -c "$1"
}

# docker compose in the install directory (so a docker-compose.override.yml is picked up as well)
dc() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] (cd %s && docker compose %s)\n' "$(printf '%q' "$DIR")" "$(show_cmd "$@")" >&2
    return 0
  fi
  printf '    + (cd %s && docker compose %s)\n' "$(printf '%q' "$DIR")" "$(show_cmd "$@")" >&2
  (cd "$DIR" && docker compose "$@")
}

have() { command -v "$1" >/dev/null 2>&1; }

gen_secret() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

# Where a generated file is written: its real location, or the install directory in dry-run mode.
out_path() {
  if [ "$DRY_RUN" -eq 1 ]; then
    case "$1" in
      "$DIR"/*) printf '%s' "$1" ;;
      *) printf '%s/%s' "$DIR" "$(basename "$1")" ;;
    esac
  else
    printf '%s' "$1"
  fi
}

# write_file <target path> <mode>: content from stdin
write_file() {
  local target="$1" mode="$2" out
  out="$(out_path "$target")"
  mkdir -p "$(dirname "$out")"
  (umask 077 && cat >"$out.tmp.$$")
  chmod "$mode" "$out.tmp.$$"
  mv -f "$out.tmp.$$" "$out"
  note "wrote $out (mode $mode)"
}

ask() {
  # ask <prompt> <default>: answer on stdout
  local answer=""
  printf '%s%s%s%s: ' "$C_BOLD" "$1" "$C_RESET" "${2:+ [$2]}" >/dev/tty
  IFS= read -r answer </dev/tty || true
  printf '%s' "${answer:-$2}"
}

ask_secret() {
  local answer=""
  printf '%s%s%s: ' "$C_BOLD" "$1" "$C_RESET" >/dev/tty
  IFS= read -rs answer </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

confirm() {
  # confirm <question>: returns 0 for yes
  [ "$YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 0
  if [ "$INTERACTIVE" -eq 1 ]; then
    local answer
    answer="$(ask "$1 (y/N)" "")"
    case "$answer" in y | Y | yes | YES | j | J | ja) return 0 ;; *) return 1 ;; esac
  fi
  die "confirmation needed ($1). No terminal available: re-run with --yes."
}

# Env files: KEY=value lines; values with special characters are single-quoted (systemd and docker compose both read
# single-quoted values literally).
env_quote() {
  case "$1" in
    *[!A-Za-z0-9_./:@+=,-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

env_get() {
  # env_get <file> <key>
  [ -f "$1" ] || return 0
  local line
  line="$(grep -E "^$2=" "$1" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line#\'}"
  line="${line%\'}"
  printf '%s' "$line"
}

env_set() {
  # env_set <file> <key> <value>: replaces the key or appends it
  local file="$1" key="$2" value tmp
  value="$(env_quote "$3")"
  tmp="$file.tmp.$$"
  (umask 077 && touch "$tmp")
  if grep -qE "^$key=" "$file" 2>/dev/null; then
    KEY="$key" VALUE="$value" awk 'BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"] }
      index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

env_del() {
  local file="$1" key="$2" tmp
  [ -f "$file" ] || return 0
  tmp="$file.tmp.$$"
  (umask 077; grep -vE "^$key=" "$file" >"$tmp" || true)
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

# ---------------------------------------------------------------------------------------------------------------------
# Arguments and validation

need_value() { [ "$#" -ge 2 ] || die "$1 needs a value"; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --*=*)
        local key="${1%%=*}" value="${1#*=}"
        shift
        set -- "$key" "$value" "$@"
        ;;
    esac
    case "$1" in
      --mode) need_value "$@"; MODE="$2"; shift 2 ;;
      --method) need_value "$@"; METHOD="$2"; shift 2 ;;
      --domain) need_value "$@"; DOMAIN="$2"; shift 2 ;;
      --no-domain) NO_DOMAIN=1; shift ;;
      --email) need_value "$@"; EMAIL="$2"; shift 2 ;;
      --dir) need_value "$@"; DIR="$2"; shift 2 ;;
      --data-dir) need_value "$@"; DATA_DIR="$2"; shift 2 ;;
      --port) need_value "$@"; PORT="$2"; shift 2 ;;
      --ref) need_value "$@"; REF="$2"; shift 2 ;;
      --version) need_value "$@"; VERSION="$2"; shift 2 ;;
      --build) BUILD="true"; shift ;;
      --no-build) BUILD="false"; shift ;;
      --repo) need_value "$@"; REPO="$2"; shift 2 ;;
      --source) need_value "$@"; SOURCE="$2"; shift 2 ;;
      --image) need_value "$@"; IMAGE="$2"; shift 2 ;;
      --public-url) need_value "$@"; PUBLIC_URL="$2"; shift 2 ;;
      --timezone) need_value "$@"; TIMEZONE="$2"; shift 2 ;;
      --with-python) WITH_PYTHON="true"; shift ;;
      --api-key) need_value "$@"; API_KEY="$2"; shift 2 ;;
      --encryption-key) need_value "$@"; ENC_KEY="$2"; shift 2 ;;
      --admin-email) need_value "$@"; ADMIN_EMAIL="$2"; shift 2 ;;
      --admin-password) need_value "$@"; ADMIN_PASSWORD="$2"; shift 2 ;;
      --update) ACTION="update"; shift ;;
      --uninstall) ACTION="uninstall"; shift ;;
      --purge) PURGE=1; shift ;;
      -y | --yes) YES=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  if [ "$PURGE" -eq 1 ] && [ "$ACTION" != "uninstall" ]; then die "--purge only works together with --uninstall"; fi
  if [ -n "$DOMAIN" ] && [ "$NO_DOMAIN" -eq 1 ]; then die "--domain and --no-domain exclude each other"; fi
  if [ -n "$IMAGE" ] && [ -n "$VERSION$REF$SOURCE$BUILD" ]; then die "--image cannot be combined with --version, --ref, --source, --build or --no-build"; fi
  if [ -n "$SOURCE" ] && [ -n "$VERSION$REF" ]; then die "--source cannot be combined with --version or --ref"; fi
  if [ -n "$REF" ] && [ -n "$VERSION" ]; then die "--ref and --version exclude each other (--ref builds a git ref, --version installs a release)"; fi
  if [ "$BUILD" = "false" ] && [ -n "$REF$SOURCE" ]; then die "--no-build cannot be combined with --ref or --source (they always build)"; fi
  return 0
}

valid_domain() {
  [ "${#1}" -le 253 ] && printf '%s' "$1" | grep -qE '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$'
}
# X.Y.Z with an optional "v" and an optional pre-release suffix (X.Y.Z-rc.1), as the release workflow tags them
valid_version() { printf '%s' "$1" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.]*)?$'; }
valid_email() { printf '%s' "$1" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; }
# Values written into env files: no quotes, backslashes, dollar signs or line breaks
valid_plain() { case "$1" in *[\'\"\\\$\`]* | *$'\n'* | *$'\r'*) return 1 ;; *) return 0 ;; esac; }

validate() {
  case "$MODE" in serve | master | worker) ;; *) die "--mode must be serve, master or worker (got '$MODE')" ;; esac
  case "$METHOD" in docker | native) ;; *) die "--method must be docker or native (got '$METHOD')" ;; esac
  case "$PORT" in '' | *[!0-9]*) die "--port must be a number between 1 and 65535 (got '$PORT')" ;; esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "--port must be between 1 and 65535 (got '$PORT')"; fi
  if [ -n "$DOMAIN" ]; then
    valid_domain "$DOMAIN" || die "--domain '$DOMAIN' is not a valid domain name (e.g. flows.example.com)"
    if [ "$PORT" -eq 80 ] || [ "$PORT" -eq 443 ]; then die "--port $PORT is used by Caddy; choose another local port"; fi
  fi
  if [ -n "$EMAIL" ]; then valid_email "$EMAIL" || die "--email '$EMAIL' is not a valid email address"; fi
  if [ -n "$PUBLIC_URL" ]; then
    printf '%s' "$PUBLIC_URL" | grep -qE '^https?://[^[:space:]/]+(/[^[:space:]]*)?$' || die "--public-url must start with http:// or https://"
    valid_plain "$PUBLIC_URL" || die "--public-url contains invalid characters"
  fi
  case "$DIR" in /*) ;; *) die "--dir must be an absolute path (got '$DIR')" ;; esac
  case "$DATA_DIR" in /*) ;; *) die "--data-dir must be an absolute path (got '$DATA_DIR')" ;; esac
  case "$DIR" in / | /bin | /boot | /dev | /etc | /home | /lib | /proc | /root | /sbin | /sys | /usr | /var) die "--dir $DIR is not allowed" ;; esac
  case "$DATA_DIR" in / | /bin | /boot | /dev | /etc | /home | /lib | /proc | /root | /sbin | /sys | /usr | /var) die "--data-dir $DATA_DIR is not allowed" ;; esac
  if [ -n "$REF" ]; then printf '%s' "$REF" | grep -qE '^[A-Za-z0-9._/-]+$' || die "--ref '$REF' contains invalid characters"; fi
  if [ -n "$VERSION" ] && [ "$VERSION" != "latest" ]; then
    valid_version "$VERSION" || die "--version must be a release version like 0.1.0 or v0.1.0, or latest (got '$VERSION'); use --ref for branches and commits"
  fi
  if [ "$BUILD" = "false" ] && [ "$METHOD" != "docker" ]; then die "--no-build only works with --method docker (the native method always builds)"; fi
  if [ -n "$IMAGE" ]; then
    [ "$METHOD" = "docker" ] || die "--image only works with --method docker"
    printf '%s' "$IMAGE" | grep -qE '^[a-z0-9][a-z0-9._/:@-]*$' || die "--image '$IMAGE' is not a valid image reference"
  fi
  if [ -n "$SOURCE" ]; then
    if [ ! -f "$SOURCE/package.json" ] || [ ! -f "$SOURCE/bin/filuflow.js" ]; then die "--source $SOURCE is not a filuflow checkout"; fi
  fi
  if [ -n "$TIMEZONE" ]; then printf '%s' "$TIMEZONE" | grep -qE '^[A-Za-z0-9_+/-]+$' || die "--timezone '$TIMEZONE' is not valid"; fi
  for value in "$API_KEY" "$ENC_KEY" "$ADMIN_EMAIL" "$ADMIN_PASSWORD"; do
    valid_plain "$value" || die "secrets and the admin email must not contain quotes, backslashes, \$ or line breaks"
  done
  if [ -n "$API_KEY" ] && [ "${#API_KEY}" -lt 16 ]; then die "--api-key must be at least 16 characters long"; fi
  if [ -n "$ENC_KEY" ] && [ "${#ENC_KEY}" -lt 16 ]; then die "--encryption-key must be at least 16 characters long"; fi
  if [ -n "$ADMIN_EMAIL" ]; then
    [ "$MODE" = "master" ] || die "--admin-email only applies to --mode master"
    valid_email "$ADMIN_EMAIL" || die "--admin-email '$ADMIN_EMAIL' is not a valid email address"
  fi
  if [ -n "$ADMIN_PASSWORD" ]; then
    [ -n "$ADMIN_EMAIL" ] || die "--admin-password needs --admin-email"
    [ "${#ADMIN_PASSWORD}" -ge 12 ] || die "--admin-password must be at least 12 characters long"
  fi
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# System

ensure_root() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  [ "$(id -u)" -eq 0 ] && return 0
  if have sudo; then
    if [ -f "${BASH_SOURCE[0]:-}" ]; then
      info "Root privileges needed, restarting with sudo"
      exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
    fi
    die "root privileges needed. Pipe the script into sudo: curl -fsSL $RAW_URL | sudo bash -s -- [options]"
  fi
  die "this installer needs root privileges, and sudo is not available. Run it as root."
}

detect_os() {
  if [ -r /etc/os-release ]; then
    local info_line
    # shellcheck disable=SC1091
    info_line="$(. /etc/os-release && printf '%s|%s|%s|%s|%s' "${ID:-}" "${ID_LIKE:-}" "${VERSION_CODENAME:-}" "${UBUNTU_CODENAME:-}" "${PRETTY_NAME:-}")"
    IFS='|' read -r OS_ID OS_LIKE OS_CODENAME OS_UBUNTU_CODENAME OS_NAME <<<"$info_line"
  fi
  case " $OS_ID $OS_LIKE " in
    *" debian "* | *" ubuntu "* | *" raspbian "*) PKG="apt" ;;
    *" fedora "* | *" rhel "* | *" centos "* | *" rocky "* | *" almalinux "*) PKG="dnf" ;;
    *) PKG="" ;;
  esac
  if [ -z "$PKG" ] && have apt-get; then PKG="apt"; fi
  if [ -z "$PKG" ] && have dnf; then PKG="dnf"; fi
  return 0
}

node_ok() { have node && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }
docker_ok() { have docker && docker compose version >/dev/null 2>&1; }

host_address() {
  local ip=""
  if have hostname; then ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"; fi
  if [ -z "$ip" ] && have ip; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1 || true)"; fi
  printf '%s' "${ip:-localhost}"
}

default_timezone() {
  local tz=""
  if [ -L /etc/localtime ]; then
    tz="$(readlink /etc/localtime)"
    tz="${tz#*zoneinfo/}"
  elif [ -r /etc/timezone ]; then
    tz="$(head -n 1 /etc/timezone)"
  fi
  if printf '%s' "$tz" | grep -qE '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$'; then printf '%s' "$tz"; else printf 'Europe/Berlin'; fi
}

port_in_use() {
  have ss || return 1
  [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
}

# ---------------------------------------------------------------------------------------------------------------------
# Existing installation

docker_state_file() { printf '%s/.install.conf' "$DIR"; }
native_state_file() { out_path "/etc/filuflow/install.conf"; }

load_state() {
  local file=""
  if [ -f "$(docker_state_file)" ]; then file="$(docker_state_file)"; elif [ -f "$(native_state_file)" ]; then file="$(native_state_file)"; fi
  [ -n "$file" ] || return 0
  EXISTING=1
  local key value
  local s_mode="" s_method="" s_domain="" s_email="" s_port="" s_repo="" s_data="" s_public="" s_tz="" s_python=""
  while IFS='=' read -r key value; do
    case "$key" in
      MODE) s_mode="$value" ;;
      METHOD) s_method="$value" ;;
      DOMAIN) s_domain="$value" ;;
      EMAIL) s_email="$value" ;;
      PORT) s_port="$value" ;;
      KIND) S_KIND="$value" ;;
      VERSION) S_VERSION="$value" ;;
      BUILD) S_BUILD="$value" ;;
      REF) S_REF="$value" ;;
      IMAGE) S_IMAGE="$value" ;;
      SOURCE) S_SOURCE="$value" ;;
      REPO) s_repo="$value" ;;
      DATA_DIR) s_data="$value" ;;
      PUBLIC_URL) s_public="$value" ;;
      TIMEZONE) s_tz="$value" ;;
      WITH_PYTHON) s_python="$value" ;;
    esac
  done <"$file"
  if [ -n "$MODE" ] && [ "$MODE" != "$s_mode" ]; then die "$DIR is installed in mode '$s_mode'; uninstall it first to change the mode"; fi
  if [ -n "$METHOD" ] && [ "$METHOD" != "$s_method" ]; then die "$DIR is installed with method '$s_method'; uninstall it first to change the method"; fi
  MODE="$s_mode"
  METHOD="$s_method"
  if [ "$NO_DOMAIN" -eq 1 ]; then DOMAIN=""; EMAIL=""; else DOMAIN="${DOMAIN:-$s_domain}"; EMAIL="${EMAIL:-$s_email}"; fi
  PORT="${PORT:-$s_port}"
  # installations from before KIND existed always built from source (a git ref, a local checkout) or used --image
  if [ -z "$S_KIND" ]; then
    if [ -n "$S_IMAGE" ]; then S_KIND="image"; elif [ -n "$S_SOURCE" ]; then S_KIND="source"; else S_KIND="ref"; S_REF="${S_REF:-main}"; fi
  fi
  REPO="${REPO:-$s_repo}"
  DATA_DIR="${DATA_DIR:-$s_data}"
  PUBLIC_URL="${PUBLIC_URL:-$s_public}"
  TIMEZONE="${TIMEZONE:-$s_tz}"
  WITH_PYTHON="${WITH_PYTHON:-$s_python}"
  return 0
}

write_state() {
  local target
  if [ "$METHOD" = "docker" ]; then target="$DIR/.install.conf"; else target="/etc/filuflow/install.conf"; fi
  write_file "$target" 644 <<EOF
# filuflow installation (written by scripts/install.sh, no secrets). Used to update or uninstall.
MODE=$MODE
METHOD=$METHOD
DOMAIN=$DOMAIN
EMAIL=$EMAIL
PORT=$PORT
KIND=$KIND
VERSION=$VERSION
BUILD=$BUILD
REF=$REF
IMAGE=$IMAGE
SOURCE=$SOURCE
REPO=$REPO
DATA_DIR=$DATA_DIR
PUBLIC_URL=$PUBLIC_URL
TIMEZONE=$TIMEZONE
WITH_PYTHON=$WITH_PYTHON
EOF
}

# ---------------------------------------------------------------------------------------------------------------------
# Interactive questions (only for a new installation in a terminal)

prompt_missing() {
  [ "$INTERACTIVE" -eq 1 ] || return 0
  [ "$EXISTING" -eq 0 ] || return 0
  info "A few questions (Enter keeps the default)"
  if [ -z "$MODE" ]; then
    note "serve = single server for one team; master = users, projects and tenants; worker = runs workflows for a master"
    MODE="$(ask "Mode (serve, master, worker)" "serve")"
  fi
  if [ -z "$METHOD" ]; then METHOD="$(ask "Method (docker, native)" "docker")"; fi
  if [ -z "$PORT" ]; then
    local default_port=5678
    [ "$MODE" = "master" ] && default_port=5679
    PORT="$(ask "Local port" "$default_port")"
  fi
  if [ -z "$DOMAIN" ] && [ "$NO_DOMAIN" -eq 0 ] && [ -z "$PUBLIC_URL" ]; then
    note "With a domain, Caddy serves filuflow via HTTPS with a Let's Encrypt certificate (ports 80 and 443 must be reachable)."
    DOMAIN="$(ask "Domain for HTTPS (empty = none)" "")"
  fi
  if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then EMAIL="$(ask "Email for Let's Encrypt (optional)" "")"; fi
  if [ "$MODE" = "master" ] && [ -z "$ADMIN_EMAIL" ]; then
    note "The first admin can be created now, or later with the setup token from the log."
    ADMIN_EMAIL="$(ask "Email of the first admin (empty = use setup token)" "")"
    if [ -n "$ADMIN_EMAIL" ] && [ -z "$ADMIN_PASSWORD" ]; then
      ADMIN_PASSWORD="$(ask_secret "Password of the first admin (at least 12 characters, empty = generate)")"
    fi
  fi
  return 0
}

fill_defaults() {
  MODE="${MODE:-serve}"
  METHOD="${METHOD:-docker}"
  DIR="${DIR%/}"
  if [ -z "$PORT" ]; then if [ "$MODE" = "master" ]; then PORT=5679; else PORT=5678; fi; fi
  REPO="${REPO:-$REPO_DEFAULT}"
  if [ -z "$DATA_DIR" ]; then
    if [ "$METHOD" = "docker" ]; then DATA_DIR="$DIR/data"; else DATA_DIR="/var/lib/filuflow"; fi
  fi
  DATA_DIR="${DATA_DIR%/}"
  TIMEZONE="${TIMEZONE:-$(default_timezone)}"
  if [ -n "$SOURCE" ]; then SOURCE="$(cd "$SOURCE" 2>/dev/null && pwd || printf '%s' "$SOURCE")"; fi
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# Version: what is installed and which release

with_timeout() { if have timeout; then timeout 30 "$@"; else "$@"; fi; }

# Chooses what is installed from the flags, or keeps what the existing installation uses (so an installation made with
# --build, --ref, --source or --image keeps that on --update).
decide_kind() {
  if [ -n "$IMAGE" ]; then KIND="image"
  elif [ -n "$SOURCE" ]; then KIND="source"
  elif [ -n "$REF" ]; then KIND="ref"
  elif [ -n "$VERSION$BUILD" ]; then KIND="release"
  elif [ "$EXISTING" -eq 1 ]; then
    KIND="$S_KIND"
    case "$KIND" in
      release) ;;
      ref) REF="$S_REF" ;;
      source) SOURCE="$S_SOURCE" ;;
      image) IMAGE="$S_IMAGE" ;;
      *) die "unknown KIND '$KIND' in the installation state of $DIR" ;;
    esac
  else
    KIND="release"
  fi
  if [ "$ACTION" != "uninstall" ] && [ "$KIND" = "source" ] && { [ ! -f "$SOURCE/package.json" ] || [ ! -f "$SOURCE/bin/filuflow.js" ]; }; then
    die "the local checkout $SOURCE is gone or not a filuflow checkout; pass --source, --version or --ref"
  fi
  if [ "$KIND" = "release" ] && [ "$METHOD" = "docker" ]; then
    if [ -z "$BUILD" ]; then
      # keep building from source when the installation did so before
      if [ "$EXISTING" -eq 1 ] && { [ "$S_BUILD" = "true" ] || [ "$S_KIND" = "ref" ] || [ "$S_KIND" = "source" ]; }; then BUILD="true"; else BUILD="false"; fi
    fi
  else
    BUILD=""
  fi
  return 0
}

# Prints the highest released version X.Y.Z (pre-releases are ignored) from the git tags of the repository, or fails.
# FILUFLOW_INSTALL_LATEST_VERSION replaces the lookup (tests, offline mirrors); set but empty it simulates a failure.
latest_release() {
  if [ -n "${FILUFLOW_INSTALL_LATEST_VERSION+x}" ]; then
    [ -n "$FILUFLOW_INSTALL_LATEST_VERSION" ] || return 1
    valid_version "$FILUFLOW_INSTALL_LATEST_VERSION" || die "FILUFLOW_INSTALL_LATEST_VERSION '$FILUFLOW_INSTALL_LATEST_VERSION' is not a version"
    printf '%s' "${FILUFLOW_INSTALL_LATEST_VERSION#v}"
    return 0
  fi
  local tags="" url=""
  if have git; then
    tags="$(GIT_TERMINAL_PROMPT=0 with_timeout git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null || true)"
    tags="$(printf '%s\n' "$tags" | sed -n 's#^.*refs/tags/v\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)$#\1#p')"
  elif have curl && case "$REPO" in https://github.com/*) true ;; *) false ;; esac; then
    # without git: GitHub redirects /releases/latest to the newest release that is not a pre-release
    url="$(curl -fsSL --max-time 20 -o /dev/null -w '%{url_effective}' "${REPO%.git}/releases/latest" 2>/dev/null || true)"
    tags="$(printf '%s\n' "$url" | sed -n 's#^.*/releases/tag/v\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\)$#\1#p')"
  fi
  [ -n "$tags" ] || return 1
  printf '%s\n' "$tags" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# Sets VERSION for a release installation: the given one, the installed one on a plain re-run, else the latest release.
resolve_version() {
  if [ "$KIND" != "release" ]; then VERSION=""; return 0; fi
  if [ -n "$VERSION" ] && [ "$VERSION" != "latest" ]; then VERSION="${VERSION#v}"; return 0; fi
  if [ -z "$VERSION" ] && [ "$EXISTING" -eq 1 ] && [ "$ACTION" != "update" ] && [ "$S_KIND" = "release" ] && [ -n "$S_VERSION" ]; then
    # re-running without --update changes the settings, not the version
    VERSION="$S_VERSION"
    return 0
  fi
  local latest=""
  info "Looking up the latest release in $REPO"
  latest="$(latest_release)" || latest=""
  VERSION="$latest"
  if [ -n "$VERSION" ]; then note "latest release: $VERSION"; return 0; fi
  if uses_source; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "could not determine the latest release; the dry run shows main instead"
      return 0
    fi
    die "could not determine the latest release from $REPO (needs git and network access). Pass --version X.Y.Z, or --ref main for the development state"
  fi
  warn "could not determine the latest release from $REPO; using the image tag latest (pin a version with --version X.Y.Z)"
}

# HTTP status of the release image's manifest in the registry (anonymous pull token, like docker pull), 000 on errors
image_manifest_status() {
  local registry="${IMAGE_REPO%%/*}" name="${IMAGE_REPO#*/}" token
  token="$(curl -fsS --max-time 20 "https://$registry/token?scope=repository:$name:pull" 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -I -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://$registry/v2/$name/manifests/$1" 2>/dev/null || true
}

# Checks that the chosen release exists, without changing anything: the image tag in the registry, or the git tag when
# building. A missing release stops the installer; an unreachable registry or repository only warns (pulling or cloning
# reports it again). Skipped in a dry run, and postponed while git is not installed yet.
verify_version() {
  [ "$VERSION_CHECKED" -eq 0 ] || return 0
  if [ "$DRY_RUN" -eq 1 ] || [ "$KIND" != "release" ] || [ -z "$VERSION" ]; then VERSION_CHECKED=1; return 0; fi
  local status=0
  if uses_source; then
    have git || return 0
    GIT_TERMINAL_PROMPT=0 with_timeout git ls-remote --exit-code --tags "$REPO" "refs/tags/v$VERSION" >/dev/null 2>&1 || status=$?
    case "$status" in
      0) ;;
      2) die "release $VERSION not found: $REPO has no tag v$VERSION (releases: ${REPO%.git}/releases)" ;;
      *) warn "could not check the tag v$VERSION in $REPO (git exit code $status)" ;;
    esac
  else
    have curl || return 0
    status="$(image_manifest_status "$VERSION")"
    case "$status" in
      200) ;;
      404) die "image $(pulled_image) not found. Check the version (releases: ${REPO_DEFAULT%.git}/releases); the image of a new release appears a few minutes after its tag" ;;
      *) warn "could not check the image $(pulled_image) in the registry (HTTP status $status)" ;;
    esac
  fi
  VERSION_CHECKED=1
}

# ---------------------------------------------------------------------------------------------------------------------
# Derived settings

base_url() {
  if [ -n "$DOMAIN" ]; then printf 'https://%s' "$DOMAIN"
  elif [ -n "$PUBLIC_URL" ]; then printf '%s' "${PUBLIC_URL%/}"
  else printf 'http://%s:%s' "$(host_address)" "$PORT"
  fi
}

bind_host() { if [ -n "$DOMAIN" ]; then printf '127.0.0.1'; else printf '0.0.0.0'; fi; }
container_port() { if [ "$MODE" = "master" ]; then printf '5679'; else printf '5678'; fi; }
app_dir() { printf '%s/app' "$DIR"; }
env_file_target() { if [ "$METHOD" = "docker" ]; then printf '%s/.env' "$DIR"; else printf '/etc/filuflow/filuflow.env'; fi; }
unit_target() { printf '/etc/systemd/system/%s.service' "$SERVICE_NAME"; }
caddy_site_target() { printf '/etc/caddy/filuflow.caddy'; }
# true when the code is fetched (or copied) and built on this server; false when a Docker image is pulled
uses_source() { [ "$METHOD" = "native" ] || [ "$KIND" = "ref" ] || [ "$KIND" = "source" ] || { [ "$KIND" = "release" ] && [ "$BUILD" = "true" ]; }; }
# the image the compose file runs when nothing is built
pulled_image() {
  if [ "$KIND" = "image" ]; then printf '%s' "$IMAGE"; else printf '%s:%s' "$IMAGE_REPO" "${VERSION:-latest}"; fi
}
# the git ref that is fetched: the release tag, or the given ref
fetch_ref() {
  if [ "$KIND" = "ref" ]; then printf '%s' "$REF"; elif [ -n "$VERSION" ]; then printf 'v%s' "$VERSION"; else printf 'main'; fi
}
# describe_version <kind> <version> <build> <ref> <image> <source>: one line for the plan and the summary
describe_version() {
  case "$1" in
    release)
      if [ -z "$2" ] && { [ "$METHOD" = "native" ] || [ "$3" = "true" ]; }; then printf 'main (latest release not determined)'
      elif [ -z "$2" ]; then printf 'latest (image %s:latest; exact version not determined)' "$IMAGE_REPO"
      elif [ "$METHOD" = "native" ] || [ "$3" = "true" ]; then printf '%s (built from git tag v%s)' "$2" "$2"
      else printf '%s (image %s:%s)' "$2" "$IMAGE_REPO" "$2"
      fi
      ;;
    ref) printf 'git ref %s (built from source)' "$4" ;;
    source) printf 'local checkout %s (built from source)' "$6" ;;
    image) printf 'image %s' "$5" ;;
    *) printf 'unknown' ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------------
# Prerequisites

MISSING=()
add_missing() { MISSING+=("$1"); }

check_prerequisites() {
  MISSING=()
  have curl || add_missing curl
  if uses_source && [ -z "$SOURCE" ]; then have git || add_missing git; fi
  if [ "$METHOD" = "docker" ]; then
    docker_ok || add_missing docker
  else
    node_ok || add_missing nodejs
    { have make && have g++; } || add_missing build-tools
    have python3 || add_missing python3
  fi
  if [ -n "$DOMAIN" ]; then have caddy || add_missing caddy; fi
  # each entry once
  local unique=() seen=" " item
  for item in "${MISSING[@]+"${MISSING[@]}"}"; do
    case "$seen" in *" $item "*) ;; *) unique+=("$item"); seen+="$item " ;; esac
  done
  MISSING=("${unique[@]+"${unique[@]}"}")
}

describe_missing() {
  local item
  for item in "${MISSING[@]+"${MISSING[@]}"}"; do
    case "$item" in
      docker) note "Docker Engine and the compose plugin (official Docker repository, download.docker.com)" ;;
      nodejs) note "Node.js 22 (NodeSource repository, deb.nodesource.com / rpm.nodesource.com)" ;;
      build-tools) note "compiler and make (only used if better-sqlite3 has no prebuilt binary)" ;;
      python3) note "Python 3 (node-gyp, and \"Python (Native)\" in the Code node)" ;;
      caddy) note "Caddy web server (official Caddy repository, dl.cloudsmith.io)" ;;
      *) note "$item" ;;
    esac
  done
}

apt_install() { run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }

install_docker() {
  if [ "$PKG" = "apt" ]; then
    local distro codename
    case " $OS_ID $OS_LIKE " in
      *" ubuntu "*) distro="ubuntu"; codename="${OS_UBUNTU_CODENAME:-$OS_CODENAME}" ;;
      *) distro="debian"; codename="$OS_CODENAME" ;;
    esac
    [ -n "$codename" ] || die "cannot determine the distribution codename for the Docker repository; install Docker manually (https://docs.docker.com/engine/install/)"
    apt_install ca-certificates curl
    run install -m 0755 -d /etc/apt/keyrings
    run curl -fsSL "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
    run chmod a+r /etc/apt/keyrings/docker.asc
    run_sh "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$distro $codename stable\" > /etc/apt/sources.list.d/docker.list"
    run apt-get update
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    local repo="https://download.docker.com/linux/fedora/docker-ce.repo"
    case " $OS_ID $OS_LIKE " in *" fedora "*) ;; *) repo="https://download.docker.com/linux/rhel/docker-ce.repo" ;; esac
    run dnf -y install dnf-plugins-core
    run_sh "dnf config-manager --add-repo $repo || dnf config-manager addrepo --from-repofile=$repo"
    run dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  run systemctl enable --now docker
}

install_node() {
  if [ "$PKG" = "apt" ]; then
    apt_install ca-certificates curl gnupg
    run install -m 0755 -d /etc/apt/keyrings
    run_sh "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
    run_sh "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
    run apt-get update
    apt_install nodejs
  else
    run_sh "curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -"
    run dnf -y install nodejs
  fi
}

install_caddy() {
  if [ "$PKG" = "apt" ]; then
    apt_install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    run_sh "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    run_sh "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list"
    run chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    run apt-get update
    apt_install caddy
  else
    run dnf -y install 'dnf-command(copr)'
    run dnf -y copr enable @caddy/caddy
    run dnf -y install caddy
  fi
  run systemctl enable --now caddy
}

install_prerequisites() {
  [ "${#MISSING[@]}" -gt 0 ] || return 0
  if [ -z "$PKG" ]; then
    warn "unsupported distribution (${OS_NAME:-unknown}): only Debian/Ubuntu (apt) and Fedora/RHEL (dnf) are installed automatically."
    note "Please install these first and run the installer again:"
    describe_missing
    [ "$DRY_RUN" -eq 1 ] && return 0
    exit 1
  fi
  info "Installing prerequisites"
  local need_update=1 item
  for item in "${MISSING[@]}"; do
    case "$item" in
      curl | git | build-tools | python3)
        if [ "$PKG" = "apt" ]; then
          if [ "$need_update" -eq 1 ]; then run apt-get update; need_update=0; fi
          case "$item" in
            build-tools) apt_install build-essential ;;
            *) apt_install "$item" ;;
          esac
        else
          case "$item" in
            build-tools) run dnf -y install gcc-c++ make ;;
            *) run dnf -y install "$item" ;;
          esac
        fi
        ;;
    esac
  done
  for item in "${MISSING[@]}"; do
    case "$item" in
      docker) install_docker ;;
      nodejs) install_node ;;
      caddy) install_caddy ;;
    esac
  done
}

# ---------------------------------------------------------------------------------------------------------------------
# Source code

fetch_source() {
  local dest
  dest="$(app_dir)"
  if [ -n "$SOURCE" ]; then
    info "Copying the local checkout $SOURCE to $dest"
    run rm -rf "$dest.new"
    run mkdir -p "$dest.new"
    run_sh "tar -C $(printf '%q' "$SOURCE") --exclude=./node_modules --exclude=./dist --exclude=./.git --exclude=./coverage --exclude=./data --exclude='./*.db' --exclude='./*.db-*' -cf - . | tar -C $(printf '%q' "$dest.new") -xf -"
    run rm -rf "$dest"
    run mv "$dest.new" "$dest"
  elif [ -d "$dest/.git" ]; then
    info "Fetching $(fetch_ref) from $REPO"
    run git -C "$dest" remote set-url origin "$REPO"
    run git -C "$dest" fetch --depth 1 origin "$(fetch_ref)"
    run git -C "$dest" checkout -q -f FETCH_HEAD
  else
    info "Cloning $REPO ($(fetch_ref)) to $dest"
    run mkdir -p "$dest"
    run git -C "$dest" init -q
    run git -C "$dest" remote add origin "$REPO"
    run git -C "$dest" fetch --depth 1 origin "$(fetch_ref)"
    run git -C "$dest" checkout -q -f FETCH_HEAD
  fi
  run chmod -R go+rX "$dest"
}

# ---------------------------------------------------------------------------------------------------------------------
# Configuration files

write_env() {
  local target out url
  target="$(env_file_target)"
  out="$(out_path "$target")"
  url="$(base_url)"
  mkdir -p "$(dirname "$out")"
  if [ ! -f "$out" ]; then
    write_file "$target" 600 <<EOF
# filuflow settings, written by scripts/install.sh. Contains secrets: keep it private (mode 600) and back it up.
# Re-running the installer keeps the secrets and your own additions; it only updates the address settings
# and FILUFLOW_IMAGE (the release image).
# All variables: README.md (Configuration) and docs/INSTALL.md.
EOF
  else
    note "keeping secrets and own settings in $out"
  fi
  chmod 600 "$out"

  # secrets: keep existing values, take given ones, generate missing ones
  if [ "$MODE" != "master" ]; then
    if [ -n "$API_KEY" ]; then env_set "$out" FILUFLOW_API_KEY "$API_KEY"
    elif [ -z "$(env_get "$out" FILUFLOW_API_KEY)" ]; then GENERATED_API_KEY="$(gen_secret)"; env_set "$out" FILUFLOW_API_KEY "$GENERATED_API_KEY"
    fi
  fi
  if [ -n "$ENC_KEY" ]; then env_set "$out" FILUFLOW_ENCRYPTION_KEY "$ENC_KEY"
  elif [ -z "$(env_get "$out" FILUFLOW_ENCRYPTION_KEY)" ]; then GENERATED_ENC_KEY="$(gen_secret)"; env_set "$out" FILUFLOW_ENCRYPTION_KEY "$GENERATED_ENC_KEY"
  fi

  # address settings (rewritten on every run)
  if [ "$MODE" = "master" ]; then
    env_set "$out" FILUFLOW_PUBLIC_URL "$url"
    if [ -n "$DOMAIN" ]; then env_set "$out" FILUFLOW_TRUST_PROXY true; else env_set "$out" FILUFLOW_TRUST_PROXY false; fi
    if [ -n "$ADMIN_EMAIL" ] && [ "$EXISTING" -eq 0 ]; then
      if [ -z "$ADMIN_PASSWORD" ]; then GENERATED_ADMIN_PASSWORD="$(gen_secret | cut -c1-24)"; ADMIN_PASSWORD="$GENERATED_ADMIN_PASSWORD"; fi
      env_set "$out" FILUFLOW_ADMIN_EMAIL "$ADMIN_EMAIL"
      env_set "$out" FILUFLOW_ADMIN_PASSWORD "$ADMIN_PASSWORD"
    fi
  else
    env_set "$out" FILUFLOW_WEBHOOK_URL "$url/"
    if [ -z "$(env_get "$out" FILUFLOW_TIMEZONE)" ]; then env_set "$out" FILUFLOW_TIMEZONE "$TIMEZONE"; fi
  fi

  # Docker: the image the compose file runs (docker compose reads .env for ${FILUFLOW_IMAGE})
  if [ "$METHOD" = "docker" ]; then
    if uses_source; then env_del "$out" FILUFLOW_IMAGE; else env_set "$out" FILUFLOW_IMAGE "$(pulled_image)"; fi
  fi

  if [ "$METHOD" = "native" ]; then
    env_set "$out" NODE_ENV production
    env_set "$out" FILUFLOW_HOST "$(bind_host)"
    env_set "$out" FILUFLOW_PORT "$PORT"
    if [ "$MODE" = "master" ]; then
      env_set "$out" FILUFLOW_MASTER_DB "$DATA_DIR/master.db"
    else
      env_set "$out" FILUFLOW_DIR "$DATA_DIR/workflows"
      env_set "$out" FILUFLOW_DB "$DATA_DIR/filuflow.db"
      env_set "$out" FILUFLOW_MANAGED_CREDENTIALS "$DATA_DIR/credentials.managed.json"
      env_set "$out" FILUFLOW_BINARY_DIR "$DATA_DIR/binary"
      env_set "$out" FILUFLOW_PYTHON_PACKAGES_DIR "$DATA_DIR/pyodide"
      env_set "$out" FILUFLOW_NODES_DIR "$DATA_DIR/nodes"
    fi
  fi
}

write_compose() {
  local ports cport command build image
  cport="$(container_port)"
  if [ -n "$DOMAIN" ]; then ports="127.0.0.1:$PORT:$cport"; else ports="$PORT:$cport"; fi
  case "$MODE" in
    serve) command='["node", "/app/bin/filuflow.js", "serve"]' ;;
    worker) command='["node", "/app/bin/filuflow.js", "worker"]' ;;
    master) command='["node", "/app/bin/filuflow.js", "master", "--db", "/data/master.db"]' ;;
  esac
  if ! uses_source; then
    # shellcheck disable=SC2016 # interpolated by docker compose from .env, not by the shell
    image='${FILUFLOW_IMAGE:?FILUFLOW_IMAGE missing in .env}'
    build=""
  else
    image="filuflow:local"
    build="    build:
      context: ./app
      args:
        WITH_PYTHON: \"${WITH_PYTHON:-false}\"
"
  fi
  write_file "$DIR/docker-compose.yml" 644 <<EOF
# filuflow ($MODE), written by scripts/install.sh. Re-running the installer rewrites this file:
# put your own changes into docker-compose.override.yml next to it (docker compose reads both).
# Settings, secrets and the image (FILUFLOW_IMAGE) are in .env, data (workflows, database, credentials) in ./data.
name: filuflow
services:
  filuflow:
${build}    image: $image
    restart: unless-stopped
    env_file: .env
    environment:
      FILUFLOW_PORT: "$cport"
      FILUFLOW_NODES_DIR: /data/nodes
    ports:
      - "$ports"
    volumes:
      - ./data:/data
    command: $command
EOF
}

write_unit() {
  local node_bin caps=""
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ] || ! node_ok; then node_bin="/usr/bin/node"; fi
  if [ "$PORT" -lt 1024 ]; then caps="AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"; else caps="CapabilityBoundingSet="; fi
  write_file "$(unit_target)" 644 <<EOF
# filuflow ($MODE), written by scripts/install.sh. Re-running the installer rewrites this file:
# put your own changes into a drop-in (systemctl edit $SERVICE_NAME).
[Unit]
Description=filuflow ($MODE)
Documentation=https://github.com/mebytede/filuflow/blob/main/docs/INSTALL.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DATA_DIR
Environment=HOME=$DATA_DIR
EnvironmentFile=/etc/filuflow/filuflow.env
ExecStart=$node_bin $(app_dir)/bin/filuflow.js $MODE
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

# Hardening: read-only system, writable only the data directory
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
SystemCallArchitectures=native
$caps

[Install]
WantedBy=multi-user.target
EOF
}

write_caddy_site() {
  local tls=""
  [ -n "$EMAIL" ] && tls="
	tls $EMAIL"
  write_file "$(caddy_site_target)" 644 <<EOF
# filuflow ($MODE), written by scripts/install.sh. Caddy gets a Let's Encrypt certificate for $DOMAIN
# automatically (ports 80 and 443 must be reachable from the internet, DNS must point to this server).
$DOMAIN {$tls
	reverse_proxy 127.0.0.1:$PORT {
		# pass streamed responses (webhook streaming, chat) through immediately
		flush_interval -1
	}
}
EOF
}

# Makes the main Caddyfile import our site file. The packaged default site (port 80 with a static page) is replaced,
# after a backup; any other existing Caddyfile is kept and only gets the import line.
configure_caddy_main() {
  local main="/etc/caddy/Caddyfile" line
  line="import $(caddy_site_target)"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "[dry-run] would make $main import $(caddy_site_target) and reload Caddy"
    return 0
  fi
  if [ ! -f "$main" ] || grep -q 'root \* /usr/share/caddy' "$main"; then
    if [ -f "$main" ]; then run cp -p "$main" "$main.bak-$(date +%Y%m%d%H%M%S)"; fi
    printf '# Written by the filuflow installer (previous file backed up next to it).\n%s\n' "$line" >"$main"
    note "wrote $main"
  elif ! grep -qxF "$line" "$main"; then
    run cp -p "$main" "$main.bak-$(date +%Y%m%d%H%M%S)"
    printf '\n%s\n' "$line" >>"$main"
    note "added the import line to $main"
  fi
  if have caddy; then run caddy validate --config "$main" --adapter caddyfile; fi
  run systemctl enable caddy
  run_sh "systemctl reload caddy || systemctl restart caddy"
}

remove_caddy_site() {
  local main="/etc/caddy/Caddyfile" site
  site="$(caddy_site_target)"
  [ -f "$(out_path "$site")" ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    rm -f "$(out_path "$site")"
    note "[dry-run] would remove $site and its import line in $main, then reload Caddy"
    return 0
  fi
  run rm -f "$site"
  if [ -f "$main" ] && grep -qxF "import $site" "$main"; then
    grep -vxF "import $site" "$main" >"$main.tmp.$$" || true
    mv -f "$main.tmp.$$" "$main"
  fi
  if have systemctl && systemctl is-active --quiet caddy 2>/dev/null; then run_sh "systemctl reload caddy || true"; fi
}

# ---------------------------------------------------------------------------------------------------------------------
# Start, health check, summary

wait_for_health() {
  local url="http://127.0.0.1:$PORT/healthz"
  if [ "$DRY_RUN" -eq 1 ]; then note "[dry-run] would wait for $url"; return 0; fi
  info "Waiting for $url"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then note "filuflow answers"; return 0; fi
    sleep 2
  done
  warn "filuflow did not answer within 3 minutes."
  if [ "$METHOD" = "docker" ]; then
    note "Logs: cd $DIR && docker compose logs --tail 100"
    dc logs --tail 50 || true
  else
    note "Logs: journalctl -u $SERVICE_NAME -n 100"
    journalctl -u "$SERVICE_NAME" -n 50 --no-pager 2>/dev/null || true
  fi
  return 1
}

read_setup_token() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  local logs=""
  for _ in 1 2 3 4 5; do
    if [ "$METHOD" = "docker" ]; then
      logs="$(cd "$DIR" || exit 0; docker compose logs --no-color filuflow 2>/dev/null || true)"
    else
      logs="$(journalctl -u "$SERVICE_NAME" --no-pager -o cat 2>/dev/null || true)"
    fi
    if printf '%s' "$logs" | grep -q '"setupToken"'; then break; fi
    sleep 1
  done
  printf '%s' "$logs" | grep -o '"setupToken":"[^"]*"' | tail -n 1 | cut -d'"' -f4 || true
}

start_docker() {
  if ! uses_source; then
    info "Pulling $(pulled_image) and starting"
    dc pull
    dc up -d --remove-orphans
  else
    info "Building the image (takes a few minutes on the first run) and starting"
    dc build --pull
    dc up -d --remove-orphans
  fi
}

prepare_native() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    local nologin
    nologin="$(command -v nologin 2>/dev/null || printf '/usr/sbin/nologin')"
    run useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell "$nologin" "$SERVICE_USER"
  fi
  run install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
  if [ "$MODE" != "master" ]; then run install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/workflows"; fi
}

build_native() {
  local dest
  dest="$(app_dir)"
  info "Installing dependencies and building in $dest"
  run_sh "cd $(printf '%q' "$dest") && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund"
  run chmod -R go+rX "$dest"
}

start_native() {
  info "Starting the systemd service $SERVICE_NAME"
  run systemctl daemon-reload
  run systemctl enable "$SERVICE_NAME"
  run systemctl restart "$SERVICE_NAME"
}

print_summary() {
  local old_label="$1" new_label="$2" url env_out logs_cmd update_cmd token=""
  url="$(base_url)"
  env_out="$(out_path "$(env_file_target)")"
  if [ "$METHOD" = "docker" ]; then logs_cmd="cd $DIR && docker compose logs -f"; else logs_cmd="journalctl -u $SERVICE_NAME -f"; fi
  if uses_source && { [ -f "$(app_dir)/scripts/install.sh" ] || [ "$DRY_RUN" -eq 1 ]; }; then
    update_cmd="sudo bash $(app_dir)/scripts/install.sh --update --dir $DIR"
  else
    update_cmd="curl -fsSL $RAW_URL | sudo bash -s -- --update --dir $DIR"
  fi

  printf '\n%s%s%s\n' "$C_BOLD" "filuflow $( [ "$DRY_RUN" -eq 1 ] && printf 'dry run finished (nothing was installed or started)' || printf 'is running')" "$C_RESET"
  printf '  Mode / method:  %s / %s\n' "$MODE" "$METHOD"
  if [ -n "$old_label" ] && [ "$old_label" != "$new_label" ]; then
    printf '  Version:        %s -> %s\n' "$old_label" "$new_label"
  else
    printf '  Version:        %s\n' "$new_label"
  fi
  printf '  Address:        %s/\n' "$url"
  [ -n "$DOMAIN" ] || [ -n "$PUBLIC_URL" ] || printf '                  (plain HTTP; use --domain for HTTPS before using it over a network)\n'
  case "$MODE" in
    serve) printf '  Login:          open the address and sign in with the API key (FILUFLOW_API_KEY in %s)\n' "$env_out" ;;
    worker)
      printf '  Next step:      in the master, Administration, add this worker with the address %s\n' "$url"
      printf '                  and the API key as token (FILUFLOW_API_KEY in %s)\n' "$env_out"
      ;;
    master)
      if [ "$EXISTING" -eq 1 ]; then
        printf '  Login:          with your existing account (emergency access: filuflow master user ...)\n'
      elif [ -n "$ADMIN_EMAIL" ]; then
        printf '  Login:          %s with the admin password (shown below if generated)\n' "$ADMIN_EMAIL"
      else
        token="$(read_setup_token)"
        if [ -n "$token" ]; then
          printf '  First admin:    open %s/#/setup and enter the setup token %s\n' "$url" "$token"
        else
          printf '  First admin:    open %s/#/setup with the setup token from the log:\n' "$url"
          printf '                  %s | grep setupToken\n' "${logs_cmd% -f}"
        fi
      fi
      ;;
  esac
  printf '  Settings:       %s\n' "$env_out"
  if [ "$METHOD" = "docker" ]; then
    printf '  Compose file:   %s\n' "$(out_path "$DIR/docker-compose.yml")"
  else
    printf '  Service:        %s (systemctl status %s)\n' "$(out_path "$(unit_target)")" "$SERVICE_NAME"
  fi
  printf '  Data:           %s\n' "$DATA_DIR"
  [ -z "$DOMAIN" ] || printf '  Caddy site:     %s\n' "$(out_path "$(caddy_site_target)")"
  printf '  Logs:           %s\n' "$logs_cmd"
  printf '  Update:         %s\n' "$update_cmd"
  case "$KIND" in
    release) printf '                  (moves to the latest release; add --version X.Y.Z to pin or change the version)\n' ;;
    ref) printf '                  (fetches %s again and rebuilds; --version X.Y.Z or --version latest switches to releases)\n' "$REF" ;;
    source) printf '                  (copies %s again and rebuilds; --version X.Y.Z switches to releases)\n' "$SOURCE" ;;
    image) printf '                  (pulls %s again; --version X.Y.Z switches to the release images)\n' "$IMAGE" ;;
  esac
  if [ "$METHOD" = "docker" ]; then
    printf '  Back up:        cd %s && docker compose stop && tar -czf /root/filuflow-backup.tgz .env .install.conf data && docker compose start\n' "$DIR"
  else
    printf '  Back up:        systemctl stop %s && tar -czf /root/filuflow-backup.tgz /etc/filuflow %s && systemctl start %s\n' "$SERVICE_NAME" "$DATA_DIR" "$SERVICE_NAME"
  fi
  printf '  Uninstall:      sudo bash install.sh --uninstall --dir %s   (add --purge to delete data)\n' "$DIR"
  printf '  Guide:          docs/INSTALL.md\n'

  if [ -n "$GENERATED_API_KEY$GENERATED_ENC_KEY$GENERATED_ADMIN_PASSWORD" ]; then
    printf '\n%sGenerated secrets (shown only now; they are stored in %s):%s\n' "$C_BOLD" "$env_out" "$C_RESET"
    [ -z "$GENERATED_API_KEY" ] || printf '  FILUFLOW_API_KEY         %s\n' "$GENERATED_API_KEY"
    [ -z "$GENERATED_ENC_KEY" ] || printf '  FILUFLOW_ENCRYPTION_KEY  %s\n' "$GENERATED_ENC_KEY"
    [ -z "$GENERATED_ADMIN_PASSWORD" ] || printf '  Admin password           %s\n' "$GENERATED_ADMIN_PASSWORD"
    if [ -n "$GENERATED_ENC_KEY" ]; then
      printf '%s  Store the encryption key in a safe place (password manager). Without it, encrypted credentials%s\n' "$C_YELLOW" "$C_RESET"
      printf '%s  %s cannot be decrypted after a restore.%s\n' "$C_YELLOW" "$( [ "$MODE" = "master" ] && printf 'and worker tokens in the master' || printf 'of this server')" "$C_RESET"
    fi
  fi
  if [ "$MODE" = "master" ] && [ -n "$ADMIN_EMAIL" ] && [ "$EXISTING" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    printf '  The admin password was removed from %s after the first start.\n' "$env_out"
  fi
  if [ -n "$DOMAIN" ]; then
    printf '\nFirewall: ports 80 and 443 must be reachable for Caddy; port %s stays local.\n' "$PORT"
  else
    printf '\nFirewall: open port %s only to the networks that need it.\n' "$PORT"
  fi
  [ "$METHOD" != "docker" ] || [ -n "$DOMAIN" ] || printf 'Note: Docker publishes ports past ufw/firewalld rules.\n'
}

# ---------------------------------------------------------------------------------------------------------------------
# Actions

do_install() {
  local verb="Installing" new_label old_label=""
  [ "$EXISTING" -eq 1 ] && verb="Updating"
  new_label="$(describe_version "$KIND" "$VERSION" "$BUILD" "$REF" "$IMAGE" "$SOURCE")"
  [ "$EXISTING" -eq 0 ] || old_label="$(describe_version "$S_KIND" "$S_VERSION" "$S_BUILD" "$S_REF" "$S_IMAGE" "$S_SOURCE")"
  info "$verb filuflow: mode $MODE, method $METHOD, directory $DIR"
  check_prerequisites
  verify_version
  if [ "$EXISTING" -eq 0 ] && port_in_use "$PORT"; then warn "port $PORT is already in use on this machine"; fi
  if [ -n "$DOMAIN" ] && [ "$EXISTING" -eq 0 ] && ! have caddy && { port_in_use 80 || port_in_use 443; }; then
    warn "port 80 or 443 is already in use; Caddy needs both for HTTPS"
  fi

  info "Plan"
  if [ "$EXISTING" -eq 0 ]; then note "version: $new_label"
  elif [ "$old_label" = "$new_label" ]; then note "version: $new_label (unchanged)"
  else note "version: $old_label -> $new_label"
  fi
  if [ "${#MISSING[@]}" -gt 0 ]; then
    note "install missing prerequisites:"
    describe_missing
  fi
  if uses_source; then
    if [ -n "$SOURCE" ]; then note "copy the local checkout $SOURCE to $(app_dir)"; else note "get $REPO ($(fetch_ref)) into $(app_dir)"; fi
  fi
  if [ "$METHOD" = "docker" ]; then
    if uses_source; then note "build the Docker image filuflow:local"; else note "pull the image $(pulled_image)"; fi
    note "write $DIR/docker-compose.yml and $DIR/.env (mode 600), data in $DATA_DIR"
  else
    note "create the system user $SERVICE_USER, data in $DATA_DIR"
    note "npm ci, npm run build, remove dev dependencies"
    note "write /etc/filuflow/filuflow.env (mode 600) and $(unit_target)"
  fi
  if [ "$WITH_PYTHON" = "true" ] && [ "$METHOD" = "docker" ] && ! uses_source; then
    warn "--with-python has no effect with a prebuilt image (the image decides whether Python is included; use --build)"
  fi
  [ -z "$DOMAIN" ] || note "configure Caddy for https://$DOMAIN -> 127.0.0.1:$PORT (filuflow listens on 127.0.0.1 only)"
  note "start filuflow and wait for /healthz"
  [ "$DRY_RUN" -eq 0 ] || note "(dry run: only the configuration files are written, into $DIR)"
  confirm "Continue" || die "aborted, nothing was changed"

  [ "$DRY_RUN" -eq 1 ] && mkdir -p "$DIR"
  install_prerequisites
  verify_version
  run mkdir -p "$DIR"
  if uses_source; then fetch_source; fi

  info "Writing configuration"
  write_env
  if [ "$METHOD" = "docker" ]; then
    write_compose
    run mkdir -p "$DATA_DIR/workflows"
    run chown -R "$CONTAINER_UID:$CONTAINER_UID" "$DATA_DIR"
    run chmod 700 "$DATA_DIR"
  else
    prepare_native
    write_unit
  fi
  if [ -n "$DOMAIN" ]; then
    write_caddy_site
  else
    remove_caddy_site
  fi
  write_state

  if [ "$METHOD" = "docker" ]; then
    start_docker
  else
    build_native
    start_native
  fi
  if [ -n "$DOMAIN" ]; then configure_caddy_main; fi
  wait_for_health || exit 1
  if [ "$MODE" = "master" ] && [ -n "$ADMIN_EMAIL" ] && [ "$EXISTING" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    # the master only reads it while there are no users; do not keep the password on disk
    env_del "$(env_file_target)" FILUFLOW_ADMIN_PASSWORD
  fi
  print_summary "$old_label" "$new_label"
}

do_uninstall() {
  [ "$EXISTING" -eq 1 ] || die "no installation found in $DIR (looked for $(docker_state_file) and $(native_state_file))"
  info "Uninstalling filuflow ($MODE, $METHOD) from $DIR"
  if [ "$PURGE" -eq 1 ]; then
    warn "--purge deletes all workflows, executions, credentials and settings irreversibly:"
    if [ "$METHOD" = "docker" ]; then note "$DIR (including $DATA_DIR and .env)"; else note "$(app_dir), $DATA_DIR, /etc/filuflow, user $SERVICE_USER"; fi
    if [ "$INTERACTIVE" -eq 1 ] && [ "$YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
      [ "$(ask "Type purge to confirm" "")" = "purge" ] || die "aborted, nothing was changed"
    else
      confirm "Delete everything" || die "aborted, nothing was changed"
    fi
  else
    note "data and settings are kept (add --purge to delete them)"
    confirm "Stop and remove the filuflow service" || die "aborted, nothing was changed"
  fi

  if [ "$METHOD" = "docker" ]; then
    if [ -f "$DIR/docker-compose.yml" ]; then
      if [ "$PURGE" -eq 1 ]; then dc down --remove-orphans --rmi local; else dc down --remove-orphans; fi
    fi
  else
    run systemctl disable --now "$SERVICE_NAME"
    run rm -f "$(unit_target)"
    run systemctl daemon-reload
  fi
  [ -z "$DOMAIN" ] || remove_caddy_site

  if [ "$PURGE" -eq 1 ]; then
    if [ "$METHOD" = "docker" ]; then
      run rm -rf "$DIR"
    else
      run rm -rf "$(app_dir)" "$DATA_DIR" /etc/filuflow
      run rmdir --ignore-fail-on-non-empty "$DIR"
      if [ "$DRY_RUN" -eq 1 ] || id -u "$SERVICE_USER" >/dev/null 2>&1; then run userdel "$SERVICE_USER"; fi
    fi
    info "filuflow was removed completely"
  else
    info "filuflow was stopped and removed; data and settings are still there"
    if [ "$METHOD" = "docker" ]; then note "$DIR"; else note "$DATA_DIR, /etc/filuflow, $(app_dir)"; fi
    note "Run the installer again to start it again, or uninstall with --purge to delete everything."
  fi
  if [ "$METHOD" = "docker" ] && [ "$PURGE" -eq 1 ] && ! uses_source; then
    note "The image $(pulled_image) stays in Docker's image cache: docker image rm $(pulled_image)"
  fi
  note "Docker, Node.js and Caddy themselves stay installed."
}

main() {
  parse_args "$@"
  ensure_root "$@"
  if [ "$YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && (: </dev/tty) 2>/dev/null; then INTERACTIVE=1; fi
  DIR="${DIR:-/opt/filuflow}"
  DIR="${DIR%/}"
  case "$DIR" in /*) ;; *) die "--dir must be an absolute path (got '$DIR')" ;; esac
  detect_os
  load_state

  case "$ACTION" in
    uninstall)
      fill_defaults
      decide_kind
      VERSION="$S_VERSION"
      do_uninstall
      ;;
    update)
      [ "$EXISTING" -eq 1 ] || die "no installation found in $DIR; run without --update to install"
      fill_defaults
      validate
      decide_kind
      resolve_version
      do_install
      ;;
    install)
      if [ "$EXISTING" -eq 1 ]; then info "Found an existing installation in $DIR: updating it (settings, secrets and data are kept)"; fi
      prompt_missing
      fill_defaults
      validate
      decide_kind
      resolve_version
      do_install
      ;;
  esac
}

main "$@"
