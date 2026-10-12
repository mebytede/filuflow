# flowlite

Schlanke, n8n-kompatible Workflow-Engine ohne Editor. Exportierte n8n-Workflows (JSON, `executionOrder: v1`)
laufen unverändert und liefern dieselben Items an denselben Nodes wie n8n 1.x (Referenz: n8n 1.123.0).

Details: [docs/SPEC.md](docs/SPEC.md), Stand: [docs/STATUS.md](docs/STATUS.md),
bewusste Abweichungen: [docs/DEVIATIONS.md](docs/DEVIATIONS.md), Sicherheitsmodell: [docs/SECURITY.md](docs/SECURITY.md).

## Installation
```
npm install
npm run build        # optional, sonst läuft die CLI über tsx
```

## CLI
```
flowlite validate <wf.json> [--json]
flowlite run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
flowlite nodes [--json]
```

`flowlite run` prüft den Workflow vorab (unbekannte Node-Typen oder Versionen brechen ab, bevor ein Node läuft)
und gibt danach eine Übersicht pro Node aus:
```
$ flowlite run fixtures/01-linear/workflow.json
Workflow "01 Lineare Kette", Execution efdf1bcf-...
  OK     Start        0 ms  1 Item
  OK     Felder      22 ms  1 Item
  OK     Erzeugen     2 ms  5 Items
  OK     Gross?       4 ms  Ausgang 0: 4, Ausgang 1: 1
  OK     Wahr         0 ms  4 Items
  OK     Falsch       2 ms  1 Item
Status: success, Dauer 33 ms
```

- `--json`: vollständige Execution inklusive `runData` (Credential-Werte maskiert)
- `--only-last`: nur die Ausgabe des zuletzt ausgeführten Nodes (JSON der Items; mit `--json` inklusive Binärdaten)
- `--input`: Start-Items, als Array aus `{ "json": ... }` oder einfachen Objekten
- `--trigger`: Start-Node, wenn der Workflow mehrere Trigger hat
- `--no-pin`: `pinData` ignorieren (n8n `execute` ignoriert pinData immer)
- `--credentials`, `--vars`, `--workflows`: Credentials, `$vars` und Verzeichnis für Unter-Workflows

Exit-Code 0 bei Erfolg, 1 bei Fehlern (Validierung oder fehlgeschlagene Execution).

## Server
```
FLOWLITE_API_KEY=geheim flowlite serve --dir ./workflows --port 5678 --db ./flowlite.db
```
- Lädt alle `*.json` aus `--dir` und lädt bei Änderungen neu. Workflows mit `"active": true` registrieren
  Webhooks (`/webhook/<pfad>`) und Schedules; Test-URLs (`/webhook-test/<pfad>`) gibt es für alle gültigen Workflows.
- Ungültige Workflows (z. B. unbekannte Node-Typen) werden nicht aktiviert; der Grund steht im Log und in `GET /api/workflows`.
- REST-API mit Header `X-API-Key`: `GET /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows/:id/run`
  (Body = Items, `?wait=false` für asynchron), `GET /api/executions?workflow=&status=&limit=`, `GET /api/executions/:id`,
  `POST /api/executions/:id/cancel`, `GET /healthz`.
- Execution-Log in SQLite, Aufbewahrung `FLOWLITE_PRUNE_DAYS` (Default 14), höchstens `FLOWLITE_CONCURRENCY` (Default 5) gleichzeitige Executions.
- Öffentliche Basis-URL für `webhookUrl`: `FLOWLITE_WEBHOOK_URL` (oder `WEBHOOK_URL` wie bei n8n).

Executions ansehen:
```
flowlite executions list [--workflow <id>] [--status error] [--db ./flowlite.db]
flowlite executions show <id> [--json]
```

### Smoke-Test per curl
Mit dem Webhook-Fixture (Respond-Node):
```
mkdir -p /tmp/fl/workflows && cp fixtures/08-webhook-respond/workflow.json /tmp/fl/workflows/
cd /tmp/fl && FLOWLITE_API_KEY=geheim flowlite serve --port 5690 --dir workflows &

curl -i -X POST 'http://localhost:5690/webhook/fl-fixture-08?n=3' -H 'content-type: application/json' -d '{"name":"Ada"}'
# HTTP/1.1 201 Created, x-flowlite: ja
# {"gruss":"Hallo Ada","anzahl":6,"tags":null}

curl -s -H 'X-API-Key: geheim' http://localhost:5690/api/workflows
curl -s -H 'X-API-Key: geheim' 'http://localhost:5690/api/executions?limit=5'
curl -s http://localhost:5690/healthz          # {"status":"ok"}
flowlite executions list --db /tmp/fl/flowlite.db
```

### Docker
```
FLOWLITE_API_KEY=geheim docker compose up -d --build
```
`docker-compose.yml` bindet `./workflows` (nur lesend), `./credentials.json` und ein Volume für die Datenbank ein.
Das Image basiert auf `node:22-slim` und läuft als Benutzer `node`.

## Credentials
`credentials.json` (oder ein Verzeichnis mit einer Datei je Credential), Schlüssel = Credential-Name wie im Workflow,
Fallback auf die ID:
```json
{
  "API Header": { "id": "abc123", "type": "httpHeaderAuth", "data": { "name": "X-Api-Key", "value": "{{ env.API_KEY }}" } },
  "Token-Server": { "type": "oAuth2Api", "data": { "grantType": "clientCredentials", "accessTokenUrl": "https://auth.example/token",
                    "clientId": "flowlite", "clientSecret": "{{ env.OAUTH_SECRET }}", "scope": "lesen", "authentication": "header" } }
}
```
- Feldnamen wie in n8n (`httpHeaderAuth`, `httpBasicAuth`, `httpQueryAuth`, `httpBearerAuth`, `httpCustomAuth`, `oAuth2Api`, `jwtAuth`).
- KI-Modelle: `openAiApi` (`apiKey`, optional `url`), `anthropicApi` (`apiKey`, optional `url`), `googlePalmApi` (`apiKey`, optional `host`).
- `{{ env.NAME }}` holt Werte aus der Umgebung; `flowlite validate` meldet fehlende Credentials und Variablen.
- Exporte von `n8n export:credentials --decrypted` funktionieren direkt.
- Verschlüsseln: `FLOWLITE_ENCRYPTION_KEY=... flowlite credentials encrypt credentials.json --out credentials.enc.json`
  (Namen und Typen bleiben lesbar, `decrypt` zum Bearbeiten, `check` zum Prüfen).

## KI-Nodes
Basic LLM Chain, Information Extractor, Text Classifier, Sentiment Analysis und AI Agent (Tools Agent v2 bis 3) mit den Modellen
OpenAI (Chat Completions), Anthropic und Gemini, den Tools Calculator, Code, HTTP Request und Workflow sowie Simple Memory.
Die Modelle werden direkt per HTTP angesprochen (kein LangChain). Sub-Nodes hängen wie in n8n über `ai_*`-Verbindungen am
Eltern-Node und erscheinen im Execution-Log mit eigenen Läufen. Abweichungen: `docs/DEVIATIONS.md`.

## Tests
```
npm test             # Unit-Tests und Orakel (Filter, Expressions, KI)
npm run test:compat  # Golden-Tests gegen Ergebnisse aus echtem n8n (CLI, Engine, Webhooks)
npm run lint
```
