# Bewusste Abweichungen von n8n

Jede Abweichung ist hier mit Grund aufgeführt. Alles, was hier nicht steht und sich anders verhält als n8n 1.123.0, ist ein Fehler.

## Code-Node
- **Kein `require`.** n8n erlaubt eingebaute/externe Module über `NODE_FUNCTION_ALLOW_BUILTIN`/`_EXTERNAL`. flowlite stellt laut
  CLAUDE.md kein `require` im Sandbox-Kontext bereit. Häufig gebrauchte Globals (`Buffer`, `URL`, `setTimeout`, `TextEncoder`, …) sind vorhanden.
- **Timeout** (Default 60 s, `FLOWLITE_CODE_TIMEOUT_MS`). n8n hat im In-Process-Modus kein Timeout.
- **Python** wird abgelehnt (`validate` meldet es, `run` bricht ab).
- **`console.log`** landet im Execution-Log (n8n verwirft die Ausgabe außerhalb des Editors).
- `helpers` enthält nur eine Teilmenge (`getBinaryDataBuffer`, `prepareBinaryData`, `httpRequest`, `returnJsonArray`, `normalizeItems`).

## pinData
n8n nutzt `pinData` nur bei manuellen Ausführungen aus dem Editor. flowlite nutzt sie laut SPEC auch bei `flowlite run`
(abschaltbar mit `--no-pin`); im Server (Webhook/Schedule) werden sie wie in n8n ignoriert.

## HTTP Request
- **Pagination** ist noch nicht umgesetzt (`validate` meldet sie).
- Vordefinierte Credential-Typen (`predefinedCredentialType`) werden nicht unterstützt; generische Typen schon
  (`httpHeaderAuth`, `httpBasicAuth`, `httpQueryAuth`, `httpBearerAuth`, `httpCustomAuth`, `oAuth2Api` mit client_credentials).
- Bei `continueOnFail` steht im Item `error` ein AxiosError-ähnliches Objekt (`message`, `name`, `code`, `status`), ohne Stacktrace.
- Antwort-Header kommen von undici statt axios; volatile Header (`date`, `connection`, `keep-alive`) unterscheiden sich.
- `httpDigestAuth`, OAuth1 und SSL-Client-Zertifikate fehlen.

## Wait
flowlite wartet immer im Prozess. n8n legt Executions mit mehr als 65 s Wartezeit in den Zustand "waiting" und setzt sie später fort.
Webhook- und Formular-Resume fehlen in Phase 1.

## Execute Workflow
Unter-Workflows kommen aus dem Workflow-Verzeichnis (ID oder Name) oder aus dem Parameter (`source: parameter`).
`source: localFile` und `source: url` werden nicht unterstützt.

## XML
Wie in n8n gehen Fehler-Items bei `continueOnFail` verloren (n8n überschreibt das Eingangs-Item statt eines auszugeben).
