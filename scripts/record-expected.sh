#!/usr/bin/env bash
# Erzeugt fixtures/<name>/expected.json mit echtem n8n (Docker).
#
#   scripts/record-expected.sh            # alle Fixtures ohne expected.json
#   scripts/record-expected.sh --all      # alle Fixtures neu
#   scripts/record-expected.sh 01-linear 05-loop
#
# Ablauf je Lauf: ein Container mit n8n (Version gepinnt), alle Workflows werden mit
# `n8n import:workflow` importiert und mit `n8n execute --id=<id> --rawOutput` ausgeführt.
# HTTP-Fixtures nutzen den Mock-Server (scripts/mock-server.mjs) auf 127.0.0.1:18089,
# daher läuft der Container mit --network host.
# Webhook-Fixtures (Datei webhook.json) werden über `n8n start` + HTTP-Request aufgezeichnet.
set -euo pipefail

N8N_IMAGE="${N8N_IMAGE:-n8nio/n8n:1.123.0}"   # docker.n8n.io/n8nio/n8n:1.123.0 ist identisch
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$ROOT/fixtures"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/flowlite-record.XXXXXX")"
chmod 777 "$WORK"
trap 'rm -rf "$WORK"; [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true' EXIT

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  echo "Docker ist nicht verfügbar. expected.json bitte von Hand erzeugen (siehe docs/STATUS.md)." >&2
  exit 2
fi

ALL=0
NAMES=()
for arg in "$@"; do
  if [[ "$arg" == "--all" ]]; then ALL=1; else NAMES+=("$arg"); fi
done
if [[ ${#NAMES[@]} -eq 0 ]]; then
  for d in "$FIXTURES"/*/; do
    name="$(basename "$d")"
    [[ "$name" == "real" ]] && continue
    [[ -f "$d/workflow.json" ]] || continue
    if [[ $ALL -eq 1 || ! -f "$d/expected.json" ]]; then NAMES+=("$name"); fi
  done
fi
[[ ${#NAMES[@]} -eq 0 ]] && { echo "Nichts zu tun."; exit 0; }

# Mock-Server für HTTP-Fixtures
node "$ROOT/scripts/mock-server.mjs" "$FIXTURES" 18089 > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
sleep 1

ENV_ARGS=(-e GENERIC_TIMEZONE=Europe/Berlin -e TZ=Europe/Berlin -e N8N_DIAGNOSTICS_ENABLED=false
  -e N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false -e N8N_USER_FOLDER=/data/home
  -e N8N_RUNNERS_ENABLED=false -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false -e FL_COMPAT=ja
  -e NODES_EXCLUDE='[]')

BATCH=()
WEBHOOK=()
for name in "${NAMES[@]}"; do
  if [[ -f "$FIXTURES/$name/webhook.json" ]]; then WEBHOOK+=("$name"); else BATCH+=("$name"); fi
done

prepare() { # name -> schreibt $WORK/<name>.json mit ID und versionId, gibt ID aus
  local name="$1"
  node -e '
    const fs = require("fs"); const crypto = require("crypto");
    const [src, dst, name] = process.argv.slice(1);
    const wf = JSON.parse(fs.readFileSync(src, "utf8"));
    wf.id = "fx" + crypto.createHash("md5").update(name).digest("hex").slice(0, 14);
    wf.versionId = crypto.randomUUID();
    wf.active = wf.active ?? false;
    fs.writeFileSync(dst, JSON.stringify(wf));
    process.stdout.write(wf.id);
  ' "$FIXTURES/$name/workflow.json" "$WORK/$name.json" "$name"
}

if [[ ${#BATCH[@]} -gt 0 ]]; then
  SCRIPT="$WORK/run.sh"
  echo 'set -u' > "$SCRIPT"
  for name in "${BATCH[@]}"; do
    if [[ -d "$FIXTURES/$name/sub" ]]; then
      for sub in "$FIXTURES/$name/sub"/*.json; do
        subname="$name--$(basename "$sub" .json)"
        node -e '
          const fs = require("fs"); const crypto = require("crypto");
          const wf = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          wf.versionId = crypto.randomUUID(); wf.active = false;
          fs.writeFileSync(process.argv[2], JSON.stringify(wf));
        ' "$sub" "$WORK/$subname.json"
        echo "n8n import:workflow --input=/data/$subname.json >/dev/null 2>&1 || echo 'Import fehlgeschlagen: $subname'" >> "$SCRIPT"
      done
    fi
    id="$(prepare "$name")"
    echo "n8n import:workflow --input=/data/$name.json >/dev/null 2>&1 || echo 'Import fehlgeschlagen: $name'" >> "$SCRIPT"
    echo "n8n execute --id=$id --rawOutput > /data/$name.out 2>&1 || true" >> "$SCRIPT"
  done
  echo "Führe ${#BATCH[@]} Workflow(s) in $N8N_IMAGE aus ..."
  docker run --rm --network host -v "$WORK:/data" "${ENV_ARGS[@]}" --entrypoint sh "$N8N_IMAGE" /data/run.sh
  for name in "${BATCH[@]}"; do
    node "$ROOT/scripts/extract-expected.mjs" "$WORK/$name.out" "$FIXTURES/$name/expected.json" || {
      echo "Fehler beim Auswerten von $name:"; tail -40 "$WORK/$name.out"; exit 1; }
  done
fi

for name in "${WEBHOOK[@]}"; do
  "$ROOT/scripts/record-webhook.sh" "$name" "$WORK" "$N8N_IMAGE"
done
