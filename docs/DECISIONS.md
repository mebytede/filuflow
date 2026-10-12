# Entscheidungen

## Referenzversion n8n 1.123.0
Die Spezifikation verlangt Kompatibilität zu "aktueller 1.x". Gepinnt ist `n8nio/n8n:1.123.0`
(Docker Hub; `docker.n8n.io` ist aus der Build-Umgebung nicht erreichbar, das Image ist identisch).
Quellcode-Fundstellen in Kommentaren beziehen sich auf den Tag `n8n@1.123.0`.

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
  Derselbe Client sendet im Test an flowlite, damit Header und Reihenfolge identisch sind.

## Expression-Auswertung
- Eigener Evaluator statt `@n8n/tournament`: Templates werden wie tournament zerlegt und in einen
  JS-Ausdruck übersetzt, der in einem gemeinsamen `node:vm`-Kontext mit Timeout läuft.
- Bezeichner werden über `with (proxy)` aufgelöst. Der Proxy meldet jeden Namen als vorhanden,
  unbekannte Namen ergeben `undefined` (wie tournament, das jeden Bezeichner auf das Datenobjekt umschreibt).
- Die Spezifikation sagt "sonst String-Verkettung (Objekte als JSON)". n8n verkettet über `Array.join`,
  Objekte werden dabei zu `[object Object]`. Laut CLAUDE.md gilt Kompatibilität, daher verhält sich
  flowlite wie n8n.

## Zeitzone
Default `Europe/Berlin` (SPEC). Überschreibbar per `settings.timezone`, `FLOWLITE_TIMEZONE` oder `GENERIC_TIMEZONE`.
n8n hat als Default `America/New_York`; für Golden-Tests wird der n8n-Container mit `GENERIC_TIMEZONE=Europe/Berlin` gestartet.

## Start-Node
Explizit (`--trigger`), sonst der einzige aktive Trigger, sonst Fehler (SPEC 2.1). Die n8n-CLI wählt bei mehreren
Triggern den ersten passenden; flowlite verlangt dann bewusst eine Angabe.

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
