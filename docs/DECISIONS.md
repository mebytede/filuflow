# Entscheidungen

## Referenzversion n8n 1.123.0
Die Spezifikation verlangt Kompatibilität zu "aktueller 1.x". Gepinnt ist `n8nio/n8n:1.123.0`
(Docker Hub; `docker.n8n.io` ist aus der Build-Umgebung nicht erreichbar, das Image ist identisch).
Quellcode-Fundstellen in Kommentaren beziehen sich auf den Tag `n8n@1.123.0`.

## Name filuflow
Das Projekt hieß zuerst flowlite und heißt seit Oktober 2026 filuflow (lat. *filum*, der Faden). Umbenannt sind Paket, CLI
(`filuflow`), Umgebungsvariablen (`FILUFLOW_*`), Cookies, Header, Standard-Dateinamen und Doku. Übergang ohne Bruch:
`FLOWLITE_*` wird beim Start der CLI übernommen, wenn die neue Variable fehlt (`src/cli/legacyEnv.ts`, mit Hinweis), API-Tokens
`flt_…`, die Kennzeichnung `flowliteMaster` in verteilten Workflows und Binärverweise `flowlite-fs:` werden weiter gelesen.
Die Golden-Fixtures behalten ihre Testdaten (z. B. User-Agent `flowlite-fixture`), weil sie gegen echtes n8n aufgenommen sind.

## Laufzeit-Abhängigkeiten
Neben dem Stack aus CLAUDE.md (luxon, better-sqlite3, fastify, croner, pino):

| Paket | Grund |
|---|---|
| `undici` | HTTP-Client laut SPEC 4.2 (Proxy über `EnvHttpProxyAgent`, `MockAgent` für Tests) |
| `jmespath` | `$jmespath()` laut SPEC 3.2 |
| `acorn`, `astring` | AST-Umschreibung der Expressions für Erweiterungsfunktionen (SPEC 3.3). Leichter als recast/esprima, gleiche Fähigkeit |
| `cheerio` | HTML-Node (`extractHtmlContent`) laut SPEC 4.2 |
| `xml2js` | XML-Node; n8n nutzt dieselbe Bibliothek, daher identische Ausgabeform |
| `lodash` | n8n nutzt `get`/`set`/`unset`/`isEqual` u. a. für Pfade wie `a.b[0]`; gleiche Bibliothek = gleiche Semantik (z. B. Schlüssel mit Punkt) |
| `jsonrepair` | n8n repariert JSON im Set-Node (`repairJSON`) mit dieser Bibliothek |
| `qs` | HTTP Request: n8n serialisiert Formular- und Query-Daten mit `qs`; gleiche Bibliothek = gleiche Kodierung |
| `pyodide` (0.28.0) | Python im Code-Node (M12): dieselbe Version wie n8n 1.123.0, damit sich Python-Code gleich verhält (Python 3.13, Umwandlung von dicts und JS-Objekten). Läuft ohne installiertes Python; etwa 12 MB, nur geladen, wenn Python genutzt wird. Abhängigkeit `ws` (für den Browser-Teil, ungenutzt). Alternative wäre ein eigener Interpreter-Prozess für alle Fälle gewesen, dann bräuchte jeder Server Python |
| `math-expression-evaluator` | Calculator-Tool (M7): n8n nutzt den LangChain-Calculator, der genau diese Bibliothek (2.0.7) aufruft. Eigene Syntax (Winkel in Grad, `root`, `Mod`, `C(n,k)` usw.); ein Nachbau würde zwangsläufig abweichen. MIT-Lizenz, ohne Abhängigkeiten |

## Weboberfläche (M8)
- TypeScript ohne Framework und ohne Bundler: `tsc -p tsconfig.ui.json` erzeugt ES-Module für den Browser, `scripts/copy-ui-assets.mjs`
  kopiert HTML, CSS und Icon nach `dist/ui`. Keine neue Laufzeit-Abhängigkeit, keine Build-Kette neben tsc; für ein internes Werkzeug
  mit überschaubarem Umfang reichen DOM und SVG.
- Der Server liefert `dist/ui` selbst aus (kein `@fastify/static`), mit Content-Security-Policy ohne Inline-Skripte.
- Parameter: filuflow kennt die Parameterbeschreibungen der n8n-Nodes nicht. Statt sie nachzubauen, bearbeitet der Editor den
  Parameterbaum direkt (Text, Zahl, Ja/Nein, Objekt, Liste, Expression) oder als JSON. Neue Nodes bekommen Startwerte aus
  `src/ui/editor/templates.ts`.
- Speichern schreibt die Workflow-Datei im Workflow-Verzeichnis (n8n-Format, 2 Leerzeichen eingerückt); Hot Reload und Aktivierung
  laufen wie bei Änderungen von Hand. Neue Workflows bekommen eine zufällige ID und einen Dateinamen aus dem Workflow-Namen.
- `playwright-core` (Dev-Abhängigkeit, Version passend zum vorinstallierten Chromium) für den Browser-Test `test/ui.e2e.test.ts`;
  ohne Chromium wird der Test übersprungen.

## Design filuflow
- Umgesetzt nach dem Design-Handoff (Logo "Strang", Tokens `--ff-*` dunkel und hell, IBM Plex Sans und Mono, Lucide-Icons,
  Editor mit Kopfzeile, Icon-Leiste und Bereich "Letzter Lauf", Workflow-Übersicht mit Kennzahlen). Die Gestaltungsregeln
  (Radius 0, keine Schatten und Verläufe, Status immer als Wort, Sie-Anrede) gelten für die ganze Oberfläche, auch für Master und
  Verwaltung, die das Handoff nicht entwirft.
- Das Handoff empfiehlt Vite, React und React Flow. Die Oberfläche bleibt bei TypeScript ohne Framework (siehe M8): Der Editor mit
  Canvas, Verbinden, Rückgängig und Parameterformular existiert und ist getestet; ein Umbau brächte drei Laufzeit-Abhängigkeiten
  und eine zweite Build-Kette ohne Gewinn für die Funktion. Die Knoten- und Kantendarstellung aus dem Handoff (176 x 104,
  Kopfleiste in der Kategoriefarbe, orthogonale Kanten mit 8 px Radius, quadratische Ports) ist im eigenen SVG-Canvas nachgebaut.
- Schriften (IBM Plex, SIL Open Font License 1.1) liegen als woff2 in `src/ui/static/fonts`, Icons (Lucide 0.545.0, ISC-Lizenz) als
  Pfaddaten in `src/ui/icons.ts`. Keine Laufzeit-Abhängigkeit, keine externen Quellen (CSP bleibt `default-src 'self'`).
- Dialoge haben keine abdunkelnde Fläche (Regel: keine Transparenz-Overlays); sie heben sich über Rahmen und die 2-px-Verlaufslinie ab.
- Für die Übersicht liefert der Server `GET /api/overview` (Kennzahlen aus SQLite, Auslastung der Warteschlange, Quelle und Zeitpunkt
  des letzten Ladens) und in `GET /api/workflows` je Workflow Auslöser und Gültigkeit. Der Master reicht die Kennzahlen eines Projekts
  vom Worker durch (`GET /api/projects/:pid/overview`, nur Workflows des Projekts).

## Master und Worker (M9)
- **Master verbindet sich zum Worker** (nicht umgekehrt): Der Worker ist ein normales `filuflow serve` mit zusätzlicher Worker-API,
  geschützt mit seinem `FILUFLOW_API_KEY`. Der Master braucht Netzzugang zum Worker (direkt, VPN oder Reverse Proxy mit TLS);
  der Worker braucht keinen Zugang zum Master und läuft weiter, wenn der Master ausfällt.
- **Daten beim Worker:** Credentials und Ausführungsdaten verlassen die Umgebung des Mandanten nicht dauerhaft. Der Master hält
  Benutzer, Rechte, Projekte und Workflows (mit Versionen) und fragt Ausführungen live ab. Credentials kann der Master beim Worker
  setzen und löschen, aber nicht lesen (Datei `credentials.managed.json` neben der von Hand gepflegten Credential-Datei).
- **Verteilen:** Speichern im Master schreibt den Workflow sofort als `<id>.json` ins Workflow-Verzeichnis des Workers, gekennzeichnet
  mit `meta.filuflowMaster` (Version, Projekt). Ein Abgleich (`FILUFLOW_SYNC_SECONDS`, Default 60) holt verpasste Änderungen nach und
  entfernt gekennzeichnete Workflows, die der Master nicht mehr kennt. Dateien ohne Kennzeichnung bleiben unberührt, so können Worker
  zusätzlich lokale Workflows haben.
- **Ein Projekt, ein Worker:** Ein Projekt ist genau einem Worker (und damit einem Mandanten) zugeordnet. Mehrere Worker je Mandant
  sind möglich (z. B. Test und Produktion), dann als getrennte Projekte.
- **Keine neuen Abhängigkeiten:** Passwörter mit scrypt aus `node:crypto`, TOTP (RFC 6238) und OIDC (Code Flow mit PKCE, JWKS,
  Signaturprüfung RS/PS/ES) sind selbst implementiert. Die Bausteine sind klein und gut spezifiziert; eine OIDC- oder JWT-Bibliothek
  hätte mehr Code und Abhängigkeiten gebracht als sie spart. HTTP zum Worker und zum Identity Provider über `undici` (schon vorhanden).
- **Sitzungen** liegen in der SQLite-Datenbank des Masters (gehasht), nicht als JWT: Abmelden, Sperren und Passwortwechsel wirken sofort.
- **Oberfläche:** dieselbe SPA wie im Einzelbetrieb; sie erkennt den Master über `GET /healthz` (`mode: "master"`) und lädt dann
  `master/app.js`. Editor und Ausführungsansicht sind über eine kleine Backend-Schnittstelle an Master oder Einzelserver angebunden.

## Credentials in der Oberfläche (M11)
- **Zwei Quellen:** `credentials.json` bleibt die von Hand gepflegte Quelle (nur lesen, hat Vorrang); was in der Oberfläche oder
  vom Master angelegt wird, landet in `credentials.managed.json`. So bleiben bestehende Installationen unverändert, und Einträge,
  die jemand bewusst in einer Datei (oder per Konfigurationsmanagement) pflegt, kann niemand über die API überschreiben.
- **Geheimnisse nur schreiben:** Die API gibt öffentliche Felder zurück, damit das Formular sie zeigen kann, geheime Felder nie.
  Beim Bearbeiten schickt die Oberfläche geänderte Werte und in `keep` die geheimen Felder, die bleiben sollen. Ein Platzhalter
  wie `********` als Wert wäre fehleranfällig (er könnte als echter Wert gespeichert werden).
- **Typen deklarativ:** Die Felder der eingebauten Typen stehen als Daten in `src/credentials/types.ts` (nach den n8n-Definitionen,
  aber eigene Beschreibung) und kommen über `GET /api/credential-types` in die Oberfläche. Dieselbe Beschreibung entscheidet, welche
  Felder geheim sind; für andere Typen gilt weiter die Namensheuristik. Andere n8n-Typen lassen sich mit freien Feldern anlegen.
- **IDs wie n8n:** Neue Credentials bekommen eine ID aus 16 Zeichen. Workflows referenzieren `{ id, name }`; gesucht wird nach Name,
  dann nach ID. Umbenennen behält die ID, damit Workflows mit gespeicherter ID das Credential weiter finden.
- Keine neue Abhängigkeit.

## Formulare (M17)
- **HTML-Formulare ohne Skript:** n8n rendert eine Vorlage mit JavaScript, schickt per fetch und leitet mit 307 weiter.
  filuflow liefert normale Formulare (multipart/form-data), Weiterleitungen als 303, und zeigt beim Speichern des
  Wartezustands kurz eine Seite mit Neuladen. Feldnamen (`field-0` …) und die Ausgabe der Knoten sind wie in n8n.
- **Abschlussseite:** n8n setzt die Ausführung fort, wenn die Abschlussseite per Skript zurückmeldet; filuflow setzt sie beim
  Anzeigen der Seite fort.
- **HTML-Bereinigung** als kleiner eigener Filter mit der Freigabeliste von n8n (statt sanitize-html).
- Pflicht-Checkboxen und Auswahlgrenzen prüft der Server (n8n prüft im Browser).

## Chat Trigger (M16)
- **Eigene Chat-Seite statt @n8n/chat:** n8n lädt das Chat-Widget aus einem CDN. filuflow liefert eine kleine eigene Seite
  (`src/ui/chat/`, gebaut nach `dist/ui/chat/`), ohne fremde Quellen und mit strenger CSP. Das Protokoll ist dasselbe
  (`action`, `sessionId`, `chatInput`; Antwort `output` oder `text`), eingebettete n8n-Widgets funktionieren also weiter.
- **Chat im Editor** ist ein Testlauf ab dem Chat Trigger mit der Nachricht als Eingabe, wie der Chat im n8n-Editor.
- Streaming und "n8n User Auth" fehlen noch (Prüfung meldet sie).

## HTTP Request erweitert (M15)
- **Pagination:** gleiche Optionen und Abbruchregeln wie n8n; die Werte je Seite werden vor dem Serialisieren in Query,
  Header und Body gemischt (lodash merge wie `applyPaginationRequestData`). Jede Seite durchläuft dieselbe Auswertung der
  Antwort wie ein einzelner Request.
- **Digest-Auth** selbst umgesetzt (RFC 7616, rund 40 Zeilen): n8n nutzt dafür die alte Bibliothek "request".
- **Client-Zertifikate** über eigene undici-Agents je Zertifikat (zwischengespeichert nach Hash); eine angegebene CA
  ersetzt wie in Node die Standard-CAs.

## OAuth2 mit Authorization Code (M14)
- **Tokens in der Datenbank, nicht im Credential:** n8n schreibt `oauthTokenData` ins Credential. filuflow legt die Tokens
  (verschlüsselt) in die Schlüssel-Wert-Tabelle, Schlüssel ist die ID des Credentials. So lassen sich auch Credentials aus der
  von Hand gepflegten Datei verbinden, und Bearbeiten im Formular überschreibt keine Tokens. `oauthTokenData` aus einem
  n8n-Export wird weiter gelesen.
- **Redirect-URI wie n8n** (`/rest/oauth2-credential/callback`), damit bestehende App-Registrierungen weiter passen.
- **Master:** Der Worker baut die Autorisierungs-URL mit der Redirect-URI des Masters und merkt sich `state` und
  `code_verifier`; der Master merkt sich nur, zu welchem Worker der `state` gehört, und reicht den Callback weiter.
- **Kein Skript auf der Callback-Seite** (strenge CSP); die Oberfläche merkt am geschlossenen Fenster, dass sie neu laden soll.

## Wartende Ausführungen (M13)
- **Wie n8n:** Der Wait-Knoten ruft `putExecutionToWait`, die Engine legt ihn zurück auf den Stack und beendet den Lauf mit
  Status "waiting". Beim Fortsetzen wird er deaktiviert (gibt seine Eingangsdaten bzw. die Daten des Webhooks weiter) und sein
  letzter Lauf entfernt. Unter 65 s wartet der Prozess selbst; der Wait-Tracker holt alle 60 s die in den nächsten 70 s fälligen.
- **Zustand:** Stack, wartende Eingänge, Kontexte der Knoten und runData werden als JSON in `execution_resume` gespeichert
  (gzip, mit Schlüssel verschlüsselt). Fortgesetzt wird mit dem Workflow-Stand vom Start der Ausführung, wie n8n.
- **Nicht in Unter-Workflows und der CLI:** Dort gibt es keinen Ort zum Speichern; Zeiten werden im Prozess abgewartet,
  Warten auf einen Webhook meldet einen klaren Fehler.
- **Wait v1:** Defaults wie in der n8n-Beschreibung (v1: 1 Stunde, v1.1: 5 Sekunden); vorher waren sie vertauscht.

## Python im Code-Node (M12)
- **Zwei Wege wie n8n:** "Python" läuft mit Pyodide im Serverprozess (Kontext mit `_` statt `$`, wie n8n `PythonSandbox`),
  "Python (Native)" mit einem echten Interpreter in einem eigenen Prozess (wie der Python-Task-Runner von n8n). n8n verlangt für
  Native einen separaten Task-Runner (`N8N_RUNNERS_ENABLED`); filuflow startet stattdessen je Ausführung `python3` mit einem
  eigenen, kleinen Runner (Aufgabe als JSON über stdin, Ergebnis als JSON über stdout). Das spart einen Dienst; der Start kostet
  etwa 30 ms je Ausführung des Knotens (nicht je Item).
- **Zeitlimit für Pyodide:** n8n hat im Pyodide-Modus keines. Python blockiert den Hauptthread, ein Timer kann dann nicht
  feuern. Deshalb setzt ein Worker-Thread den Interrupt-Buffer (SharedArrayBuffer); Python bricht mit KeyboardInterrupt ab, der
  Wrapper macht daraus "Code execution timed out". Entkommt ein Interrupt in die Event-Loop von Pyodide, fängt ein eigener
  Handler ihn ab, damit der Server weiterläuft.
- **Sicherheitsvorgaben für Native wie n8n** (Allowlists leer, gesperrte Builtins, Umgebung leer), damit exportierte
  Workflows dieselben Grenzen haben; Variablen mit den n8n-Namen gelten ebenfalls.

## Server
- fastify mit eigenem Content-Type-Parser für Webhooks: Der Body wird roh gelesen (gzip/deflate wie n8n) und im Webhook-Node
  nach den Regeln von n8n (`parseRequestBody`, `body-parser.ts`) ausgewertet. Antworten bauen die Semantik von Express nach
  (`res.json` und `res.send`: Content-Type, charset, CSP-Sandbox-Header).
- Query-Strings werden wie in n8n (Express `query parser: extended`) mit `qs` geparst.
- multipart/form-data wird mit der Fetch-API von Node (undici `Request.formData()`) gelesen statt mit formidable; keine neue Abhängigkeit.
- Execution-Log: SQLite über better-sqlite3, Tabellen `executions` und `execution_data` (gzip-komprimiertes JSON).
  Beim Start werden unvollständige Executions als `crashed` markiert.
- Webhook-Golden-Tests: `scripts/record-webhook.sh` importiert den Workflow in n8n, aktiviert ihn direkt in der Datenbank
  (`update:workflow --active=true` scheitert in 1.123 nach einem Import, siehe `scripts/activate-n8n-workflow.mjs`), startet
  `n8n start`, sendet die Requests aus `webhook.json` mit `scripts/webhook-client.mjs` und liest die Executions aus der SQLite-Datei.
  Derselbe Client sendet im Test an filuflow, damit Header und Reihenfolge identisch sind.

## Expression-Auswertung
- Eigener Evaluator statt `@n8n/tournament`: Templates werden wie tournament zerlegt und in einen
  JS-Ausdruck übersetzt, der in einem gemeinsamen `node:vm`-Kontext mit Timeout läuft.
- Bezeichner werden über `with (proxy)` aufgelöst. Der Proxy meldet jeden Namen als vorhanden,
  unbekannte Namen ergeben `undefined` (wie tournament, das jeden Bezeichner auf das Datenobjekt umschreibt).
- Die Spezifikation sagt "sonst String-Verkettung (Objekte als JSON)". n8n verkettet über `Array.join`,
  Objekte werden dabei zu `[object Object]`. Laut CLAUDE.md gilt Kompatibilität, daher verhält sich
  filuflow wie n8n.

## Zeitzone
Default `Europe/Berlin` (SPEC). Überschreibbar per `settings.timezone`, `FILUFLOW_TIMEZONE` oder `GENERIC_TIMEZONE`.
n8n hat als Default `America/New_York`; für Golden-Tests wird der n8n-Container mit `GENERIC_TIMEZONE=Europe/Berlin` gestartet.

## Start-Node
Explizit (`--trigger`), sonst der einzige aktive Trigger, sonst Fehler (SPEC 2.1). Die n8n-CLI wählt bei mehreren
Triggern den ersten passenden; filuflow verlangt dann bewusst eine Angabe.

## Golden-Tests und Orakel
- `scripts/record-expected.sh` führt Fixtures in `n8nio/n8n:1.123.0` per `n8n import:workflow` + `n8n execute --rawOutput` aus.
  `n8n execute` ignoriert `pinData` (nur im manuellen Modus aktiv), daher erzeugen Fixtures ihre Daten mit Code-Nodes.
- HTTP-Fixtures sprechen einen lokalen Mock-Server (`scripts/mock-server.mjs`, Port 18089) an; der n8n-Container läuft mit `--network host`.
- Für Funktionen mit sehr vielen Kombinationen (Filter-Operatoren, Erweiterungsfunktionen) wird n8n-Code direkt im Container
  als Orakel aufgerufen (`scripts/record-filter-table.sh`) und das Ergebnis als Tabelle eingecheckt.

## Versionen wie n8n
Bibliotheken, deren Verhalten in Ausgaben sichtbar wird, sind exakt auf die Versionen von n8n 1.123.0 gepinnt:
luxon 3.4.4, lodash 4.17.21, cheerio 1.0.0-rc.6, html-to-text 9.0.5, xml2js 0.6.2, qs 6.11.0, jsonrepair 3.13.1, jmespath 0.16.0,
title-case 3.0.3 und transliteration 2.3.5 (Erweiterungsfunktionen `toTitleCase()`, `replaceSpecialChars()`).
`html-to-text` wird vom HTML-Node (v1.2, Rückgabe "text") genutzt.

## Variablen (M18)
In der Oberfläche gepflegte Variablen liegen in der SQLite-Tabelle `kv` (Schlüssel `variables`), nicht in `vars.json`: Die
Datei bleibt von Hand gepflegt und hat Vorrang, wie bei Credentials. Das Objekt für `$vars` wird beim Speichern an Ort und
Stelle geändert, damit neue Ausführungen die Werte ohne Neustart sehen. Regeln für Schlüssel und Werte wie n8n
(`packages/@n8n/api-types/src/dto/variables/base.dto.ts`).

## Expressions in Webhook-Parametern (M18)
Pfad und Methoden werden bei der Aktivierung ausgewertet (n8n `getNodeWebhooks`), alle übrigen Parameter des Webhook-Knotens
bei jedem Aufruf (n8n `executeWebhook`), jeweils ohne Items. Ändert sich eine Variable, die im Pfad steckt, gilt der neue Pfad
erst nach dem nächsten Laden des Workflows (Speichern, Aktivieren, Neustart). Liefert die Pfad-Expression keinen Wert,
überspringt n8n den Webhook stillschweigend; filuflow meldet einen Aktivierungsfehler.

## Auf Test-Aufruf warten (M18)
Test-URLs sind in filuflow für alle gespeicherten Workflows immer registriert. "Auf Test-Aufruf warten" legt für den
übergebenen Editor-Stand eine eigene Registry an, die bei Test-URLs Vorrang hat und nach dem ersten Aufruf, nach Ablauf der
Wartezeit (höchstens 5 Minuten) oder beim Abbruch der Anfrage entfernt wird. Im Master gibt es das noch nicht.

## Parameterformulare (M19)
Die Beschreibungen liegen in den Knotendateien (`parameters`) in einem eigenen, vereinfachten Format; Namen, Defaults,
Optionswerte und Sichtbarkeitsregeln entsprechen n8n 1.123.0, damit gespeicherte Workflows dieselbe Struktur haben. Das
Formular schreibt einen Parameter erst, wenn er geändert wird; die Ausführung nutzt weiter ihre eigenen Defaults (dieselben
wie n8n). Ausnahmen:
- Code-Felder: n8n hat einen leeren Default und setzt den Startcode im Editor. filuflow zeigt den Startcode als Default
  und speichert ihn beim Anzeigen, damit sichtbarer und ausgeführter Code übereinstimmen.
- `customCss` von Form Trigger, Form und Chat Trigger hat einen leeren Default; die eigenen Seiten nutzen die
  CSS-Variablen von n8n nicht.
- Optionen, die filuflow nicht ausführt (Webhook `streaming`, Chat Trigger `responseNodes` und `n8nUserAuth`), fehlen in
  den Auswahllisten; `validate` meldet sie weiterhin, wenn ein importierter Workflow sie nutzt.
- Expressions in einem steuernden Parameter lassen sich im Editor nicht auswerten; abhängige Felder bleiben dann sichtbar.

## Merge per SQL mit alasql (M20)
`combineBySql` führt SQL über die Eingänge aus. Das Verhalten (Dialekt, Joins, Typen, Ergebnisform) ist das von alasql;
ein eigener SQL-Interpreter würde nie dieselben Ergebnisse liefern. Deshalb ist alasql als Laufzeit-Abhängigkeit dazugekommen,
exakt in der Version von n8n 1.123.0 (4.4.0), wie die übrigen Bibliotheken unter "Versionen wie n8n". Die Datei-Funktionen
von alasql sind gesperrt.

## Execution-Order v0 (M20)
Wie n8n gilt jeder Wert außer "v1" als alte Reihenfolge, auch eine fehlende Angabe (der Validator warnt dann). Umgesetzt
nach `packages/core/src/execution-engine/workflow-execute.ts`: Breitensuche (`push` statt `unshift`), Kinder in
Verbindungsreihenfolge statt nach Position, bei Knoten mit mehreren Eingängen werden fehlende Vorgänger ohne Daten mit einem
leeren Item gestartet, ein leerer Ausgang an einem zweiten Eingang zählt als Daten, Eingangsdaten kommen immer aus Eingang 1,
`requiredInputs` gilt nicht, und ein Knoten ohne Daten auf allen Eingängen kommt zurück auf den Stack (mit Abbruch bei
Endlosschleifen). Golden-Tests gegen ein laufendes n8n fehlen noch, weil in dieser Umgebung kein n8n-Container lief.

## Execute Workflow aus Datei und URL (M20)
Relative Pfade gelten wie in n8n ab dem Arbeitsverzeichnis des Prozesses. n8n liest ohne Einschränkung; filuflow bietet
zusätzlich `FILUFLOW_RESTRICT_FILE_ACCESS_TO` (Name wie `N8N_RESTRICT_FILE_ACCESS_TO`). Externe Module für `require` kommen
aus der Installation von filuflow, wie bei n8n aus der des Task-Runners.

## Streaming (M21)
Wie n8n: Ein Run-Hook `sendChunk` gibt es nur, wenn die Antwort gestreamt wird; `isStreaming()` prüft ihn und den Modus
(manual, webhook, integrated). Knoten schreiben `begin`/`item`/`end`, die Engine bei Fehlern `error`. Der Server schreibt jede
Zeile sofort (chunked) und beendet die Antwort mit der Ausführung. Die Modelle streamen über Server-Sent Events; der
HTTP-Client liefert dafür Teilantworten (`onChunk`), behält aber den vollständigen Body, sodass Tracing, Token-Zählung und
Ergebnis genau wie ohne Streaming entstehen. Der V2-Agent gibt als Ergebnis die Antwort des letzten Modellaufrufs zurück
(n8n setzt dort den gesamten gestreamten Text zusammen; bei Tool-Aufrufen ohne Begleittext ist das dasselbe). Das
Chat-Fenster im Editor nutzt weiter Testläufe ohne Streaming.

## Chat mit Antwortknoten (M22a)
n8n verbindet die Chat-Seite über eine WebSocket (`/chat`, Paket ws) mit der wartenden Ausführung. filuflow nutzt
Server-Sent Events für den Weg zur Seite und POST für Antworten: gleicher Ablauf (Nachricht, "continue", Ende, Prüfung im
Abstand von 500 ms statt 3 s), aber ohne neue Abhängigkeit und mit dem fastify-Server allein. Das eingebettete Chat-Widget von
n8n (`@n8n/chat`) spricht diesen Kanal nicht; die gehostete Chat-Seite von filuflow schon.

## Credentials aus n8n und OAuth1 (M22)
n8n verschlüsselt Credentials mit crypto-js im OpenSSL-Format ("Salted__", 8 Byte Salz, Schlüssel und IV per EVP_BytesToKey
mit MD5, AES-256-CBC, Base64). filuflow baut das mit `node:crypto` nach (keine neue Abhängigkeit) und prüft es im Test gegen
`openssl enc -md md5`. Importierte Einträge behalten ihre n8n-ID, damit Workflows mit `credentials.<typ>.id` sie finden.

Freigaben gelten je Worker und Projekt in der Master-Datenbank (`credential_access`), nicht beim Worker: Der Worker kennt keine
Projekte, und der Master prüft ohnehin jeden Workflow vor dem Verteilen. Ohne Eintrag darf jedes Projekt des Workers das
Credential nutzen, wie bisher; so ändert die Einführung nichts an bestehenden Installationen.

OAuth1 folgt n8n (oauth-1.0a): Signatur über URL-Query und Formularfelder, beim Aufruf ersetzt der Authorization-Header alle
übrigen Header. Den Content-Type des Bodys behält filuflow, weil ihn bei n8n die HTTP-Bibliothek danach selbst setzt. Beim
Request-Token schickt filuflow `oauth_callback` zusätzlich im Header mit (n8n nur im JSON-Body), da Anbieter den JSON-Body
meist nicht lesen; die Signatur ist dieselbe. Der Access-Token-Abruf ist wie bei n8n unsigniert (Formular mit
`oauth_token` und `oauth_verifier`).

## Rollen je Workflow und zentrale Suche (M23)
Rollen je Workflow ergänzen die festen Projektrollen, statt ein frei konfigurierbares Rechtemodell einzuführen: Die vorhandenen
Rollen decken die Fälle "einzelner Workflow für Lesende bearbeitbar", "vertraulicher Workflow" und "Freigabe an Externe" ab und
bleiben überschaubar. Projekt-Admins sind bewusst nicht einschränkbar, damit niemand ein Projekt unverwaltbar machen kann.

Die zentrale Suche hält keinen Index im Master: Ausführungen und ihre Daten bleiben beim Worker (Datenhaltung beim Mandanten).
Der Master fragt die Worker parallel mit den lesbaren Workflow-IDs (POST, weil die Liste lang werden kann) und führt die
Ergebnisse nach Beginn zusammen. Geblättert wird über den Beginn des letzten Treffers; das ist über mehrere Worker stabil,
solange keine zwei Ausführungen auf die Millisekunde gleich beginnen.

## Plugins (M24)
Knoten im n8n-Format sind CommonJS und importieren `n8n-workflow`. filuflow liefert dafür einen eigenen Ersatz (Fehlerklassen,
Verbindungstypen, kleine Hilfen), der über `Module._resolveFilename` greift, wenn das Paket beim Plugin nicht installiert ist:
Das echte Paket bringt viele Abhängigkeiten mit und steht unter der Sustainable Use License; der Ersatz ist eigene Arbeit nach
dem beobachtbaren Verhalten. Klassen werden wie bei n8n aus dem Dateinamen bestimmt; die Isolation über `vm`, die n8n beim
Laden nutzt, entfällt (sie ist auch bei n8n keine Sicherheitsgrenze).

Der Kontext für `execute` bildet die häufig genutzten Funktionen nach statt der ganzen `IExecuteFunctions`. Fehlt eine
Funktion, scheitert der Knoten mit einer klaren Meldung. Trigger, Polling und Webhooks brauchen eigene Laufzeitteile
(Aktivierung) und sind bewusst ausgelassen; der Lader meldet sie, statt sie still falsch auszuführen. Deklarative Knoten
kamen mit M29 dazu (siehe unten).

Eigene filuflow-Plugins schreiben Knoten gegen dieselbe Schnittstelle wie die eingebauten Knoten. Es gibt keinen eigenen
Sandbox-Modus: Plugins sind Code der Betreiber und laufen im Prozess.

## Vordefinierte Credential-Typen (M25)
n8n bringt Hunderte Credential-Typen mit eigener `authenticate`-Beschreibung mit. filuflow übernimmt sie nicht als Kopie,
sondern beschreibt eine Auswahl häufig genutzter Typen selbst nach dem beobachtbaren Verhalten (Fundstelle je Typ in
`src/credentials/authenticate.ts`); weitere kommen über Plugins (M24), deren `authenticate` dieselbe Stelle nutzt. Typen auf
`…OAuth2Api` laufen ohne eigene Beschreibung über das verbundene oder importierte Token; für den Refresh braucht es die
Token-URL im Credential.

Die helpers des Code-Knotens und der Plugin-Knoten sind dieselbe Umsetzung (`src/nodes/shared/executeHelpers.ts`), damit
sich Code, der in n8n mit `this.helpers` bzw. `helpers` arbeitet, an beiden Stellen gleich verhält.

## Weitere KI-Modelle (M26)
Die Modelle sprechen die Anbieter direkt per HTTP an, wie schon OpenAI, Anthropic und Gemini, ohne die SDKs von Groq,
Mistral oder Ollama. Maßstab ist, was die LangChain-Pakete in den Versionen von n8n 1.123.0 senden (per `npm pack`
gelesen): Feldnamen, Defaults (Temperatur 0.7 bei Groq und Mistral), Umwandlung der Nachrichten und Eigenheiten, die n8n
dadurch mitbringt. Bewusst übernommen sind auch Eigenheiten wie: Mistral streamt immer (n8n übergibt stets ein
AbortSignal), Ollama schickt Tool-Aufrufe früherer Antworten nicht mit, die Ollama-Optionen "useMLock"/"useMMap" wirken
nicht, die Responses API liefert keine Token-Zahlen ans Tracing (n8n schätzt dann). Der Agent V3 baut seine Schritte wie
n8n aus den Engine-Antworten neu; die IDs der Responses API gehen dabei wie dort verloren.

## Embeddings und Vektorspeicher (M27)
Auch die RAG-Knoten kommen ohne LangChain aus. Maßstab ist das Verhalten von n8n 1.123.0 mit @langchain/core 1.1.0,
@langchain/classic 1.0.5 und @langchain/textsplitters 1.0.1 (per `npm pack` gelesen); `scripts/rag-oracle.mjs` nimmt die
Ergebnisse der echten Pakete für Splitter, Loader und Ähnlichkeitssuche auf, `test/rag.test.ts` vergleicht dagegen. Die
Trennzeichen je Programmiersprache sind Daten aus @langchain/textsplitters (MIT-Lizenz) und deshalb wörtlich übernommen; der
Splitter selbst ist eigener Code.

Bewusst übernommene Eigenheiten:
- Der Simple Vector Store hält die Daten im Speicher des Prozesses, geteilt über alle Workflows, die denselben Schlüssel
  nutzen (bis v1.1 mit der Workflow-ID davor, ab v1.2 der Wert aus dem Resource Locator), und verliert sie beim Neustart.
- Die Ähnlichkeitssuche sortiert mit dem Vergleich von MemoryVectorStore (`a > b ? -1 : 0`), der bei gleichen Werten die
  Einfügereihenfolge behält.
- OpenAI Embeddings fordern wie das SDK `encoding_format: "base64"` an und lesen Float32 (Little Endian).
- Der Recursive Character Text Splitter des n8n-Knotens behält die Trennzeichen nicht (`keepSeparator: false`), obwohl die
  Klasse sonst `true` nutzt.
- Das Protokoll der Sub-Nodes folgt logWrapper: Embeddings, Splitter, Loader, Vektorspeicher und Tool erscheinen mit
  eigenen Läufen, der Retriever nicht (in n8n 1.123.0 greift die Umhüllung dort nicht).
- PDF, DOCX und EPUB bräuchten zusätzliche Bibliotheken; der Data Loader lehnt sie mit einer klaren Meldung ab, statt sie
  falsch zu lesen. Ein Reranker am Vektorspeicher bricht die Ausführung ebenso mit einer Meldung ab.

## OAuth2-Typen der Dienste (M28)
Die Typen beschreiben, wie in n8n, nur feste Werte über `extends: ['oAuth2Api']`; Code-Tausch, Refresh und Signatur bleiben
die vorhandene OAuth2-Umsetzung. Die Werte (URLs, Scopes, Query-Parameter, Art der Client-Authentifizierung) sind Daten
der jeweiligen Dienste, gelesen aus n8n-nodes-base 1.121.0 und in eigener Struktur aufgeschrieben
(`src/credentials/oauth2Types.ts`). Aufgenommen ist eine Auswahl häufig genutzter Dienste; andere Typen auf `…OAuth2Api`
aus einem n8n-Export laufen weiter, wenn die gespeicherten Daten URLs enthalten (das speichert der n8n-Editor mit).

Defaults gelten beim Laden in der Engine für alle Typen mit Beschreibung, wie n8n `applyDefaultsAndOverwrites`: fehlende
Werte sichtbarer Felder bekommen ihren Default, gespeicherte Werte gehen vor. Abweichend von n8n:
- Ausdrücke (`=…{{ $self.feld }}`) wertet filuflow nur in versteckten Feldern aus. Sie stammen aus der Typbeschreibung oder
  einem n8n-Export; eingegebene Werte, etwa ein Passwort mit "=" am Anfang, bleiben unverändert. filuflow kennt für
  Credentials weiterhin `{{ env.NAME }}`, aber keine n8n-Expressions mit `$vars` oder `$secrets`.
- Felder, die keine Beschreibung kennt, verwirft filuflow nicht (n8n gibt nur beschriebene Felder weiter).
- Ausgewertet wird in `node:vm` mit Zeitlimit; Credentials und Typen gelten wie Workflows als vertrauenswürdig.

Die Optionen von `requestOAuth2` je Dienst (getOAuth2AdditionalParameters) gelten wie in n8n auch für Typen ohne eigene
Beschreibung (z. B. `shopifyOAuth2Api` aus einem Export). Übernommen sind auch Eigenheiten: der HTTP Request erzwingt bei
`oAuth2Api` den Token-Typ "Bearer"; nach einem Refresh signiert n8n den Request neu, ohne `keepBearer` anzuwenden, und
setzt den Zusatz-Header (Shopify) mit dem bisherigen Token.

## Deklarative Knoten (M29)
Knoten ohne `execute`, die ihre Requests beschreiben (`requestDefaults`, `routing` an Parametern und Auswahlwerten,
`requestOperations`), führt `src/plugins/routingNode.ts` aus. Maßstab ist n8n-core 1.122.0 (in n8n 1.123.0)
`execution-engine/routing-node.ts`; nachgebaut sind Reihenfolge und Zusammenführung der Request-Teile (lodash merge),
Sichtbarkeit gegen die Parameter der obersten Ebene, `$credentials`, `$value`, `$index`, `$parent`, `$request`,
`$response`, `$responseItem` und `$version` in Expressions, preSend und postReceive (Funktionen sowie rootProperty, filter,
limit, set, sort, setKeyValue, binaryData), Pagination (Funktion mit `makeRoutingRequest`, generic, offset), maxResults,
Batching und die Einstellung "Request Options", die n8n beim Laden ergänzt. Fehler werden wie dort zu NodeApiError, bei 429
mit dem Hinweis auf Batching.

Dafür folgt `helpers.httpRequest` jetzt genauer convertN8nRequestToAxios: Ein leerer Body (z. B. `{}` aus den Defaults)
wird nicht gesendet, bei GET nie ein Body. Nicht nachgebaut: `preAuthentication` von Credential-Typen (Tokens, die n8n vor
dem Request holt und im Credential speichert) und der Header `User-Agent: n8n`.

## Community-Pakete aus der Oberfläche (M30)
Der Ablauf folgt n8n 1.123.0 `community-packages.service.ts`: Paketname prüfen, Version über die Registry auflösen,
`npm pack` in einen Download-Ordner, nach `<ordner>/node_modules/<paket>` entpacken, dev-, peer- und optionale
Abhängigkeiten entfernen, `npm install --ignore-scripts` mit denselben Schaltern, Abhängigkeit in `<ordner>/package.json`
eintragen; ein Paket ohne ladbare Knoten wird wieder entfernt. Abweichend von n8n:
- Die Version prüft filuflow mit `npm view` statt per HTTP; so gelten Proxy und Anmeldung der npm-Konfiguration auch dafür.
- Die Liste der Pakete liegt als Datei `filuflow-packages.json` im Paketordner (n8n: Tabelle `installed_packages`); so
  braucht der Ordner keine Datenbank und funktioniert auch für `validate` und `run`.
- Beim Aktualisieren und Entfernen nimmt filuflow Knoten- und Credential-Typen aus der Registry und leert den
  `require`-Cache des Pakets; ein Neustart ist nicht nötig. Es gibt keine Prüfung auf "verifizierte" Pakete und keine
  Prüfsummen, weil filuflow keine Liste geprüfter Pakete von n8n bezieht.

## Poll- und Trigger-Knoten aus Paketen (M31)
Knoten mit `poll()` oder `trigger()` bekommen eine allgemeine Aktivierung (`NodeType.activate`, `src/server/activations.ts`)
statt eines eigenen Dienstes je Knotentyp. Maßstab ist n8n-core 1.122.0: `activatePolling` (Poll Times über
`toCronExpression` mit zufälliger Sekunde, erster Abruf beim Aktivieren, Fehler dabei verhindern die Aktivierung, Abstand
mindestens eine Minute), `runTrigger` und `executePollNode`/`executeTriggerNode` für den manuellen Lauf. Wie dort speichert
`emit` die statischen Daten und startet eine Ausführung ab dem Knoten; Fehler starten den Fehler-Workflow mit den Daten
`{ trigger: { error, mode }, workflow }`. Ein Trigger-Knoten, der `emitError` meldet, wird geschlossen und mit doppeltem
Abstand ab einer Sekunde neu gestartet (höchstens 24 Stunden), wie n8n mit `addQueuedWorkflowActivation`.

Der Kontext eines aktiven Auslösers ist derselbe wie bei einer Ausführung (`WorkflowExecutor.contextFor`), nur ohne
Eingangsdaten; dadurch gelten Credentials, Expressions und statische Daten wie sonst. Die CLI führt Poll- und
Trigger-Knoten wie den manuellen Lauf aus, wenn keine Eingabedaten übergeben werden.

## Webhook-Knoten aus Paketen (M32)
Paket-Knoten mit `webhook()` und `description.webhooks` laufen über den vorhandenen WebhookService; nur Beschreibung,
Aufruf und Anmeldung kommen vom Knoten (`NodeType.packageWebhooks`, `src/plugins/webhookNode.ts`). Maßstab ist n8n 1.123.0
`webhook.service.ts` (getNodeWebhooks, runWebhookMethod, runWebhook), `webhook-helpers.ts` (executeWebhook,
evaluateResponseOptions, parseRequestBody) und die Kontexte WebhookContext und HookContext. Übernommen sind auch
Eigenheiten: Ohne `responseData` in der Beschreibung antwortet n8n im Modus "onReceived" mit dem Text `firstEntryJson`
(Default von getComplexParameterValue, den extractWebhookOnReceivedResponse vor `webhookResponse` prüft); ab Knotenversion
2 werden nur JSON-, Text-, Formular- und XML-Bodies gelesen.

Die Anmeldung beim Dienst (`checkExists`, `create`, `delete`) läuft beim Aktivieren vor den Poll- und Trigger-Knoten;
scheitert sie, wird der Workflow nicht aktiviert. Beim Warten auf einen Test-Aufruf meldet filuflow den Test-Webhook an
und danach wieder ab. Für das eigene Antworten (`noWebhookResponse`) gibt es ein Antwortobjekt im Stil von Express, das
Status, Header und Body sammelt; Streaming über dieses Objekt ist nicht nachgebaut.

## Gemeinsame Credentials (M33)
Ein gemeinsames Credential ist im Master die Quelle; beim Worker ist es ein gewöhnliches verwaltetes Credential, das der
Master über die vorhandene Worker-API schreibt. So brauchen Worker keine Änderung, Freigaben für Projekte (M22) und die
Prüfung von Workflows gelten unverändert, und ein Worker läuft auch ohne Master weiter. Der Master merkt sich je Worker
den verteilten Namen und die Version; der Abgleich verteilt nur, was veraltet oder fehlgeschlagen ist, und arbeitet eine
Liste offener Entfernungen ab. Die ID aus dem Master wird mitgegeben, damit Workflows, die per ID verweisen, auf allen
Workern dasselbe Credential finden. Von Hand beim Worker geänderte Kopien werden erst bei der nächsten Änderung im Master
überschrieben; die Oberfläche kennzeichnet sie als "Master (gemeinsam)".

## Eigene Rollen (M34)
Eigene Rollen sind Listen der vorhandenen Aktionen (`project.manage`, `workflow.edit`, `workflow.run` …) und werden als
"custom:<id>" dort gespeichert, wo bisher die eingebauten Rollen stehen (Projektmitglieder, Rollen je Workflow). So bleibt
die Prüfung an jeder Route gleich (`allows(rolle, aktion)`), nur die Auflösung kennt jetzt auch eigene Rollen. Das Projekt
sehen gehört immer dazu. Projekt-Admins und globale Administratoren behalten unabhängig davon vollen Zugriff, auch wenn eine
eigene Rolle `project.manage` enthält. Vergebene Rollen lassen sich nicht löschen, Änderungen wirken sofort. Ältere
Datenbanken bekommen beim Start eine neue Fassung der Mitgliedertabellen, weil SQLite einen CHECK nicht ändern kann.

## Aufseher (M35)
Der Aufseher ist ein Teil des Servers, kein Workflow: Er braucht Zugriff auf alle Workflows, Ausführungen und den
Validator, und seine Ergebnisse (Hinweise, Vorschläge, Berichte) sind Verwaltungsdaten. Er liegt unter `src/supervisor/`
und speichert in derselben SQLite-Datenbank wie die Ausführungen (Tabellen `supervisor_*`), damit Server und Worker ohne
weitere Einrichtung mitbringen, was er braucht.

Für das Modell gibt es keinen eigenen Client. Der Aufseher baut einen internen Workflow aus einem Platzhalter und dem
Chat-Model-Knoten des gewählten Anbieters mit dem gewählten Credential und holt das Modell wie ein AI Agent über den
KI-Eingang (`Runner.activationContext`, `getSubNodeInstance`). So gelten dieselben Anbieter, Credentials, Header-Optionen
und Fehlermeldungen wie in Workflows, und jeder neue Modell-Knoten steht dem Aufseher über eine Zeile in der Tabelle
`PROVIDERS` zur Verfügung. Werkzeuge nutzt der Aufseher über die Tool-Aufrufe der Modelle; die Schleife ist eigen und
kurz (höchstens vier Schritte bei Analysen), weil der Aufseher keine Ausgabe für ein runData braucht.

Feste Regeln kommen vor dem Modell: Sie kosten nichts, sind nachvollziehbar und laufen auch ohne Modell. Das Modell wird
nur für Erklärungen, Vorschläge und Berichte gefragt, fehlgeschlagene Ausführungen einmal je Fehlerbild (Schlüssel aus
Workflow, Knoten und der Meldung ohne Zahlen und IDs), damit ein Fehler in einer Schleife nicht das Budget verbraucht.
Das Tagesbudget gilt für alle Aufrufe zusammen; Tokenzahlen kommen aus den Antworten der Anbieter, sonst aus einer
Schätzung (Zeichen durch vier).

Befunde aus Regeln beschreiben einen Zustand: Treten sie bei der nächsten Prüfung nicht mehr auf, sind sie erledigt.
Befunde aus Ausführungen sind Ereignisse: Sie zählen hoch und gelten als erledigt, wenn sie drei Tage nicht mehr
auftraten und die letzte Ausführung gelang. Verworfene Hinweise bleiben verworfen, bis jemand sie wieder öffnet.

