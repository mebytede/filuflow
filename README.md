<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/filuflow-logo-dark.svg">
    <img src="docs/assets/filuflow-logo-light.svg" alt="filuflow" width="300">
  </picture>
</p>

<p align="center">
  <strong>Workflows bauen, ausführen und nachvollziehen. Auf eigenen Servern, für ein Team oder viele Mandanten.</strong>
</p>

<p align="center">
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#weboberfläche">Weboberfläche</a> ·
  <a href="#server-und-api">Server und API</a> ·
  <a href="#mehrere-benutzer-und-mandanten">Master und Worker</a> ·
  <a href="#konfiguration">Konfiguration</a> ·
  <a href="#dokumentation">Dokumentation</a>
</p>

![Editor mit dem letzten Lauf eines Workflows](docs/assets/editor.png)

filuflow (lat. *filum*, der Faden) ist eine schlanke Workflow-Engine mit Editor im Browser. Ein Workflow verbindet Knoten
zu einem Ablauf: ein Webhook nimmt eine Meldung an, Knoten formen die Daten um, verzweigen, rufen Dienste und KI-Modelle auf
und antworten. Jeder Lauf wird protokolliert und lässt sich Knoten für Knoten nachvollziehen.

## Was filuflow kann

| | |
|---|---|
| **Editor im Browser** | Knoten einfügen und verbinden, Parameter als Formular oder JSON, Rückgängig und Wiederholen, Testlauf mit dem aktuellen Stand |
| **Nachvollziehbare Läufe** | Status und Dauer an jedem Knoten, der durchlaufene Pfad hervorgehoben, "Letzter Lauf" mit Zeitleiste, Ausführungsprotokoll in SQLite |
| **Auslöser** | Webhooks mit Antwort-Knoten und Authentifizierung, Zeitpläne, Fehler-Workflows, Aufruf durch andere Workflows, REST-API |
| **Knoten** | Daten setzen, filtern, sortieren, zusammenfassen, verzweigen (If, Switch), zusammenführen, Schleifen, Code (JavaScript und Python), HTTP (mit Pagination, Digest-Auth, Client-Zertifikaten), HTML, XML, Datum, Krypto |
| **KI** | AI Agent mit Tools, LLM Chain, Extraktion, Klassifikation, Stimmungsanalyse; Modelle von OpenAI, Anthropic und Google Gemini |
| **Credentials** | in der Oberfläche anlegen und bearbeiten (Formulare je Typ) oder als Datei pflegen, verschlüsselt mit AES-256-GCM, Werte aus Umgebungsvariablen; geheime Werte erscheinen nie in Logs oder der Oberfläche |
| **Team und Mandanten** | Master mit Benutzern, Rechten und Projekten; Worker in der Umgebung jedes Mandanten; Anmeldung mit Passwort und TOTP oder SSO (OIDC) |
| **Kommandozeile** | Workflows prüfen und ausführen, Ausführungen ansehen, Credentials verschlüsseln, Benutzer verwalten |
| **Kompatibel mit n8n** | Exportierte n8n-Workflows laufen ohne Umbau, kopierte n8n-Knoten lassen sich in den Editor einfügen |

## Schnellstart

Voraussetzung: Node.js 22.

```bash
npm install
npm run build
FILUFLOW_API_KEY=geheim npx filuflow serve --dir ./workflows
```

Dann `http://localhost:5678/` öffnen und mit dem API-Key `geheim` anmelden. Workflows liegen als JSON-Dateien in `./workflows`;
neue Workflows lassen sich im Editor anlegen oder als Datei ablegen (der Server lädt Änderungen automatisch).

Mit Docker:

```bash
FILUFLOW_API_KEY=geheim docker compose up -d --build
```

## Weboberfläche

<p>
  <img src="docs/assets/uebersicht.png" alt="Übersicht aller Workflows" width="49%">
  <img src="docs/assets/editor-hell.png" alt="Editor im hellen Farbschema" width="49%">
</p>

- **Workflows:** Kennzahlen (aktive Workflows, Ausführungen und Fehler der letzten 14 Tage, Auslastung), Suche und Filter
  (Alle, Aktiv, Inaktiv, Ungültig) und eine Tabelle mit Auslöser, Zustand, letztem Lauf, Dauer und Läufen.
- **Editor:** Knoten über **Knoten** oben links (oder Taste N) einfügen; ein Klick hängt den neuen Knoten an den ausgewählten an.
  Ausgang auf Eingang ziehen verbindet, eine Verbindung anklicken und Entf löscht sie. Rechts stehen Parameter, Credentials,
  Einstellungen (deaktiviert, Fehlerverhalten, Wiederholen, Notizen) und nach dem Lauf das Ergebnis als Tabelle oder JSON.
- **Speichern** schreibt die Datei ins Workflow-Verzeichnis, der Schalter **Aktiv** schaltet Webhooks und Zeitpläne an.
  **Testlauf** führt den aktuellen, auch ungespeicherten Stand aus. **Bis hier ausführen** (Knopf oben im Panel) führt nur
  den gewählten Knoten und die Knoten davor aus. Bei Webhook- und Formular-Triggern wartet **Auf Test-Aufruf warten** auf
  den nächsten Aufruf der Test-URL und führt dabei den Stand im Editor aus.
- **Testdaten:** Im Tab **Ergebnis** hält **Festhalten** die Ausgabe eines Knotens fest (`pinData`), **Testdaten eingeben**
  setzt eigene Daten. Beim Testlauf liefert der Knoten dann diese Daten, statt zu laufen; am Knoten erscheint eine Nadel.
- **Variablen:** Werte für `$vars` pflegen Sie unter **Variablen**; sie wirken sofort in allen Workflows. Einträge aus
  `vars.json` bleiben in der Datei und haben Vorrang.
- **Letzter Lauf** unter dem Canvas: Status, Typ, Ausgabe und Dauer je Knoten mit Zeitleiste; ein Klick wählt den Knoten.
- **Ausführungen:** Liste mit Filter nach Workflow und Status, Detailansicht mit dem Workflow-Stand der Ausführung.
- Farbschema dunkel (Standard) oder hell unter **Einstellungen**.

<details>
<summary>Tastenkürzel im Editor</summary>

| Taste | Wirkung |
|---|---|
| Strg+S | Speichern |
| Strg+Enter | Testlauf |
| N | Knoten hinzufügen |
| Strg+Z, Strg+Umschalt+Z | Rückgängig, Wiederholen |
| Strg+C, Strg+X, Strg+V | Kopieren, Ausschneiden, Einfügen (auch Knoten aus n8n) |
| Strg+A | Alles auswählen |
| Entf | Auswahl löschen |
| D | Knoten deaktivieren oder aktivieren |
| 1 | Einpassen |
| Esc | Auswahl aufheben |
| Umschalt+Ziehen | Rahmenauswahl |
| Strg+Mausrad | Zoomen |

</details>

## Server und API

```bash
FILUFLOW_API_KEY=geheim filuflow serve --dir ./workflows --port 5678 --db ./filuflow.db
```

- Lädt alle `*.json` aus `--dir` und lädt bei Änderungen neu. Aktive Workflows registrieren Webhooks (`/webhook/<pfad>`) und
  Zeitpläne; Test-URLs (`/webhook-test/<pfad>`) gibt es für alle gültigen Workflows.
- Ungültige Workflows (zum Beispiel mit unbekannten Knoten) werden nicht aktiviert. Der Grund steht im Log, in der Übersicht und
  in `GET /api/workflows`.
- Ausführungen landen in SQLite, standardmäßig 14 Tage lang; höchstens 5 laufen gleichzeitig, weitere warten.
- **Formulare:** Der Form Trigger stellt ein Formular unter `/form/<pfad>` bereit (Test: `/form-test/<pfad>`), mit Feldern
  für Text, Zahl, E-Mail, Datum, Auswahl, Checkboxen, Radio-Buttons, Dateien, versteckte Felder und eigenes HTML. Mit dem
  Form-Knoten folgen weitere Seiten und eine Abschlussseite; der Wait-Knoten kann ebenfalls auf ein Formular warten. Die Seiten
  sind normale HTML-Formulare ohne Skript.
- **Warten:** Der Wait-Knoten hält eine Ausführung an, bis eine Zeit erreicht ist oder ein Webhook kommt
  (`$execution.resumeUrl`, also `/webhook-waiting/<ausführung>`, optional mit Suffix und Authentifizierung). Wartende
  Ausführungen liegen in der Datenbank und überstehen einen Neustart; in der Liste steht, worauf sie warten, und sie lassen
  sich abbrechen. Statische Daten (`$getWorkflowStaticData`) und OAuth2-Tokens bleiben ebenfalls über Neustarts erhalten.

<details>
<summary>REST-API (Header <code>X-API-Key</code>)</summary>

| Methode und Pfad | Zweck |
|---|---|
| `GET /api/workflows` | alle Workflows mit Zustand, Auslösern und Gültigkeit |
| `GET /api/workflows/:id` | ein Workflow mit Prüfergebnis |
| `POST /api/workflows/:id/run` | ausführen; Body = Start-Items, `?wait=false` für asynchron |
| `GET /api/executions?workflow=&status=&limit=` | Ausführungen |
| `GET /api/executions/:id` | eine Ausführung mit Daten je Knoten |
| `POST /api/executions/:id/cancel` | laufende oder wartende Ausführung abbrechen |
| `ANY /webhook-waiting/:id[/suffix]` | wartende Ausführung fortsetzen (Wait "On Webhook Call") |
| `GET /api/overview` | Kennzahlen der letzten 14 Tage, letzte Ausführung je Workflow |
| `GET /healthz` | Lebenszeichen (ohne API-Key) |

</details>

<details>
<summary>Beispiel mit curl</summary>

```bash
mkdir -p /tmp/fl/workflows && cp fixtures/08-webhook-respond/workflow.json /tmp/fl/workflows/
cd /tmp/fl && FILUFLOW_API_KEY=geheim filuflow serve --port 5690 --dir workflows &

curl -i -X POST 'http://localhost:5690/webhook/fl-fixture-08?n=3' -H 'content-type: application/json' -d '{"name":"Ada"}'
# HTTP/1.1 201 Created
# {"gruss":"Hallo Ada","anzahl":6,"tags":null}

curl -s -H 'X-API-Key: geheim' 'http://localhost:5690/api/executions?limit=5'
filuflow executions list --db /tmp/fl/filuflow.db
```

</details>

### Kommandozeile

```bash
filuflow validate <workflow.json> [--json]
filuflow run <workflow.json> [--input items.json] [--trigger "Knoten"] [--json] [--only-last] [--no-pin]
filuflow executions list|show <id> [--json] [--db ./filuflow.db]
filuflow credentials encrypt|decrypt|check <credentials.json>
filuflow nodes [--json]
```

`filuflow run` prüft den Workflow vorab (unbekannte Knoten oder Versionen brechen ab, bevor etwas läuft) und zeigt danach eine
Übersicht je Knoten:

```text
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

<details>
<summary>Optionen von <code>run</code></summary>

- `--input`: Start-Items, als Array aus `{ "json": ... }` oder einfachen Objekten
- `--trigger`: Start-Knoten, wenn der Workflow mehrere Auslöser hat
- `--json`: vollständige Ausführung inklusive Daten je Knoten (Credential-Werte maskiert)
- `--only-last`: nur die Ausgabe des zuletzt ausgeführten Knotens
- `--no-pin`: fest hinterlegte Testdaten (`pinData`) ignorieren
- `--credentials`, `--vars`, `--workflows`: Credentials, Variablen (`$vars`) und Verzeichnis für Unter-Workflows

Exit-Code 0 bei Erfolg, 1 bei Fehlern (Prüfung oder fehlgeschlagene Ausführung).

</details>

## Credentials

Am einfachsten legen Sie Credentials in der Oberfläche an: Seite **Credentials** oder direkt im Editor über die Auswahl am Knoten
("Neues Credential anlegen"). Das Formular kennt die Felder der eingebauten Typen und blendet je nach Auswahl die passenden ein;
für andere Typen geben Sie die Felder frei an. Geheime Felder (Passwörter, Tokens, API-Keys) werden nach dem Speichern nie wieder
angezeigt: Ein leeres Feld beim Bearbeiten behält den gespeicherten Wert. Die Oberfläche zeigt außerdem, welche Workflows ein
Credential verwenden.

**OAuth2 mit Anmeldung beim Anbieter** (Grant Type "Authorization Code" oder "PKCE", z. B. Google, Microsoft 365, Slack):
tragen Sie beim Anbieter die Redirect-URL `<FILUFLOW_WEBHOOK_URL>rest/oauth2-credential/callback` ein (dieselbe wie bei
n8n, das Formular zeigt sie an), legen Sie das Credential an und klicken Sie in der Liste auf **Verbinden**. Das Token liegt
verschlüsselt in der Datenbank und wird bei abgelaufenem Zugriff mit dem Refresh-Token erneuert. Im Master läuft die
Anmeldung über die Adresse des Masters, das Token liegt beim Worker.

In der Oberfläche angelegte Credentials landen in `credentials.managed.json` (Dateirechte 0600, mit `FILUFLOW_ENCRYPTION_KEY`
verschlüsselt; Pfad über `FILUFLOW_MANAGED_CREDENTIALS`). Ohne Schlüssel weist die Oberfläche darauf hin.

Alternativ oder zusätzlich stehen Credentials in `credentials.json` (oder in einem Verzeichnis mit einer Datei je Credential).
Diese Einträge sind in der Oberfläche sichtbar, aber nur in der Datei änderbar, und haben Vorrang. Der Schlüssel ist der Name,
unter dem ein Workflow das Credential verwendet:

```json
{
  "API Header": { "id": "abc123", "type": "httpHeaderAuth", "data": { "name": "X-Api-Key", "value": "{{ env.API_KEY }}" } },
  "Token-Server": { "type": "oAuth2Api", "data": { "grantType": "clientCredentials", "accessTokenUrl": "https://auth.example/token",
                    "clientId": "filuflow", "clientSecret": "{{ env.OAUTH_SECRET }}", "scope": "lesen", "authentication": "header" } }
}
```

- Typen: `httpHeaderAuth`, `httpBasicAuth`, `httpDigestAuth`, `httpQueryAuth`, `httpBearerAuth`, `httpCustomAuth`, `oAuth2Api`,
  `jwtAuth`, `httpSslAuth` (Client-Zertifikat und eigene CA für "SSL Certificates"),
  für KI-Modelle `openAiApi`, `anthropicApi` und `googlePalmApi` (jeweils `apiKey`, optional eigene URL).
- `{{ env.NAME }}` holt Werte aus der Umgebung; `filuflow validate` meldet fehlende Credentials und Variablen.
- Verschlüsseln: `FILUFLOW_ENCRYPTION_KEY=... filuflow credentials encrypt credentials.json --out credentials.enc.json`.
  Namen und Typen bleiben lesbar, `decrypt` zum Bearbeiten, `check` zum Prüfen.
- Geheime Werte verlassen den Server nicht und erscheinen maskiert im Protokoll; die REST-API dazu steht unter `/api/credentials`.

## Code in JavaScript und Python

Der Code-Knoten kennt drei Sprachen (Auswahl **Sprache** im Editor):

- **JavaScript**: alle Variablen der Expressions (`$input`, `$json`, `$('Knoten')`, `$now` …), `console.log` landet im
  Protokoll der Ausführung.
- **Python**: läuft mit [Pyodide](https://pyodide.org) (CPython als WebAssembly) direkt im Server, ohne installiertes Python.
  Die Variablen heißen wie in n8n mit `_` statt `$`: `_input.all()`, `_json`, `_('Knoten')`, `_now`, `_jmespath()`.
  Objekte lassen sich als Attribut oder Schlüssel lesen (`item.json.name`, `item.json['name']`), `print()` landet im Protokoll.
  Die Standardbibliothek ist dabei; Pakete wie numpy oder pandas lädt Pyodide beim ersten `import` aus dem Netz nach
  (`FILUFLOW_PYTHON_PACKAGES_DIR`). Der erste Lauf nach dem Start dauert etwa zwei Sekunden, nutzt ein Workflow Python,
  lädt der Server Pyodide schon beim Start.
- **Python (Native)**: nutzt den Python-Interpreter des Servers (`FILUFLOW_PYTHON`, Default `python3`) in einem eigenen
  Prozess je Ausführung, mit allen dort installierten Paketen. Wie im Task-Runner von n8n gibt es nur `_items` (alle Items) bzw.
  `_item` (je Item) als dicts. Imports sind nur mit Freigabe erlaubt: `FILUFLOW_PYTHON_STDLIB_ALLOW=json,datetime,re` und
  `FILUFLOW_PYTHON_EXTERNAL_ALLOW=numpy` (`*` für alle; die n8n-Namen `N8N_RUNNERS_STDLIB_ALLOW` usw. gelten auch).
  Builtins wie `eval`, `open` oder `getattr` sind gesperrt (`FILUFLOW_PYTHON_BUILTINS_DENY`), die Umgebung ist leer
  (`FILUFLOW_PYTHON_ENV_ACCESS=true` gibt sie frei).

```python
# Python: alle Items durchlaufen
for item in _input.all():
    item.json.summe = item.json.netto * 1.19
return _input.all()
```

Alle Varianten haben ein Zeitlimit (`FILUFLOW_CODE_TIMEOUT_MS`, Default 60 s), das auch Endlosschleifen beendet. Das Code-Tool
für KI-Agenten kann ebenfalls Python. `FILUFLOW_PYTHON_ENABLED=false` schaltet Python ab.

## KI-Knoten

AI Agent (Tools Agent), Basic LLM Chain, Information Extractor, Text Classifier und Sentiment Analysis, mit den Modellen von
OpenAI (Chat Completions), Anthropic und Google Gemini, den Tools Calculator, Code, HTTP Request und Workflow sowie einem
einfachen Gesprächsgedächtnis. Modelle und Tools hängen als eigene Knoten am Agenten und erscheinen im Protokoll mit eigenen
Läufen. Die Modelle werden direkt per HTTP angesprochen, ohne zusätzliche Bibliotheken.

**Chat:** Der Chat Trigger startet einen Workflow mit einer Chat-Nachricht. Im Editor öffnet der Chat-Knopf in der
Kopfzeile ein Chat-Fenster, jede Nachricht ist ein Testlauf mit dem aktuellen Stand. Ist der Chat öffentlich, gibt es unter
`/webhook/<webhookId>/chat` eine eigene Chat-Seite (Titel, Begrüßung, Platzhalter einstellbar, optional Basic Auth) oder nur
den Endpunkt zum Einbetten. Die Antwort ist das erste Item des letzten Knotens (`output` bzw. `text`) oder kommt von einem
Respond-to-Webhook-Knoten.

## Mehrere Benutzer und Mandanten

Für Teams und für den Betrieb bei mehreren Kunden gibt es zwei weitere Betriebsarten. Der Einzelbetrieb mit `filuflow serve`
bleibt davon unberührt.

```text
          Team (Browser)
               │  Anmeldung: Passwort + TOTP oder SSO (OIDC)
        ┌──────▼───────┐
        │   Master     │  Benutzer, Rechte, Projekte, Workflows (versioniert), Audit-Log
        └──┬────────┬──┘
   HTTPS + │        │ HTTPS + Token des Workers
   Token   │        │
   ┌───────▼──┐  ┌──▼───────┐
   │ Worker   │  │ Worker   │  in der Umgebung des Mandanten: führt aus, Webhooks, Zeitpläne;
   │ Kunde A  │  │ Kunde B  │  Credentials und Ausführungsdaten bleiben hier
   └──────────┘  └──────────┘
```

- **Master** (`filuflow master`): Oberfläche mit Anmeldung, Projekten, Editor und Verwaltung. Führt selbst nichts aus.
- **Worker** (`filuflow worker`): ein Server mit API für den Master. Der Master verbindet sich zum Worker (nicht umgekehrt) und
  verteilt Workflows beim Speichern. Fällt der Master aus, laufen die Worker weiter.
- **Mandant:** eine Gruppe von Workern, zum Beispiel Test und Produktion eines Kunden. **Projekt:** ein Ordner für Workflows mit
  Mitgliedern, genau einem Worker zugeordnet.
- **Rollen:** global Administrator oder Mitglied. Im Projekt: Lesen, Bearbeiten (ändern, ausführen, aktivieren, löschen) oder
  Projekt-Admin (zusätzlich Mitglieder).
- Workflows sind im Master versioniert. Speichern zwei Personen gleichzeitig, fragt der Editor nach; ältere Versionen lassen sich
  wiederherstellen.

### Worker starten (beim Mandanten)

```bash
FILUFLOW_API_KEY=<langer-zufallswert> FILUFLOW_ENCRYPTION_KEY=<schluessel> \
FILUFLOW_WEBHOOK_URL=https://flows.kunde.example/ filuflow worker --dir ./workflows --port 5678
```

- `FILUFLOW_API_KEY` (mindestens 16 Zeichen) ist der Token, den der Master beim Worker einträgt.
- Workflows vom Master landen als `<id>.json` in `--dir`; von Hand abgelegte Workflows bleiben unberührt.
- Credentials: die von Hand gepflegte `credentials.json` (nur lesen, hat Vorrang) plus `credentials.managed.json`, die
  Administratoren im Master mit demselben Formular pflegen; geheime Werte kann der Master nie wieder lesen.
- Die eigene Oberfläche ist im Worker aus (`FILUFLOW_UI=true` schaltet sie ein).

### Master starten

```bash
FILUFLOW_ENCRYPTION_KEY=<schluessel> FILUFLOW_PUBLIC_URL=https://filuflow.example filuflow master --port 5679 --db ./master.db
```

Beim ersten Start schreibt der Master ein Einrichtungs-Token ins Log; damit legt man unter `/#/setup` den ersten Administrator an.
Danach unter **Verwaltung** einen Mandanten anlegen, den Worker mit Adresse und Token eintragen, ein Projekt anlegen und dem
Worker zuordnen, Mitglieder hinzufügen.

<details>
<summary>Umgebungsvariablen des Masters</summary>

| Variable | Bedeutung |
|---|---|
| `FILUFLOW_ENCRYPTION_KEY` | Pflicht, mindestens 16 Zeichen. Verschlüsselt Worker-Tokens und TOTP-Schlüssel. Gut aufbewahren: ohne ihn sind Worker und TOTP neu einzurichten |
| `FILUFLOW_PUBLIC_URL` | Adresse des Masters (bei `https://` Cookies mit Secure) und Ziel der SSO-Rückleitung |
| `FILUFLOW_MASTER_DB` / `--db` | SQLite-Datei (Default `./master.db`) |
| `FILUFLOW_PORT` / `--port` | Port (Default 5679) |
| `FILUFLOW_ADMIN_EMAIL`, `FILUFLOW_ADMIN_PASSWORD` | erster Admin beim ersten Start statt Einrichtungs-Token |
| `FILUFLOW_SESSION_HOURS` | Sitzung endet nach so vielen Stunden ohne Aktivität (Default 12, spätestens nach 7 Tagen) |
| `FILUFLOW_SYNC_SECONDS` | Abgleich mit den Workern (Default 60, 0 = aus) |
| `FILUFLOW_TRUST_PROXY` | `true` hinter einem Reverse Proxy (IP aus `X-Forwarded-For` für die Begrenzung der Anmeldeversuche) |

</details>

<details>
<summary>Anmeldung über SSO (OpenID Connect)</summary>

Der Master meldet Benutzer zusätzlich über einen Identity Provider an (Keycloak, Entra ID, Google, Authentik, Zitadel und andere;
Authorization Code Flow mit PKCE). Beim Identity Provider einen Client mit der Rückleitungs-URL
`<FILUFLOW_PUBLIC_URL>/api/auth/oidc/callback` anlegen, dann:

| Variable | Bedeutung |
|---|---|
| `FILUFLOW_OIDC_ISSUER` | Aussteller-URL (Discovery unter `/.well-known/openid-configuration`) |
| `FILUFLOW_OIDC_CLIENT_ID`, `FILUFLOW_OIDC_CLIENT_SECRET` | Client; ohne Secret als öffentlicher Client mit PKCE |
| `FILUFLOW_OIDC_LABEL` | Text des Anmeldeknopfs (Default "Mit SSO anmelden") |
| `FILUFLOW_OIDC_SCOPES` | Default `openid email profile` (für Gruppen ggf. `groups` ergänzen) |
| `FILUFLOW_OIDC_AUTO_CREATE=true` | unbekannte Benutzer beim ersten Login als Mitglied anlegen |
| `FILUFLOW_OIDC_ALLOWED_DOMAINS` | nur diese E-Mail-Domains, kommagetrennt |
| `FILUFLOW_OIDC_ADMIN_GROUP`, `FILUFLOW_OIDC_GROUPS_CLAIM` | Mitglieder dieser Gruppe werden Admin, alle anderen Mitglied; der letzte Admin bleibt Admin |

Zuordnung zuerst über die Identität beim Identity Provider, sonst über die E-Mail-Adresse eines vorhandenen Benutzers. Bei SSO
fragt filuflow kein TOTP ab; die zweite Stufe liegt beim Identity Provider.

</details>

<details>
<summary>Benutzer auf der Kommandozeile (Notfall-Zugang)</summary>

```bash
FILUFLOW_NEW_PASSWORD=... filuflow master user add --email ada@example.org --name "Ada" --admin --db ./master.db
filuflow master user list --db ./master.db
filuflow master user set-password --email ada@example.org --db ./master.db     # fragt nach dem Passwort
filuflow master user reset-totp --email ada@example.org --db ./master.db
```

</details>

Im Profil verwaltet jede Person Passwort, Zwei-Faktor-Anmeldung und API-Tokens für Skripte (`Authorization: Bearer ffl_…`).
Administratoren sehen unter **Verwaltung** alle Mandanten und Worker (erreichbar, Version, nicht verteilte Workflows, Fehler),
setzen Credentials beim Worker, verwalten Benutzer und lesen das Audit-Log.

## Konfiguration

| Variable | Bedeutung | Default |
|---|---|---|
| `FILUFLOW_API_KEY` | Schlüssel für REST-API und Oberfläche; ohne ihn ist die API gesperrt | |
| `FILUFLOW_DIR` / `--dir` | Workflow-Verzeichnis | `./workflows` |
| `FILUFLOW_DB` / `--db` | SQLite-Datei für Ausführungen | `./filuflow.db` |
| `FILUFLOW_PORT`, `FILUFLOW_HOST` | Adresse des Servers | `5678`, `0.0.0.0` |
| `FILUFLOW_WEBHOOK_URL` | öffentliche Basis-URL für Webhooks | `http://localhost:5678/` |
| `FILUFLOW_CREDENTIALS`, `FILUFLOW_VARS` | Credentials und Variablen | `./credentials.json`, `./vars.json` |
| `FILUFLOW_ENCRYPTION_KEY` | Schlüssel für verschlüsselte Credentials | |
| `FILUFLOW_MANAGED_CREDENTIALS` | Datei für Credentials aus der Oberfläche oder vom Master | `./credentials.managed.json` |
| `FILUFLOW_CONCURRENCY` | gleichzeitige Ausführungen | `5` |
| `FILUFLOW_PRUNE_DAYS` | Aufbewahrung der Ausführungen in Tagen | `14` |
| `FILUFLOW_TIMEZONE` | Zeitzone für Zeitpläne und Datumswerte | `Europe/Berlin` |
| `FILUFLOW_CODE_TIMEOUT_MS` | Zeitlimit für Code-Knoten | `60000` |
| `FILUFLOW_PYTHON`, `FILUFLOW_PYTHON_STDLIB_ALLOW`, `FILUFLOW_PYTHON_EXTERNAL_ALLOW` | Python (Native): Interpreter und erlaubte Imports | `python3`, keine, keine |
| `FILUFLOW_PYTHON_PACKAGES_DIR` | Ablage für nachgeladene Python-Pakete (Pyodide) | `~/.cache/filuflow/pyodide` |
| `FILUFLOW_ENV_ALLOW` | welche Umgebungsvariablen `$env` liefert | Präfix `FL_` |
| `FILUFLOW_PAYLOAD_SIZE_MAX` | maximale Request-Größe in MB | `16` |
| `FILUFLOW_UI` | `false` schaltet die Oberfläche ab | an |
| `FILUFLOW_INSTANCE_NAME` | Name im Fuß der Seitenleiste | Hostname |
| `FILUFLOW_IMPRINT_URL`, `FILUFLOW_PRIVACY_URL` | Links "Impressum" und "Datenschutz" (nur wenn gesetzt) | |
| `FILUFLOW_LOG_LEVEL` | Log-Level (pino) | `info` |

### Docker

`docker-compose.yml` startet einen Einzelserver, `docker-compose.master.yml` und `docker-compose.worker.yml` zeigen Master und
Worker. Das Image basiert auf `node:22-slim` und läuft als Benutzer `node` mit dem Arbeitsverzeichnis `/data` (Workflows unter
`/data/workflows`, optional `/data/credentials.json` und `/data/vars.json`).

```bash
docker build -t filuflow .                                   # mit Python (Native): --build-arg WITH_PYTHON=true
docker run -p 5678:5678 -e FILUFLOW_API_KEY=geheim -v "$PWD/data:/data" filuflow
```

Für den Betrieb im Netz gehört ein Reverse Proxy mit HTTPS davor. Worker sollten per HTTPS oder über ein VPN erreichbar sein.

## Zusammenarbeit mit n8n

filuflow liest das Workflow-Format von n8n. Exportierte Workflows (JSON, `executionOrder: v1`) laufen ohne Umbau und liefern
dieselben Daten an denselben Knoten wie n8n 1.x; das prüfen Vergleichstests gegen echtes n8n (Referenz 1.123.0). Credentials aus
`n8n export:credentials --decrypted` lassen sich direkt verwenden, kopierte n8n-Knoten im Editor einfügen.

## Entwicklung

```bash
npm test             # Unit-Tests, Vergleichstabellen und Browser-Tests der Oberfläche (Chromium)
npm run test:compat  # Vergleich mit aufgezeichneten Ergebnissen aus n8n (CLI, Engine, Webhooks)
npm run lint         # eslint und TypeScript
npm run build        # CLI, Server und Oberfläche nach dist/
```

TypeScript (strict, ESM) auf Node.js 22, fastify, SQLite (better-sqlite3), luxon und croner. Die Oberfläche kommt ohne Framework
aus und wird mit `tsc` gebaut.

## Dokumentation

- [docs/STATUS.md](docs/STATUS.md): Stand der Entwicklung
- [docs/SECURITY.md](docs/SECURITY.md): Sicherheitsmodell, Anmeldung, Credentials
- [docs/DECISIONS.md](docs/DECISIONS.md): Entscheidungen und Abhängigkeiten
- [docs/SPEC.md](docs/SPEC.md): Spezifikation und Ausbau

> **Früher flowlite.** filuflow hieß bis Oktober 2026 flowlite. Alte Umgebungsvariablen (`FLOWLITE_*`) gelten weiter, solange die
> neue nicht gesetzt ist; beim Start erscheint ein Hinweis. Die Standard-Datenbank heißt jetzt `filuflow.db` (eine vorhandene
> `flowlite.db` umbenennen oder mit `--db` angeben). API-Tokens mit `flt_` bleiben gültig.
