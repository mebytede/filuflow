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

## Server und Webhooks
- **Test-URLs** (`/webhook-test/...`): In n8n nur nach "Listen" im Editor und für genau einen Aufruf. flowlite registriert
  Test-URLs für alle geladenen gültigen Workflows (auch inaktive) und führt sie im Modus `manual` aus (pinData aktiv, `executionMode: test`).
- **responseMode `responseNode` ohne erreichten Respond-Node:** n8n lässt den Request unbegrenzt offen. flowlite antwortet nach Ende der
  Execution mit 200 und `{"message":"Workflow executed successfully but no Respond to Webhook node was executed"}`.
- **responseData `firstEntryBinary`:** n8n 1.123 sendet Binärdaten ohne Dateispeicher-ID über `res.json`, also als serialisierten
  Buffer (`{"type":"Buffer","data":[...]}`). flowlite sendet die Bytes mit dem MIME-Typ der Datei.
- **Streaming** (`responseMode: streaming`, Respond to Webhook v1.5 mit Streaming) wird nicht unterstützt; `validate` meldet es.
- **Expressions in Webhook-Parametern** (`path`, `httpMethod`, `responseMode`, `responseData`) werden nicht ausgewertet; `validate` meldet sie.
- **`ignoreBots`** nutzt ein eigenes Muster statt der Liste des npm-Pakets `isbot`.
- **JWT** (Webhook-Authentifizierung, Respond-Node `jwt`): eigene Umsetzung mit `node:crypto` statt `jsonwebtoken`
  (HS/RS/PS/ES, Prüfung von `exp` und `nbf`). Fehlermeldungen entsprechen jsonwebtoken für die häufigen Fälle.
- **Parameter-Bereinigung:** n8n entfernt beim Laden Parameter, deren `displayOptions` sie ausblenden (`getNodeParameters`).
  flowlite bildet das nicht allgemein nach. Exporte aus dem n8n-Editor sind bereits bereinigt; nachgebaut sind die Fälle, in denen
  sich Optionen gegenseitig ausblenden (Webhook: `rawBody` und `noResponseBody`, Antwortoptionen je `responseMode`).
- **REST-API** gibt es in n8n in dieser Form nicht. `POST /api/workflows/:id/run` startet im Modus `trigger` ohne pinData.
- **Fehler beim Start durch den Webhook-Node** (z. B. fehlender Respond-Node): n8n speichert eine fehlgeschlagene Execution mit dem Fehler;
  flowlite antwortet gleich (500 bzw. Meldung), speichert aber keine Execution.
- **Wartende Executions** (`/webhook-waiting/`, Formulare, Chat-Trigger) fehlen in Phase 1.
- **Statische Daten** (`$getWorkflowStaticData`, Schedule-Wiederholungen) liegen nur im Speicher und gehen beim Neustart verloren.
- **Gleichzeitigkeit:** Das Limit (Default 5) gilt für Webhook-, Schedule-, Fehler- und API-Executions. Unter-Workflows laufen
  innerhalb der aufrufenden Execution und zählen nicht extra.

## Schedule Trigger
n8n rechnet mit moment-timezone und dem Paket `cron`, flowlite mit luxon und croner. Die Ausgabefelder und die Kalenderwerte
der Wiederholungsprüfung sind gegen moment-timezone aus dem n8n-Image getestet (`test/oracle/schedule-moment.json`).

## Credentials
- Credentials kommen aus `credentials.json` bzw. einem Verzeichnis statt aus der n8n-Datenbank. Exporte von
  `n8n export:credentials --decrypted` werden direkt gelesen; mit dem n8n-Schlüssel verschlüsselte Exporte nicht.
- Verschlüsselung: eigenes Format (AES-256-GCM, Schlüssel = SHA-256 von `FLOWLITE_ENCRYPTION_KEY`), nicht kompatibel mit n8n.
- OAuth2 (client_credentials): n8n speichert das Token im Credential und nutzt es auch nach einem Neustart weiter;
  flowlite hält es im Speicher des Prozesses. Wie n8n wird das Ablaufdatum nicht geprüft, sondern nach einer 401-Antwort
  ein neues Token geholt und der Request einmal wiederholt. Andere Grant-Typen (authorizationCode, pkce) fehlen.
- Maskierung in Ausgaben und im Execution-Log betrifft geheime Felder (Namen mit pass, secret, token, value, json,
  private, apiKey). Werte kürzer als 4 Zeichen werden nicht maskiert.

## Weboberfläche
Die Oberfläche ist ein eigener, schlanker Editor, kein Nachbau des n8n-Editors:
- Parameter werden als Baum (Formular) oder JSON bearbeitet, ohne die Felder, Auswahllisten und Hilfetexte der n8n-Nodes.
- Ausführen startet immer den ganzen Workflow (Modus `manual`, mit pinData), keine Teilausführung ab einem Node. pinData lässt sich
  über die JSON-Ansicht des Workflows (Export/Import) pflegen, nicht per Klick.
- Test-Webhooks (`/webhook-test/...`) sind für alle gültigen Workflows registriert; ein "Auf Test-Event warten" wie in n8n gibt es nicht.
- Credentials werden nicht in der Oberfläche angelegt oder bearbeitet, sondern in `credentials.json`.
- Mehrere Personen, die gleichzeitig denselben Workflow speichern: der letzte Stand gewinnt (keine Sperre, keine Versionen).

## KI-Nodes
- **Kein LangChain:** Modelle, Prompts, Parser, Memory und der Agent-Ablauf sind eigene Umsetzungen nach dem Verhalten von
  n8n 1.123.0 mit @langchain/core 1.1 und @langchain/classic 1.0.5. Request-Bodies an Gemini, OpenAI und Anthropic sind
  gegen die von n8n gesendeten Requests getestet (Fixtures 17 bis 19, `requests.json`).
- **Tracing im runData der Sub-Nodes** (`ai_languageModel`, `ai_memory`, `ai_tool`, `ai_outputParser`): Läufe, Reihenfolge und
  Quelle wie n8n. Die Token-Schätzung (`estimatedTokens`, `tokenUsageEstimate`) rechnet grob mit 4 Zeichen pro Token statt tiktoken.
- **OpenAI Responses API** (lmChatOpenAi v1.3 mit `responsesApiEnabled`, Default in v1.3) wird nicht unterstützt; `validate` meldet es.
- **Simple Memory** liegt wie in n8n im Speicher des Prozesses (je Workflow-ID und Session-ID, nach 1 h Leerlauf gelöscht).
  Unter der CLI beginnt also jeder Lauf mit leerem Speicher.
- **Agent:** Streaming (`enableStreaming` mit Chat-Trigger) fehlt, die Antwort kommt immer vollständig. `maxTokensFromMemory`
  wird von `validate` gemeldet. `intermediateSteps[].action.messageLog` (Agent V2) enthält die Modellantwort in der
  LangChain-Serialisierung wie n8n (gegen OpenAI, Gemini und Anthropic aufgenommen, Fixture 22); Felder, die nur bei
  bestimmten Antworten vorkommen (z. B. `system_fingerprint`, Cache-Token), können fehlen. Die `id` einer Gemini-Antwort ist
  wie in n8n zufällig (`run-<uuid>`).
- **HTTP Request Tool** (toolHttpRequest): nicht unterstützt sind vordefinierte Credential-Typen, Digest- und OAuth1-Auth,
  Antworttyp "text" (Readability) und HTML mit "onlyContent" (html-to-text); `validate` meldet sie. Wie in n8n kann Agent v3
  das Tool nicht ausführen (Fehler "Invalid URL", Fixture 21); dasselbe gilt für das Workflow-Tool v1.x.
- **Workflow-Tool** (toolWorkflow): Unter-Workflows kommen aus dem Workflow-Verzeichnis (ID oder Name) oder aus dem Parameter.
  `workflowInputs` gilt wie in n8n nur bei `source: database` (n8n entfernt den Parameter sonst beim Laden). Ein Fehler in n8n bei
  Agent v2 mit mehreren Items und `$fromAI` (Item-Index über 0 findet keine Tool-Daten) ist nicht nachgebaut.
- **`$fromAI()`** liest die Argumente des Tool-Aufrufs (auch unter `query`), sonst die Eingangsdaten des Items, sonst den Default.
- **Output Fixing Parser** (Information Extractor, Text Classifier): Der Text der Fehlermeldung an das Modell ist nachgebaut, aber
  nicht byte-gleich mit der zod-Fehlermeldung von LangChain.
- Agent typeVersion 1.x (ReAct, SQL, Plan-and-Execute, OpenAI Functions) wird nicht unterstützt.
