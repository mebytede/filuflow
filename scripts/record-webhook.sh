#!/usr/bin/env bash
# Records a webhook fixture with the real reference implementation (called by record-expected.sh).
#   scripts/record-webhook.sh <fixture-name> [work-dir] [image]
# Steps: import and activate the workflow, `n8n start`, send the requests from webhook.json via
# scripts/webhook-client.mjs, stop the reference implementation, read the executions from the SQLite DB.
set -euo pipefail

NAME="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_BASE="${2:-$(mktemp -d "${TMPDIR:-/tmp}/filuflow-webhook.XXXXXX")}"
REFERENCE_IMAGE="${3:-${REFERENCE_IMAGE:-n8nio/n8n:1.123.0}}"
FIX="$ROOT/fixtures/$NAME"
WORK="$WORK_BASE/webhook-$NAME"
CONTAINER="filuflow-record-$NAME-$$"
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

# 1. Import (credentials first, if any)
IMPORT="n8n import:workflow --input=/data/workflow.json"
if [[ -f "$FIX/credentials.json" ]]; then
  node "$ROOT/scripts/credentials-to-reference.mjs" "$FIX/credentials.json" "$WORK/credentials.json"
  IMPORT="n8n import:credentials --input=/data/credentials.json && $IMPORT"
fi
docker run --rm --network host -v "$WORK:/data" "${ENV_ARGS[@]}" --entrypoint sh "$REFERENCE_IMAGE" -c \
  "$IMPORT" >"$WORK/import.log" 2>&1 || { cat "$WORK/import.log"; exit 1; }
# 2. Activate directly in the database (see scripts/activate-reference-workflow.mjs)
node "$ROOT/scripts/activate-reference-workflow.mjs" "$WORK/home/.n8n/database.sqlite" "$ID"
# 3. Start the reference implementation
docker run -d --name "$CONTAINER" --network host -v "$WORK:/data" "${ENV_ARGS[@]}" "$REFERENCE_IMAGE" start >/dev/null

echo "Waiting for the reference implementation ($NAME) ..."
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
