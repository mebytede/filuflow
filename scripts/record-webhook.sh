#!/usr/bin/env bash
# Zeichnet ein Webhook-Fixture mit echtem n8n auf (wird von record-expected.sh aufgerufen).
#   scripts/record-webhook.sh <fixture-name> [arbeitsverzeichnis] [image]
# Ablauf: Workflow importieren und aktivieren, `n8n start`, Requests aus webhook.json über
# scripts/webhook-client.mjs senden, n8n stoppen, Executions aus der SQLite-DB lesen.
set -euo pipefail

NAME="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_BASE="${2:-$(mktemp -d "${TMPDIR:-/tmp}/flowlite-webhook.XXXXXX")}"
N8N_IMAGE="${3:-${N8N_IMAGE:-n8nio/n8n:1.123.0}}"
FIX="$ROOT/fixtures/$NAME"
WORK="$WORK_BASE/webhook-$NAME"
CONTAINER="flowlite-record-$NAME-$$"
mkdir -p "$WORK"
chmod 777 "$WORK"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

ID="$(node -e '
  const fs = require("fs"); const crypto = require("crypto");
  const [src, dst, name] = process.argv.slice(1);
  const wf = JSON.parse(fs.readFileSync(src, "utf8"));
  wf.id = "fx" + crypto.createHash("md5").update(name).digest("hex").slice(0, 14);
  wf.versionId = crypto.randomUUID();
  wf.active = false;
  fs.writeFileSync(dst, JSON.stringify(wf));
  process.stdout.write(wf.id);
' "$FIX/workflow.json" "$WORK/workflow.json" "$NAME")"

ENV_ARGS=(-e GENERIC_TIMEZONE=Europe/Berlin -e TZ=Europe/Berlin -e N8N_DIAGNOSTICS_ENABLED=false
  -e N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false -e N8N_USER_FOLDER=/data/home
  -e N8N_RUNNERS_ENABLED=false -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false -e FL_COMPAT=ja
  -e N8N_PORT=5678 -e N8N_LISTEN_ADDRESS=127.0.0.1 -e N8N_PERSONALIZATION_ENABLED=false -e N8N_VERSION_NOTIFICATIONS_ENABLED=false)

# 1. Import (Credentials ggf. vorher)
IMPORT="n8n import:workflow --input=/data/workflow.json"
if [[ -f "$FIX/credentials.json" ]]; then
  node "$ROOT/scripts/credentials-to-n8n.mjs" "$FIX/credentials.json" "$WORK/credentials.json"
  IMPORT="n8n import:credentials --input=/data/credentials.json && $IMPORT"
fi
docker run --rm --network host -v "$WORK:/data" "${ENV_ARGS[@]}" --entrypoint sh "$N8N_IMAGE" -c \
  "$IMPORT" >"$WORK/import.log" 2>&1 || { cat "$WORK/import.log"; exit 1; }
# 2. Aktivieren direkt in der Datenbank (siehe scripts/activate-n8n-workflow.mjs)
node "$ROOT/scripts/activate-n8n-workflow.mjs" "$WORK/home/.n8n/database.sqlite" "$ID"
# 3. n8n starten
docker run -d --name "$CONTAINER" --network host -v "$WORK:/data" "${ENV_ARGS[@]}" "$N8N_IMAGE" start >/dev/null

echo "Warte auf n8n ($NAME) ..."
for _ in $(seq 1 90); do
  if docker logs "$CONTAINER" 2>&1 | grep -q "Editor is now accessible"; then break; fi
  sleep 1
done
sleep 2
docker logs "$CONTAINER" 2>&1 | grep -iE "activ|error" | head -20 || true

node "$ROOT/scripts/webhook-client.mjs" "$FIX/webhook.json" "http://127.0.0.1:5678" > "$WORK/responses.json"
sleep 2
docker stop "$CONTAINER" >/dev/null
node "$ROOT/scripts/extract-webhook.mjs" "$WORK/home/.n8n/database.sqlite" "$WORK/responses.json" "$FIX/expected.json"
