# filuflow

Schlanke, n8n-kompatible Workflow-Engine mit eigener Weboberfläche. Exportierte n8n-Workflows (JSON, `executionOrder: v1`)
laufen unverändert und liefern dieselben Items an denselben Nodes wie n8n 1.x (Referenz: n8n 1.123.0).

> filuflow hieß bis Oktober 2026 **flowlite**. Alte Umgebungsvariablen (`FLOWLITE_*`) gelten weiter, solange die neue
> (`FILUFLOW_*`) nicht gesetzt ist; beim Start erscheint dann ein Hinweis. Die Standard-Datenbank heißt jetzt `filuflow.db`
> (vorhandene `flowlite.db` umbenennen oder mit `--db` angeben). API-Tokens mit `flt_` und vom Master verteilte Workflows
> mit alter Kennzeichnung bleiben gültig.

Details: [docs/SPEC.md](docs/SPEC.md), Stand: [docs/STATUS.md](docs/STATUS.md),
bewusste Abweichungen: [docs/DEVIATIONS.md](docs/DEVIATIONS.md), Sicherheitsmodell: [docs/SECURITY.md](docs/SECURITY.md).

## Installation
```
npm install
npm run build        # CLI und Weboberfläche (dist/); ohne Build läuft die CLI über tsx, die Oberfläche fehlt dann
```

## CLI
```
filuflow validate <wf.json> [--json]
filuflow run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
filuflow nodes [--json]
```

`filuflow run` prüft den Workflow vorab (unbekannte Node-Typen oder Versionen brechen ab, bevor ein Node läuft)
und gibt danach eine Übersicht pro Node aus:
```
$ filuflow run fixtures/01-linear/workflow.json
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
FILUFLOW_API_KEY=geheim filuflow serve --dir ./workflows --port 5678 --db ./filuflow.db
```
- Lädt alle `*.json` aus `--dir` und lädt bei Änderungen neu. Workflows mit `"active": true` registrieren
  Webhooks (`/webhook/<pfad>`) und Schedules; Test-URLs (`/webhook-test/<pfad>`) gibt es für alle gültigen Workflows.
- Ungültige Workflows (z. B. unbekannte Node-Typen) werden nicht aktiviert; der Grund steht im Log und in `GET /api/workflows`.
- REST-API mit Header `X-API-Key`: `GET /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows/:id/run`
  (Body = Items, `?wait=false` für asynchron), `GET /api/executions?workflow=&status=&limit=`, `GET /api/executions/:id`,
  `POST /api/executions/:id/cancel`, `GET /healthz`.
- Execution-Log in SQLite, Aufbewahrung `FILUFLOW_PRUNE_DAYS` (Default 14), höchstens `FILUFLOW_CONCURRENCY` (Default 5) gleichzeitige Executions.
- Öffentliche Basis-URL für `webhookUrl`: `FILUFLOW_WEBHOOK_URL` (oder `WEBHOOK_URL` wie bei n8n).

Executions ansehen:
```
filuflow executions list [--workflow <id>] [--status error] [--db ./filuflow.db]
filuflow executions show <id> [--json]
```

### Smoke-Test per curl
Mit dem Webhook-Fixture (Respond-Node):
```
mkdir -p /tmp/fl/workflows && cp fixtures/08-webhook-respond/workflow.json /tmp/fl/workflows/
cd /tmp/fl && FILUFLOW_API_KEY=geheim filuflow serve --port 5690 --dir workflows &

curl -i -X POST 'http://localhost:5690/webhook/fl-fixture-08?n=3' -H 'content-type: application/json' -d '{"name":"Ada"}'
# HTTP/1.1 201 Created, x-flowlite: ja
# {"gruss":"Hallo Ada","anzahl":6,"tags":null}

curl -s -H 'X-API-Key: geheim' http://localhost:5690/api/workflows
curl -s -H 'X-API-Key: geheim' 'http://localhost:5690/api/executions?limit=5'
curl -s http://localhost:5690/healthz          # {"status":"ok"}
filuflow executions list --db /tmp/fl/filuflow.db
```

### Docker
```
FILUFLOW_API_KEY=geheim docker compose up -d --build
```
`docker-compose.yml` bindet `./workflows` (beschreibbar, für den Editor), `./credentials.json` und ein Volume für die Datenbank ein.
Das Image basiert auf `node:22-slim` und läuft als Benutzer `node` im Arbeitsverzeichnis `/data`
(Workflows unter `/data/workflows`, optional `/data/credentials.json` und `/data/vars.json`). Ohne Compose:
```
docker build -t filuflow .
docker run -p 5678:5678 -e FILUFLOW_API_KEY=geheim -v "$PWD/data:/data" filuflow
```

## Weboberfläche
`filuflow serve` liefert unter `http://localhost:5678/` eine Weboberfläche mit Workflow-Editor aus. Anmeldung mit dem Wert von
`FILUFLOW_API_KEY`. Gestaltet nach dem filuflow-Design (IBM Plex, dunkel als Standard, hell unter **Einstellungen**).

- **Workflows:** Kennzahlen (aktiv, Ausführungen und Fehler der letzten 14 Tage, gleichzeitige Ausführungen), Suche und Filter
  (Alle, Aktiv, Inaktiv, Ungültig), Tabelle mit Auslöser, Zustand, letztem Lauf, Dauer und Läufen; neu anlegen, n8n-Export
  importieren (Datei oder Einfügen), löschen.
- **Editor:** Knoten über **Knoten** oben links (oder Taste N) per Klick (hängt sich an den ausgewählten Knoten an) oder per Ziehen
  einfügen; Ausgang auf Eingang ziehen zum Verbinden (KI-Sub-Nodes vom Port oben auf den passenden Eingang unten am Eltern-Node);
  Verbindung anklicken und Entf zum Löschen. Rechts die Details des ausgewählten Knotens: Parameter (Formular oder JSON, `fx`
  schaltet zwischen festem Wert und Expression), Credentials, Einstellungen (deaktiviert, Fehlerverhalten, Wiederholen, Notizen)
  und nach dem Ausführen das Ergebnis als Tabelle oder JSON. Fehler und Hinweise der Prüfung stehen im Fuß der Knoten und oben rechts.
- **Speichern** schreibt die Datei im Workflow-Verzeichnis; der Schalter **Aktiv** schaltet Webhooks und Zeitpläne an (speichert).
  **Testlauf** läuft mit dem aktuellen, auch ungespeicherten Stand. Durchlaufene Knoten, Ports und Kanten sind hervorgehoben, jeder
  Knoten zeigt Status und Dauer.
- **Letzter Lauf** unter dem Canvas: die letzte Ausführung des Workflows mit Status, Typ, Ausgabe und Dauer je Knoten und einer
  Zeitleiste; Klick auf eine Zeile wählt den Knoten.
- **Ausführungen:** Liste mit Filter nach Workflow und Status, Detailansicht mit dem Workflow-Stand der Ausführung.
- Optionale Angaben für den Fuß der Seitenleiste: `FILUFLOW_INSTANCE_NAME` (Default: Hostname), `FILUFLOW_IMPRINT_URL` und
  `FILUFLOW_PRIVACY_URL` (Links "Impressum" und "Datenschutz", nur wenn gesetzt).

Tastatur im Editor: Strg+S speichern, Strg+Enter Testlauf, N Knoten hinzufügen, Strg+Z / Strg+Umschalt+Z rückgängig / wiederholen,
Strg+C / Strg+X / Strg+V kopieren, ausschneiden, einfügen (kompatibel mit kopierten n8n-Nodes), Strg+A alles auswählen, Entf löschen,
D deaktivieren, 1 einpassen, Esc Auswahl aufheben. Umschalt+Ziehen auf freier Fläche wählt mit einem Rahmen aus, Strg+Mausrad zoomt.

## Mehrbenutzer-Betrieb: Master und Worker
Für Teams und mehrere Mandanten gibt es zwei weitere Betriebsarten. Der Einzelbetrieb mit `filuflow serve` bleibt unverändert.

```
          Team (Browser)
               │  Anmeldung: Passwort + TOTP oder SSO (OIDC)
        ┌──────▼───────┐
        │   Master     │  Benutzer, Rechte, Projekte, Workflows (versioniert), Audit-Log
        └──┬────────┬──┘
   HTTPS + │        │ HTTPS + Token des Workers
   Token   │        │
   ┌───────▼──┐  ┌──▼───────┐
   │ Worker   │  │ Worker   │  in der Umgebung des Mandanten: führt aus, Webhooks, Zeitpläne,
   │ Kunde A  │  │ Kunde B  │  Credentials und Ausführungsdaten bleiben hier
   └──────────┘  └──────────┘
```

- **Master** (`filuflow master`): Weboberfläche mit Anmeldung, Projekten, Editor und Verwaltung. Führt selbst nichts aus.
- **Worker** (`filuflow worker`): ein `filuflow serve` mit API für den Master. Der Master verbindet sich zum Worker (der Worker
  braucht keinen Zugang zum Master) und verteilt Workflows beim Speichern. Fällt der Master aus, laufen die Worker weiter.
- **Mandant:** Gruppe von Workern (z. B. Test und Produktion eines Kunden). **Projekt:** Ordner für Workflows mit Mitgliedern,
  genau einem Worker zugeordnet.
- **Rollen:** global Administrator (alles) oder Mitglied (nur eigene Projekte). Im Projekt: Lesen (Workflows, Ausführungen,
  Credential-Namen), Bearbeiten (zusätzlich ändern, ausführen, aktivieren, löschen), Projekt-Admin (zusätzlich Mitglieder).

### Worker starten (beim Mandanten)
```
FILUFLOW_API_KEY=<langer-zufallswert> FILUFLOW_ENCRYPTION_KEY=<schluessel> FILUFLOW_WEBHOOK_URL=https://flows.kunde.example/ \
  filuflow worker --dir ./workflows --port 5678
```
- `FILUFLOW_API_KEY` (mindestens 16 Zeichen) ist der Token, den der Master beim Worker einträgt.
- Workflows vom Master landen als `<id>.json` in `--dir`; von Hand abgelegte Workflows ohne Kennzeichnung bleiben unberührt.
- Credentials: die von Hand gepflegte `credentials.json` (nur lesen, Vorrang) plus `credentials.managed.json`
  (`FILUFLOW_MANAGED_CREDENTIALS`), in die der Master schreibt. Mit `FILUFLOW_ENCRYPTION_KEY` verschlüsselt.
- Die eigene Oberfläche ist im Worker-Modus aus (`FILUFLOW_UI=true` schaltet sie ein).

### Master starten
```
FILUFLOW_ENCRYPTION_KEY=<schluessel> FILUFLOW_PUBLIC_URL=https://filuflow.example filuflow master --port 5679 --db ./master.db
```
Beim ersten Start ohne Benutzer schreibt der Master ein Einrichtungs-Token ins Log; damit legt man unter `/#/setup` den ersten
Administrator an. Danach unter **Verwaltung**: Mandant anlegen, Worker mit Adresse und Token eintragen (der Master prüft die
Verbindung), Projekt anlegen und dem Worker zuordnen, Mitglieder hinzufügen.

| Variable | Bedeutung |
|---|---|
| `FILUFLOW_ENCRYPTION_KEY` | Pflicht, mindestens 16 Zeichen. Verschlüsselt Worker-Tokens und TOTP-Schlüssel in der Datenbank. Gut aufbewahren: ohne ihn sind Worker und TOTP neu einzurichten |
| `FILUFLOW_PUBLIC_URL` | Adresse des Masters für Browser (bei `https://` Cookies mit Secure) und OIDC-Redirect |
| `FILUFLOW_MASTER_DB` / `--db` | SQLite-Datei (Default `./master.db`) |
| `FILUFLOW_PORT` / `--port` | Port (Default 5679) |
| `FILUFLOW_ADMIN_EMAIL`, `FILUFLOW_ADMIN_PASSWORD` | erster Admin beim ersten Start statt Einrichtungs-Token |
| `FILUFLOW_SESSION_HOURS` | Sitzung endet nach so vielen Stunden ohne Aktivität (Default 12, spätestens nach 7 Tagen) |
| `FILUFLOW_SYNC_SECONDS` | Abgleich mit den Workern (Default 60, 0 = aus) |
| `FILUFLOW_TRUST_PROXY` | `true` hinter einem Reverse Proxy (IP aus `X-Forwarded-For` für die Begrenzung der Anmeldeversuche) |

Benutzer auf der Kommandozeile (z. B. Notfall-Zugang, wenn TOTP verloren ist):
```
FILUFLOW_NEW_PASSWORD=... filuflow master user add --email ada@example.org --name "Ada" --admin --db ./master.db
filuflow master user list --db ./master.db
filuflow master user set-password --email ada@example.org --db ./master.db     # fragt nach dem Passwort
filuflow master user reset-totp --email ada@example.org --db ./master.db
```

### Anmeldung über SSO (OpenID Connect)
Zusätzlich zu Passwort und TOTP kann der Master Benutzer über einen Identity Provider anmelden (Keycloak, Entra ID, Google,
Authentik, Zitadel o. ä.; Authorization Code Flow mit PKCE). Beim Identity Provider einen Client mit der Redirect-URI
`<FILUFLOW_PUBLIC_URL>/api/auth/oidc/callback` anlegen, dann:

| Variable | Bedeutung |
|---|---|
| `FILUFLOW_OIDC_ISSUER` | Aussteller-URL (Discovery unter `/.well-known/openid-configuration`) |
| `FILUFLOW_OIDC_CLIENT_ID`, `FILUFLOW_OIDC_CLIENT_SECRET` | Client; das Secret wird per HTTP Basic gesendet (ohne Secret: öffentlicher Client mit PKCE) |
| `FILUFLOW_OIDC_LABEL` | Text des Anmeldeknopfs (Default "Mit SSO anmelden") |
| `FILUFLOW_OIDC_SCOPES` | Default `openid email profile` (für Gruppen ggf. `groups` ergänzen) |
| `FILUFLOW_OIDC_AUTO_CREATE=true` | unbekannte Benutzer beim ersten Login als Mitglied anlegen (sonst muss ein Admin sie vorher anlegen) |
| `FILUFLOW_OIDC_ALLOWED_DOMAINS` | nur diese E-Mail-Domains, kommagetrennt |
| `FILUFLOW_OIDC_ADMIN_GROUP`, `FILUFLOW_OIDC_GROUPS_CLAIM` | Mitglieder dieser Gruppe (Claim, Default `groups`) werden Admin, alle anderen Mitglied; der letzte Admin bleibt Admin |

Zuordnung: zuerst über die Identität beim Identity Provider (Aussteller und `sub`), sonst über die E-Mail-Adresse eines vorhandenen
Benutzers (nicht bei `email_verified: false`; die Identität wird dann verknüpft). Vorab angelegte Benutzer ohne Passwort können sich
nur über SSO anmelden. Bei SSO fragt filuflow kein TOTP ab; die zweite Stufe liegt beim Identity Provider.

### Arbeiten im Master
- **Projekte:** Workflows anlegen (sofort gespeichert und an den Worker verteilt), aus n8n importieren, verschieben, löschen.
  Status je Workflow: aktiv, Verteilung (Version beim Worker), Fehler beim Aktivieren.
- **Editor:** wie im Einzelbetrieb. Prüfen, Ausführen und Credential-Auswahl laufen über den Worker des Projekts (Webhook-Adressen
  des Workers). Speichern legt eine neue Version an; hat jemand anderes inzwischen gespeichert, fragt der Editor nach
  (überschreiben oder abbrechen). **Versionen** zeigt alle Stände, ältere lassen sich wiederherstellen.
- **Ausführungen** je Projekt kommen live vom Worker.
- **Profil:** Name, Passwort, Zwei-Faktor-Anmeldung (TOTP, Schlüssel für Authenticator-Apps), API-Tokens für Skripte
  (`Authorization: Bearer ffl_…`, gleiche Endpunkte wie die Oberfläche, z. B. `GET /api/projects`).
- **Verwaltung** (Admins): Übersicht über Mandanten, Worker (erreichbar, Version, nicht verteilte Workflows, Fehler), Worker prüfen
  und abgleichen, Credentials beim Worker setzen und löschen (Werte nur schreibbar), Benutzer, Pflicht-TOTP, Audit-Log.

### Docker
`docker-compose.master.yml` und `docker-compose.worker.yml` enthalten je ein Beispiel. Der Master gehört hinter einen Reverse Proxy
mit HTTPS; Worker sollten ebenfalls per HTTPS (oder über VPN) erreichbar sein.

## Credentials
`credentials.json` (oder ein Verzeichnis mit einer Datei je Credential), Schlüssel = Credential-Name wie im Workflow,
Fallback auf die ID:
```json
{
  "API Header": { "id": "abc123", "type": "httpHeaderAuth", "data": { "name": "X-Api-Key", "value": "{{ env.API_KEY }}" } },
  "Token-Server": { "type": "oAuth2Api", "data": { "grantType": "clientCredentials", "accessTokenUrl": "https://auth.example/token",
                    "clientId": "filuflow", "clientSecret": "{{ env.OAUTH_SECRET }}", "scope": "lesen", "authentication": "header" } }
}
```
- Feldnamen wie in n8n (`httpHeaderAuth`, `httpBasicAuth`, `httpQueryAuth`, `httpBearerAuth`, `httpCustomAuth`, `oAuth2Api`, `jwtAuth`).
- KI-Modelle: `openAiApi` (`apiKey`, optional `url`), `anthropicApi` (`apiKey`, optional `url`), `googlePalmApi` (`apiKey`, optional `host`).
- `{{ env.NAME }}` holt Werte aus der Umgebung; `filuflow validate` meldet fehlende Credentials und Variablen.
- Exporte von `n8n export:credentials --decrypted` funktionieren direkt.
- Verschlüsseln: `FILUFLOW_ENCRYPTION_KEY=... filuflow credentials encrypt credentials.json --out credentials.enc.json`
  (Namen und Typen bleiben lesbar, `decrypt` zum Bearbeiten, `check` zum Prüfen).

## KI-Nodes
Basic LLM Chain, Information Extractor, Text Classifier, Sentiment Analysis und AI Agent (Tools Agent v2 bis 3) mit den Modellen
OpenAI (Chat Completions), Anthropic und Gemini, den Tools Calculator, Code, HTTP Request und Workflow sowie Simple Memory.
Die Modelle werden direkt per HTTP angesprochen (kein LangChain). Sub-Nodes hängen wie in n8n über `ai_*`-Verbindungen am
Eltern-Node und erscheinen im Execution-Log mit eigenen Läufen. Abweichungen: `docs/DEVIATIONS.md`.

## Tests
```
npm test             # Unit-Tests, Orakel (Filter, Expressions, KI) und Browser-Test der Oberfläche (Chromium)
npm run test:compat  # Golden-Tests gegen Ergebnisse aus echtem n8n (CLI, Engine, Webhooks)
npm run lint
```
