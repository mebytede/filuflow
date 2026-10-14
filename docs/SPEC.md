# filuflow Spezifikation

filuflow ist eine eigenständige Workflow-Plattform: Engine, Editor im Browser, CLI, Server mit Webhooks und Zeitplänen,
Ausführungsprotokoll, Credentials, KI-Knoten sowie Mehrbenutzer- und Mandantenbetrieb mit Master und Worker. Der Umfang ist
nicht begrenzt; was noch fehlt, steht als Ausbau in Abschnitt 11.

Workflows nutzen das Workflow-Format von n8n. Workflows, die in n8n (aktuelle 1.x) laufen, liefern in filuflow dieselben Items an
denselben Knoten; das sichern die Golden-Tests (Abschnitt 9). Die Angaben zu Parametern unten sind der Startpunkt. Vor der
Implementierung eines Knotens im n8n-Format gegen `packages/nodes-base/nodes/<Node>/` im n8n-Repo prüfen.

---

## 1. Datenmodell

### 1.1 Workflow-JSON (Eingabe, unverändert aus n8n-Export)
```ts
interface Workflow {
  id?: string; name: string; active?: boolean;
  nodes: WorkflowNode[];
  connections: Record<string /*Quell-Node-Name*/, Record<ConnectionType, Array<Array<Connection> | null>>>;
  settings?: { executionOrder?: "v0" | "v1"; timezone?: string; errorWorkflow?: string };
  pinData?: Record<string /*Node-Name*/, Array<{ json: object }>>;
}
interface WorkflowNode {
  id: string; name: string; type: string; typeVersion: number;
  position: [number, number]; parameters: Record<string, unknown>;
  credentials?: Record<string /*Credential-Typ*/, { id?: string; name: string }>;
  disabled?: boolean; alwaysOutputData?: boolean; executeOnce?: boolean;
  retryOnFail?: boolean; maxTries?: number; waitBetweenTries?: number;
  onError?: "stopWorkflow" | "continueRegularOutput" | "continueErrorOutput";
  continueOnFail?: boolean; // Altform von onError
  notes?: string;
}
interface Connection { node: string; type: ConnectionType; index: number }
type ConnectionType = "main" | "ai_languageModel" | "ai_memory" | "ai_tool" | "ai_outputParser" | string;
```
Verbindungen sind **über Node-Namen** adressiert, nicht über IDs. `connections[src].main[outputIndex]` ist die Liste der Ziele dieses Ausgangs.

### 1.2 Items
```ts
interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, BinaryRef>;
  pairedItem?: { item: number; input?: number } | Array<{ item: number; input?: number }>;
  error?: { message: string; [k: string]: unknown }; // bei onError=continue*
}
type NodeOutput = Item[][]; // Index = Ausgang (IF: 0=true, 1=false)
```
`BinaryRef`: `{ mimeType, fileName?, fileExtension?, fileSize?, data | id }`. Binärdaten über 1 MB in einem Dateispeicher ablegen, im Item nur die Referenz.

### 1.3 Ausführungsergebnis (kompatibel zu n8n `runData`)
```ts
interface Execution {
  id: string; workflowName: string; mode: "manual" | "cli" | "webhook" | "trigger";
  startedAt: string; stoppedAt?: string; status: "running" | "success" | "error" | "canceled";
  runData: Record<string /*Node-Name*/, Array<TaskData>>; // mehrere Einträge bei Schleifen
  lastNodeExecuted?: string; error?: SerializedError;
}
interface TaskData {
  startTime: number; executionTime: number; executionStatus: "success" | "error";
  data: { main: NodeOutput }; source: Array<{ previousNode: string; previousNodeOutput?: number; previousNodeRun?: number } | null>;
  error?: SerializedError;
}
```

---

## 2. Engine

### 2.1 Ablauf
1. Workflow laden, validieren (Abschnitt 6).
2. Start-Node bestimmen: explizit angegebener Trigger, sonst der einzige Trigger, sonst Fehler.
3. Ausführung nach **v1-Reihenfolge** (v0 ist Ausbau, siehe Abschnitt 11):
   - Stack-basiert: Ein Node läuft, sobald seine Eingangsdaten vorliegen. Ein Zweig wird vollständig zu Ende ausgeführt, bevor der nächste Zweig startet.
   - Reihenfolge paralleler Kinder: nach Canvas-Position (oben vor unten, dann links vor rechts). Exakte Sortierung in `packages/core` (WorkflowExecute) nachschlagen und nachbauen.
   - Nodes mit mehreren Eingängen (Merge): warten, bis kein Vorgänger mehr Daten liefern kann. Hat ein Eingang nie Daten bekommen, verhält sich der Node wie n8n v1 (nachschlagen, Testfall dafür schreiben).
4. Liefert ein Node 0 Items auf einem Ausgang, laufen dessen Nachfolger **nicht**, außer `alwaysOutputData: true` (dann ein leeres Item `{json:{}}`).
5. `pinData` für einen Node: Node wird nicht ausgeführt, die gepinnten Items gelten als seine Ausgabe (Ausgang 0).
6. `disabled: true`: Node wird durchgereicht (Eingang 0 geht unverändert auf Ausgang 0).
7. `executeOnce: true`: Node bekommt nur das erste Item.
8. Fehlerbehandlung je Node:
   - `retryOnFail`: bis `maxTries` (Default 3) mit `waitBetweenTries` ms (Default 1000).
   - `onError = stopWorkflow` (Default): Execution `error`, Abbruch.
   - `continueRegularOutput`: Items mit `json.error` auf normalen Ausgang.
   - `continueErrorOutput`: Node bekommt einen zusätzlichen Fehlerausgang (letzter Index), fehlerhafte Items gehen dorthin.
9. Schleifen über `Loop Over Items` (splitInBatches v3) müssen funktionieren; dadurch mehrere `TaskData` pro Node und `$runIndex`.
10. Abbruch: Execution per API/Signal abbrechbar; laufende HTTP-Requests über `AbortSignal`.

### 2.2 Paired Items
`pairedItem` mitführen, damit `$('Node').item` das zum aktuellen Item gehörende Item eines früheren Nodes findet. Regeln:
- 1:1-Nodes (Set, IF, Filter, HTTP pro Item): `pairedItem = { item: i }` automatisch setzen, wenn der Node keinen setzt.
- Code-Node: übernimmt, was der Code zurückgibt; fehlt es und die Anzahl Items ist gleich, Index-Zuordnung als Fallback; sonst bei `.item`-Zugriff einen Fehler wie n8n ("paired item data unavailable") werfen.
- Aggregierende Nodes: Array von Herkunfts-Items.

### 2.3 Node-Schnittstelle
```ts
interface NodeType {
  type: string;                 // z. B. "n8n-nodes-base.set"
  versions: number[];           // unterstützte typeVersions
  isTrigger?: boolean;
  outputs(node: WorkflowNode): number;   // kann von Parametern abhängen (Switch, onError)
  execute(ctx: ExecContext): Promise<NodeOutput>;
}
interface ExecContext {
  node: WorkflowNode; inputs: Item[][]; runIndex: number;
  getParam<T>(path: string, itemIndex: number, fallback?: T): T; // wertet Expressions aus
  getCredentials(type: string): Promise<Record<string, unknown>>;
  helpers: { http: HttpClient; binary: BinaryStore };
  signal: AbortSignal; logger: Logger;
}
```
`getParam` wertet Expressions **pro Item** aus. Das ist der wichtigste Kompatibilitätspunkt.

---

## 3. Expressions

### 3.1 Syntax
- Ein Parameterwert ist eine Expression, wenn er ein String ist, der mit `=` beginnt.
- Innerhalb: Text mit `{{ ... }}`-Segmenten. Besteht der ganze Wert aus genau einem Segment, wird der **Rohwert** (Zahl, Objekt, Array, Boolean) zurückgegeben, sonst String-Verkettung (Objekte als JSON).
- Auswertung als JavaScript in `node:vm`-Kontext mit Timeout (Default 1000 ms).
- Verschachtelte Parameter (Objekte, Arrays in `parameters`) rekursiv auswerten.

### 3.2 Variablen (Pflicht)
| Variable | Bedeutung |
|---|---|
| `$json` | JSON des aktuellen Items |
| `$binary` | Binärdaten des aktuellen Items |
| `$input.item`, `.all()`, `.first()`, `.last()`, `.params` | Eingang des aktuellen Nodes |
| `$('Name').item`, `.all(branch?, run?)`, `.first()`, `.last()`, `.itemMatching(i)`, `.isExecuted` | Ausgabe eines früheren Nodes, `.item` über Paired Items |
| `$node["Name"].json` | Altform, erstes bzw. gepaartes Item |
| `$items("Name", output?, run?)` | Altform |
| `$now`, `$today` | luxon `DateTime` in Workflow-Zeitzone (Default `Europe/Berlin`, per Setting/Env überschreibbar) |
| `$env` | Umgebungsvariablen (Allowlist per Config `FILUFLOW_ENV_ALLOW`, Default: alle mit Präfix `FL_`) |
| `$vars` | Werte aus `vars.json` |
| `$execution.id`, `.mode`, `.resumeUrl` | Execution-Infos |
| `$workflow.id`, `.name`, `.active` | Workflow-Infos |
| `$itemIndex`, `$runIndex`, `$prevNode.name` | Kontext |
| `$jmespath(obj, expr)` | JMESPath (Paket `jmespath`) |
| `$if(c, a, b)`, `$ifEmpty(v, fallback)`, `$min`, `$max` | Helfer |
| `DateTime`, `Duration`, `Interval` | luxon-Klassen |

### 3.3 Erweiterungsfunktionen
n8n ergänzt Strings, Zahlen, Arrays, Objekte und Daten um Methoden (z. B. `.isEmpty()`, `.toDateTime()`, `.extractDomain()`, `.toNumber()`, `.first()`, `.pluck()`, `.unique()`, `.sum()`, `.keys()`, `.format()`). Diese **nicht** über Prototype-Patching global einführen, sondern wie n8n per AST-Umschreibung der Expression (Paket `recast`/`acorn` o. ä.) auf Hilfsfunktionen umleiten. Liste und Semantik aus `packages/workflow/src/Extensions/` übernehmen (Verhalten nachbauen, nicht kopieren). Priorität: die Funktionen, die in den Fixtures vorkommen; Rest schrittweise. Fehlende Funktion = klarer `ExpressionError` mit Funktionsname.

### 3.4 Fehler
Fehlermeldungen enthalten Node-Name, Parameterpfad, Item-Index und die Expression. Zugriff auf nicht ausgeführte Nodes erzeugt dieselbe Art Fehler wie in n8n.

---

## 4. Nodes

Pro Node: unterstützte Versionen gegen n8n prüfen und mindestens die aktuelle Version **plus** die Version, die in den Fixtures vorkommt, implementieren.

### 4.1 Meilenstein M3a: Kern
| Typ | Hinweise |
|---|---|
| `n8n-nodes-base.manualTrigger` | liefert `[{json:{}}]` oder CLI-Input |
| `n8n-nodes-base.noOp` | durchreichen |
| `n8n-nodes-base.stickyNote` | ignorieren (nie ausführen, nicht im Graph) |
| `n8n-nodes-base.set` (v3.3+, plus v1/v2 Altformat) | `mode: manual/raw`, `assignments.assignments[] {name, value, type}`, `includeOtherFields`, `include: all/selected/except`, `options.dotNotation` (Default true), Typkonvertierung inkl. `ignoreConversionErrors` |
| `n8n-nodes-base.if` (v2.x) | `conditions` (Filter-Format, siehe 4.4), Ausgang 0 = true, 1 = false |
| `n8n-nodes-base.filter` (v2.x) | Filter-Format, ein Ausgang; `options.looseTypeValidation` |
| `n8n-nodes-base.switch` (v3.x) | `mode: rules/expression`, `rules.values[]`, `options.fallbackOutput` (`none`/`extra`/Index), `options.allMatchingOutputs`, `renameOutput` |
| `n8n-nodes-base.code` (v2) | `language: javaScript`, `python` und `pythonNative` (M12), `mode: runOnceForAllItems/runOnceForEachItem`, `jsCode`; im Kontext alle Expression-Variablen plus `items` (Altform); Rückgabe normalisieren (Objekte ohne `json` einpacken, Einzelobjekt in Liste); async erlaubt; Timeout konfigurierbar (Default 60 s); `console.log` ins Execution-Log |

### 4.2 Meilenstein M3b: Daten und HTTP
| Typ | Hinweise |
|---|---|
| `n8n-nodes-base.httpRequest` (v4.x) | `method`, `url`, `authentication` (`none`, `genericCredentialType` mit `httpHeaderAuth`/`httpBasicAuth`/`httpQueryAuth`/`httpBearerAuth`), `sendQuery`/`queryParameters`, `sendHeaders`/`headerParameters`, `sendBody` mit `contentType` json/form-urlencoded/multipart/raw/binaryData und `specifyBody` keypair/json, `options`: timeout, redirect, `response.response` (responseFormat autodetect/json/text/file, fullResponse, neverError), batching, allowUnauthorizedCerts, proxy, Pagination. Fetch über `undici`, Proxy aus `HTTPS_PROXY` respektieren |
| `n8n-nodes-base.merge` (v3.x) | `mode: append`, `combine` mit `combineBy: combineByFields/combineByPosition/combineAll`, `joinMode`, `chooseBranch`, `combineBySql`; `numberInputs` |
| `n8n-nodes-base.splitOut` | `fieldToSplitOut`, `include` |
| `n8n-nodes-base.aggregate` | `aggregateIndividualFields` / `aggregateAllItemData` |
| `n8n-nodes-base.splitInBatches` (v3, "Loop Over Items") | Ausgang 0 = done, 1 = loop; Zustand über Runs halten |
| `n8n-nodes-base.removeDuplicates`, `sort`, `limit`, `summarize` | Standardoptionen |
| `n8n-nodes-base.dateTime` (v2), `crypto`, `html` (extractHtmlContent mit cheerio), `xml` | häufig genutzte Operationen zuerst |
| `n8n-nodes-base.wait` | `timeInterval`, `specificTime`, Fortsetzen per Webhook und per Formular; lange Wartezeiten überstehen einen Neustart |
| `n8n-nodes-base.executeWorkflow` / `executeWorkflowTrigger` | Unter-Workflows aus dem Workflow-Verzeichnis per Name oder ID |
| `n8n-nodes-base.stopAndError` | Fehler werfen |

### 4.3 Meilenstein M5: Trigger (Server)
| Typ | Hinweise |
|---|---|
| `n8n-nodes-base.webhook` (v2) | `httpMethod`, `path`, `responseMode: onReceived/lastNode/responseNode`, `responseCode`, `responseData`, `options.rawBody`, Auth `none/basicAuth/headerAuth`. URL: `/webhook/<path>` (aktiv) und `/webhook-test/<path>` (nur bei laufendem Test). Item-Format wie n8n: `{headers, params, query, body}` |
| `n8n-nodes-base.respondToWebhook` | `respondWith: json/text/allIncomingItems/firstIncomingItem/noData/binary`, `responseCode`, Header |
| `n8n-nodes-base.scheduleTrigger` (v1.2) | `rule.interval[]` mit `field` seconds/minutes/hours/days/weeks/months/cronExpression; Zeitzone des Workflows; Ausgabe-Item mit Zeitstempel-Feldern wie n8n |
| `n8n-nodes-base.errorTrigger` | wird gestartet, wenn ein Workflow mit `settings.errorWorkflow` fehlschlägt |

### 4.4 Filter-Bedingungsformat (für IF, Filter, Switch)
```json
{ "options": { "caseSensitive": true, "typeValidation": "strict", "leftValue": "" },
  "conditions": [ { "id": "...", "leftValue": "={{ $json.x }}", "rightValue": 5,
                   "operator": { "type": "number", "operation": "gt", "singleValue": false } } ],
  "combinator": "and" }
```
Operatoren je Typ (`string`, `number`, `boolean`, `dateTime`, `array`, `object`): equals, notEquals, contains, notContains, startsWith, endsWith, regex, notRegex, gt, gte, lt, lte, after, before, exists, notExists, empty, notEmpty, true, false, lengthEquals, lengthGt, lengthLt usw. Vollständige Liste und Typvalidierung (strict vs. loose) aus `packages/workflow` (FilterParameter) nachbauen. **Eigene Testtabelle** mit allen Operator/Typ-Kombinationen inkl. Grenzfällen (null, undefined, "", Zahlstrings).

### 4.5 Meilenstein M7: KI-Nodes
Sub-Nodes sind über `ai_*`-Verbindungen **an** den Eltern-Node angeschlossen (Quelle = Sub-Node, Ziel = Eltern-Node). Sie werden nicht selbst ausgeführt, sondern vom Eltern-Node angefordert.
- Modelle: `@n8n/n8n-nodes-langchain.lmChatGoogleGemini`, `lmChatAnthropic`, `lmChatOpenAi` (direkte HTTP-Calls an die jeweilige API, kein LangChain nötig)
- `chainLlm` (Basic LLM Chain) mit `outputParserStructured` (JSON-Schema oder Beispiel-JSON)
- `informationExtractor`, `textClassifier`, `sentimentAnalysis`
- `agent` (Tools Agent) mit `toolCalculator`, `toolHttpRequest`, `toolCode`, `toolWorkflow`, `memoryBufferWindow`
- `chatTrigger` und `chat` (Human in the Loop) mit Chat-Ansicht in der Oberfläche
Ausgabeformate (`output`, `text` usw.) exakt wie n8n.

---

## 5. Credentials
- Datei `credentials.json` (oder Verzeichnis), Schlüssel = Credential-**Name** wie im Workflow (`node.credentials.<typ>.name`), Fallback auf ID.
- Werte dürfen `{{ env.NAME }}` referenzieren, damit Secrets in Env/Secret-Store bleiben.
- Optional verschlüsselt mit `FILUFLOW_ENCRYPTION_KEY` (AES-256-GCM).
- Typen: `httpHeaderAuth`, `httpBasicAuth`, `httpQueryAuth`, `httpBearerAuth`, `httpCustomAuth`, `jwtAuth`, `oAuth2Api` (alle Grant-Typen), dazu die Credentials der KI-Modelle und der Dienst-Knoten. Feldnamen wie in n8n (`packages/nodes-base/credentials/`).
- Fehlende Credentials: Validierung meldet sie vor dem Lauf.

---

## 6. Validierung (`filuflow validate`)
Prüft und meldet gesammelt (nicht beim ersten Fehler abbrechen):
- JSON-Struktur, doppelte Node-Namen, Verbindungen auf nicht existierende Nodes
- Unbekannte Node-Typen, nicht unterstützte `typeVersion`s, nicht unterstützte Parameterwerte (z. B. `mode: combineBySql`)
- `executionOrder` fehlt oder ist `v0`
- Expressions syntaktisch prüfen, Referenzen `$('X')` / `$node["X"]` auf existierende Nodes
- Fehlende Credentials
Ausgabe menschenlesbar oder `--json`. Exit-Code 0/1.

---

## 7. CLI
```
filuflow validate <wf.json> [--json]
filuflow run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
filuflow serve [--dir ./workflows] [--port 5678] [--db ./filuflow.db]
filuflow executions list|show <id> [--json]
filuflow nodes            # Liste unterstützter Node-Typen und Versionen
```
`run` gibt standardmäßig eine Übersicht pro Node aus (Items, Dauer, Fehler) und mit `--json` die vollständigen `runData`.

---

## 8. Server (`filuflow serve`)
- Lädt alle `*.json` aus `--dir`, beobachtet Änderungen (Hot Reload).
- Workflows mit `active: true` registrieren Webhooks und Schedules.
- REST-API (JSON, Auth über statischen API-Key `FILUFLOW_API_KEY` im Header `X-API-Key`):
  - `GET /api/workflows`, `GET /api/workflows/:id`
  - `POST /api/workflows/:id/run` (Body = Input-Items)
  - `GET /api/executions?workflow=&status=&limit=`, `GET /api/executions/:id`, `POST /api/executions/:id/cancel`
  - `GET /healthz`
- Webhooks unter `/webhook/...` ohne API-Key (eigene Auth laut Node).
- Execution-Log in SQLite: Tabelle `executions` (Metadaten) und `execution_data` (runData als JSON, komprimiert). Aufbewahrung konfigurierbar (`FILUFLOW_PRUNE_DAYS`, Default 14).
- Parallelität: Konfigurierbares Limit gleichzeitiger Executions (Default 5), Warteschlange in-process.
- Docker: `Dockerfile` (Node 22 slim, non-root) und `docker-compose.yml` mit Volume für Workflows, DB, Credentials.

---

## 9. Tests und Kompatibilitätsnachweis

### 9.1 Unit-Tests
Engine-Reihenfolge, Expressions (inkl. Rohwert vs. String), jeder Node, Filter-Operatoren, Paired Items, Fehlerbehandlung.

### 9.2 Golden-Tests (`npm run test:compat`)
- `fixtures/<name>/workflow.json`, optional `input.json`, `expected.json` (Ausgabe-Items je Node).
- `expected.json` stammt aus **echtem n8n**: Skript `scripts/record-expected.sh` startet n8n per Docker (`docker.n8n.io/n8nio/n8n`, Version gepinnt), importiert den Workflow (`n8n import:workflow`), führt ihn aus (`n8n execute`, Optionen der gepinnten Version prüfen) und speichert die Items. Falls Docker in der Umgebung fehlt: Skript trotzdem schreiben, `expected.json` von Hand erzeugen lassen und das in `docs/STATUS.md` vermerken.
- Vergleich ignoriert volatile Felder (Zeitstempel, IDs), konfigurierbar pro Fixture in `fixtures/<name>/ignore.json`.
- Fixtures für externe HTTP-Calls: Requests über einen lokalen Mock-Server (oder `undici` MockAgent) mit aufgezeichneten Antworten, damit Tests offline laufen.

### 9.3 Pflicht-Fixtures
1. Lineare Kette Manual → Set → Code → IF mit beiden Zweigen
2. Fan-out auf drei Zweige, Reihenfolge nach Position, Merge (append und combineByPosition)
3. `$('Node').item` über Paired Items nach Code-Node mit gleicher und abweichender Itemzahl
4. HTTP-Kette (Geocoding → Wetter) mit Mock-Antworten, pro Item
5. Loop Over Items mit Batchgröße 2 über 5 Items
6. Fehlerfälle: `continueRegularOutput`, `continueErrorOutput`, `retryOnFail`
7. Switch mit `fallbackOutput: extra` und `allMatchingOutputs`
8. Webhook mit `responseMode: responseNode`
9. Die bestehenden Workflows aus dem Repo-Ordner `fixtures/real/` (vom Nutzer bereitgestellte Exporte, z. B. Phishing-Triage). Für nicht unterstützte Nodes darin: `validate` muss sie korrekt melden.

---

## 10. Meilensteine
| # | Inhalt | Fertig, wenn |
|---|---|---|
| M0 | Gerüst: package.json, tsconfig strict, eslint, vitest, Ordnerstruktur, `docs/STATUS.md`, `docs/DECISIONS.md` | `npm test` und `npm run lint` grün |
| M1 | Typen, Loader, Validator, `filuflow validate`, `filuflow nodes` | Validierung meldet alle Fehlerklassen aus Abschnitt 6, Tests |
| M2 | Engine (v1-Reihenfolge, pinData, disabled, alwaysOutputData, executeOnce, onError, retry) + Expression-Engine ohne Erweiterungsfunktionen | Engine-Tests mit Fake-Nodes grün |
| M3a | Kern-Nodes + Filter-Format | Fixtures 1, 3, 6, 7 grün |
| M3b | HTTP, Merge, Split/Aggregate, Loop, Rest aus 4.2 | Fixtures 2, 4, 5 grün |
| M3c | Expression-Erweiterungsfunktionen | Funktionen aus allen Fixtures abgedeckt |
| M4 | CLI `run`, Ausgabeformate | Alle Fixtures über CLI ausführbar |
| M5 | Server, Webhooks, Schedules, REST-API, SQLite-Log, Docker | Fixture 8 grün, Smoke-Test per curl dokumentiert |
| M6 | Credentials | HTTP mit Header-/Basic-Auth gegen Mock getestet |
| M7 | KI-Nodes | Basic LLM Chain + Structured Output Parser gegen gemockte Gemini-API |
| M8 | Weboberfläche mit Workflow-Editor | Editor, Ausführungen und Credentials-Übersicht im Browser, Browser-Test |
| M9 | Master und Worker: Benutzer, Rechte, Projekte, Mandanten, SSO | Integrationstests mit echten Workern, OIDC gegen nachgebauten Identity Provider |
| M10 | Name filuflow und Design | Oberfläche nach dem Design-Handoff, alte Namen gelten weiter |
| M11 | Credentials in der Oberfläche | Anlegen, Bearbeiten, Umbenennen, Löschen mit Formularen je Typ, im Einzelbetrieb und im Master; geheime Werte nie lesbar |
| M12 | Python im Code-Node | Pyodide und lokaler Interpreter, Zeitlimit, Sperren wie n8n, Code Tool mit Python |
| M13 | Wartende Ausführungen | Wait mit Fortsetzen per Webhook und zum Zeitpunkt, Zustand in SQLite, statische Daten und OAuth2-Tokens dauerhaft |
| M14 | OAuth2 mit Anmeldung | Authorization Code und PKCE mit Rückleitung, Refresh, Einzelbetrieb und Master |
| M15 | HTTP Request erweitert | Pagination in allen Modi wie n8n, Digest-Auth, Client-Zertifikate |
| M16 | Chat Trigger | Webhooks wie n8n, gehostete Chat-Seite, Chat-Fenster im Editor, Basic Auth, frühere Nachrichten aus dem Memory |
| M17 | Formulare | Form Trigger, Form-Knoten mit Folgeseiten und Abschluss, Wait per Formular |
| M18 | Testdaten, Variablen, Teilausführung | pinData per Klick, Variablen-Seite, "Bis hier ausführen", "Auf Test-Aufruf warten", Expressions in Webhook-Parametern |
| M19 | Parameterformulare je Knotentyp | Formular aus der Beschreibung je Knotentyp neben Baum und JSON, Sichtbarkeit und Defaults wie n8n |
| M20 | Knoten-Ausbau | Merge per SQL, Execute Workflow aus Datei und URL, require mit Freigabeliste, Execution-Order v0 |
| M21 | Streaming | Webhook, Respond to Webhook, Chat Trigger und AI Agent mit gestreamten Antworten wie n8n |
| M22a | Chat mit Antwortknoten | Respond to Chat und Respond to Webhook im Chat, Warten auf die Antwort des Nutzers |
| M22 | Credentials aus n8n, Teilen, OAuth1 | Import verschlüsselter n8n-Exporte, Freigabe für Projekte im Master, OAuth1 mit Verbinden |
| M23 | Rollen je Workflow, zentrale Suche | Eigene Rollen für einzelne Workflows, Freigabe an Gäste, Ausführungen aller Worker durchsuchen |
| M24 | Plugin-Schnittstelle | Eigene Knoten als JavaScript-Modul, Knoten und Credentials im n8n-Format (programmatisch) |
| M25 | Code-Helfer, vordefinierte Credentials | helpers im Code-Knoten wie n8n, HTTP Request mit vordefinierten Credential-Typen |
| M26 | KI-Ausbau | OpenAI Responses API, Groq, Mistral, Ollama, DeepSeek, OpenRouter, Azure OpenAI, Think Tool |
| M27 | Embeddings und Vektorspeicher (RAG) | OpenAI Embeddings, Default Data Loader, Text Splitter, Simple Vector Store, Retriever, Q&A Chain, Vector Store Tool |
| M28 | OAuth2-Typen der Dienste | Credential-Typen mit extends und festen Werten (Google, Microsoft, Slack, GitHub u. a.), Verbinden, Dienst-Eigenheiten von requestOAuth2 |
| M29 | Deklarative Knoten | Community-Knoten mit requestDefaults und routing wie n8n RoutingNode |
| M30 | Community-Pakete installieren | Installieren, Aktualisieren, Entfernen aus der Oberfläche und per API, auch beim Worker über den Master |
| M31 | Poll- und Trigger-Knoten aus Paketen | Aktivierung mit Poll Times und emit wie n8n, manueller Lauf, Fehler-Workflow, Neustart nach Fehlern |
| M32 | Webhook-Knoten aus Paketen | Pfade und Antwortmodi wie n8n, WebhookContext, Anmeldung beim Dienst (webhookMethods), Test-URL |
| M33 | Gemeinsame Credentials | Ein Credential im Master, verteilt an mehrere Worker, mit Abgleich |

Nach jedem Meilenstein: `docs/STATUS.md` aktualisieren (was geht, was fehlt) und einen Commit mit aussagekräftiger Nachricht.

---

## 11. Ausbau
Offene Funktionen, ungefähr nach Nutzen geordnet. Jede wird wie ein Meilenstein umgesetzt (Tests, `docs/STATUS.md`, Commit).

### 11.1 Ausführung und Server
(Expressions in Webhook-Parametern, Teilausführung bis zu einem Knoten, "Auf Test-Aufruf warten": M18; Execution-Order v0: M20; Streaming: M21)
- Skalierung über mehrere Prozesse (Warteschlange, z. B. Redis) für hohe Last

### 11.2 Knoten
- Weitere Credential-Typen der Dienste (API-Keys mit authenticate, Google Service Account mit JWT)
  (helpers im Code-Node und vordefinierte Credential-Typen im HTTP Request: M25; OAuth2-Typen mit festen URLs: M28)
- KI: Agent-Varianten aus typeVersion 1.x, weitere Modelle (z. B. AWS Bedrock, Vertex), weitere Embeddings und
  Vektorspeicher (z. B. PGVector, Qdrant), Dateien wie PDF im Data Loader
  (Responses API, Groq, Mistral, Ollama, DeepSeek, OpenRouter, Azure OpenAI, Think Tool: M26; Embeddings, Simple Vector
  Store, Retriever, Q&A Chain: M27)
- Dienst-Knoten mit eigenen OAuth-Flows (Gmail, Slack, Microsoft 365 usw.) und weitere Integrationen
- Community-Nodes: KI-Sub-Nodes aus n8n-Paketen (Plugin-Schnittstelle und programmatische Knoten: M24; deklarative
  Knoten: M29; Installation aus der Oberfläche: M30; Poll- und Trigger-Knoten: M31; Webhook-Knoten: M32)

### 11.3 Credentials
(Anlegen und Bearbeiten in der Oberfläche: M11; Import verschlüsselter n8n-Exporte und Freigabe für Projekte im Master: M22;
gemeinsame Credentials für mehrere Worker: M33)

### 11.4 Oberfläche und Master
(Testdaten per Klick, Variablen-Seite: M18; Chat-Ansicht: M16; Parameterformulare: M19; Rollen je Workflow und zentrale
Ausführungssuche: M23)
- Frei definierbare Rollen mit einzelnen Rechten (heute feste Rollen Lesen, Bearbeiten, Verwalten/Projekt-Admin)
