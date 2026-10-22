# filuflow specification

filuflow is a standalone workflow platform: engine, browser editor, CLI, server with webhooks and schedules,
execution log, credentials, AI nodes, and multi-user and multi-tenant operation with master and workers. The scope is
not limited; what is still missing is listed as planned work in section 11.

Workflows use the n8n workflow format. Workflows that run in n8n (current 1.x) produce the same items at the same nodes
in filuflow; the golden tests ensure this (section 9). The parameter details below are the starting point. Before
implementing a node in n8n format, check it against `packages/nodes-base/nodes/<Node>/` in the n8n repo.

---

## 1. Data model

### 1.1 Workflow JSON (input, unchanged from n8n export)
```ts
interface Workflow {
  id?: string; name: string; active?: boolean;
  nodes: WorkflowNode[];
  connections: Record<string /*source node name*/, Record<ConnectionType, Array<Array<Connection> | null>>>;
  settings?: { executionOrder?: "v0" | "v1"; timezone?: string; errorWorkflow?: string };
  pinData?: Record<string /*node name*/, Array<{ json: object }>>;
}
interface WorkflowNode {
  id: string; name: string; type: string; typeVersion: number;
  position: [number, number]; parameters: Record<string, unknown>;
  credentials?: Record<string /*credential type*/, { id?: string; name: string }>;
  disabled?: boolean; alwaysOutputData?: boolean; executeOnce?: boolean;
  retryOnFail?: boolean; maxTries?: number; waitBetweenTries?: number;
  onError?: "stopWorkflow" | "continueRegularOutput" | "continueErrorOutput";
  continueOnFail?: boolean; // legacy form of onError
  notes?: string;
}
interface Connection { node: string; type: ConnectionType; index: number }
type ConnectionType = "main" | "ai_languageModel" | "ai_memory" | "ai_tool" | "ai_outputParser" | string;
```
Connections are addressed **by node name**, not by ID. `connections[src].main[outputIndex]` is the list of targets of that output.

### 1.2 Items
```ts
interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, BinaryRef>;
  pairedItem?: { item: number; input?: number } | Array<{ item: number; input?: number }>;
  error?: { message: string; [k: string]: unknown }; // with onError=continue*
}
type NodeOutput = Item[][]; // index = output (IF: 0=true, 1=false)
```
`BinaryRef`: `{ mimeType, fileName?, fileExtension?, fileSize?, data | id }`. Store binary data over 1 MB in a file store, with only the reference in the item.

### 1.3 Execution result (compatible with n8n `runData`)
```ts
interface Execution {
  id: string; workflowName: string; mode: "manual" | "cli" | "webhook" | "trigger";
  startedAt: string; stoppedAt?: string; status: "running" | "success" | "error" | "canceled";
  runData: Record<string /*node name*/, Array<TaskData>>; // multiple entries for loops
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

### 2.1 Flow
1. Load the workflow, validate it (section 6).
2. Determine the start node: an explicitly given trigger, otherwise the only trigger, otherwise an error.
3. Execution in **v1 order** (v0 is planned work, see section 11):
   - Stack-based: a node runs as soon as its input data is available. A branch is executed completely to the end before the next branch starts.
   - Order of parallel children: by canvas position (top before bottom, then left before right). Look up the exact sorting in `packages/core` (WorkflowExecute) and rebuild it.
   - Nodes with multiple inputs (Merge): wait until no predecessor can deliver data anymore. If an input never received data, the node behaves like n8n v1 (look it up, write a test case for it).
4. If a node delivers 0 items on an output, its successors do **not** run, unless `alwaysOutputData: true` (then an empty item `{json:{}}`).
5. `pinData` for a node: the node is not executed, the pinned items count as its output (output 0).
6. `disabled: true`: the node is passed through (input 0 goes unchanged to output 0).
7. `executeOnce: true`: the node only receives the first item.
8. Error handling per node:
   - `retryOnFail`: up to `maxTries` (default 3) with `waitBetweenTries` ms (default 1000).
   - `onError = stopWorkflow` (default): execution `error`, abort.
   - `continueRegularOutput`: items with `json.error` on the regular output.
   - `continueErrorOutput`: the node gets an additional error output (last index), failed items go there.
9. Loops via `Loop Over Items` (splitInBatches v3) must work; this results in multiple `TaskData` per node and `$runIndex`.
10. Cancellation: an execution can be cancelled via API/signal; running HTTP requests via `AbortSignal`.

### 2.2 Paired items
Carry `pairedItem` along so that `$('Node').item` finds the item of an earlier node that belongs to the current item. Rules:
- 1:1 nodes (Set, IF, Filter, HTTP per item): set `pairedItem = { item: i }` automatically if the node does not set one.
- Code node: takes what the code returns; if it is missing and the number of items is equal, index mapping as a fallback; otherwise throw an error like n8n ("paired item data unavailable") on `.item` access.
- Aggregating nodes: array of source items.

### 2.3 Node interface
```ts
interface NodeType {
  type: string;                 // e.g. "n8n-nodes-base.set"
  versions: number[];           // supported typeVersions
  isTrigger?: boolean;
  outputs(node: WorkflowNode): number;   // may depend on parameters (Switch, onError)
  execute(ctx: ExecContext): Promise<NodeOutput>;
}
interface ExecContext {
  node: WorkflowNode; inputs: Item[][]; runIndex: number;
  getParam<T>(path: string, itemIndex: number, fallback?: T): T; // evaluates expressions
  getCredentials(type: string): Promise<Record<string, unknown>>;
  helpers: { http: HttpClient; binary: BinaryStore };
  signal: AbortSignal; logger: Logger;
}
```
`getParam` evaluates expressions **per item**. This is the most important compatibility point.

---

## 3. Expressions

### 3.1 Syntax
- A parameter value is an expression if it is a string starting with `=`.
- Inside: text with `{{ ... }}` segments. If the whole value consists of exactly one segment, the **raw value** (number, object, array, boolean) is returned, otherwise string concatenation (objects as JSON).
- Evaluation as JavaScript in a `node:vm` context with a timeout (default 1000 ms).
- Evaluate nested parameters (objects, arrays in `parameters`) recursively.

### 3.2 Variables (required)
| Variable | Meaning |
|---|---|
| `$json` | JSON of the current item |
| `$binary` | binary data of the current item |
| `$input.item`, `.all()`, `.first()`, `.last()`, `.params` | input of the current node |
| `$('Name').item`, `.all(branch?, run?)`, `.first()`, `.last()`, `.itemMatching(i)`, `.isExecuted` | output of an earlier node, `.item` via paired items |
| `$node["Name"].json` | legacy form, first or paired item |
| `$items("Name", output?, run?)` | legacy form |
| `$now`, `$today` | luxon `DateTime` in the workflow time zone (default `Europe/Berlin`, can be overridden via setting/env) |
| `$env` | environment variables (allowlist via config `FILUFLOW_ENV_ALLOW`, default: all with prefix `FL_`) |
| `$vars` | values from `vars.json` |
| `$execution.id`, `.mode`, `.resumeUrl` | execution info |
| `$workflow.id`, `.name`, `.active` | workflow info |
| `$itemIndex`, `$runIndex`, `$prevNode.name` | context |
| `$jmespath(obj, expr)` | JMESPath (package `jmespath`) |
| `$if(c, a, b)`, `$ifEmpty(v, fallback)`, `$min`, `$max` | helpers |
| `DateTime`, `Duration`, `Interval` | luxon classes |

### 3.3 Extension functions
n8n adds methods to strings, numbers, arrays, objects and dates (e.g. `.isEmpty()`, `.toDateTime()`, `.extractDomain()`, `.toNumber()`, `.first()`, `.pluck()`, `.unique()`, `.sum()`, `.keys()`, `.format()`). Do **not** introduce these globally via prototype patching; instead, like n8n, redirect them to helper functions by rewriting the expression's AST (package `recast`/`acorn` or similar). Take the list and semantics from `packages/workflow/src/Extensions/` (rebuild the behavior, do not copy). Priority: the functions that appear in the fixtures; the rest step by step. Missing function = clear `ExpressionError` with the function name.

### 3.4 Errors
Error messages contain node name, parameter path, item index and the expression. Accessing nodes that have not been executed produces the same kind of error as in n8n.

---

## 4. Nodes

Per node: check the supported versions against n8n and implement at least the current version **plus** the version that appears in the fixtures.

### 4.1 Milestone M3a: core
| Type | Notes |
|---|---|
| `n8n-nodes-base.manualTrigger` | returns `[{json:{}}]` or CLI input |
| `n8n-nodes-base.noOp` | pass through |
| `n8n-nodes-base.stickyNote` | ignore (never execute, not in the graph) |
| `n8n-nodes-base.set` (v3.3+, plus v1/v2 legacy format) | `mode: manual/raw`, `assignments.assignments[] {name, value, type}`, `includeOtherFields`, `include: all/selected/except`, `options.dotNotation` (default true), type conversion including `ignoreConversionErrors` |
| `n8n-nodes-base.if` (v2.x) | `conditions` (filter format, see 4.4), output 0 = true, 1 = false |
| `n8n-nodes-base.filter` (v2.x) | filter format, one output; `options.looseTypeValidation` |
| `n8n-nodes-base.switch` (v3.x) | `mode: rules/expression`, `rules.values[]`, `options.fallbackOutput` (`none`/`extra`/index), `options.allMatchingOutputs`, `renameOutput` |
| `n8n-nodes-base.code` (v2) | `language: javaScript`, `python` and `pythonNative` (M12), `mode: runOnceForAllItems/runOnceForEachItem`, `jsCode`; in the context all expression variables plus `items` (legacy form); normalize the return value (wrap objects without `json`, single object into a list); async allowed; configurable timeout (default 60 s); `console.log` into the execution log |

### 4.2 Milestone M3b: data and HTTP
| Type | Notes |
|---|---|
| `n8n-nodes-base.httpRequest` (v4.x) | `method`, `url`, `authentication` (`none`, `genericCredentialType` with `httpHeaderAuth`/`httpBasicAuth`/`httpQueryAuth`/`httpBearerAuth`), `sendQuery`/`queryParameters`, `sendHeaders`/`headerParameters`, `sendBody` with `contentType` json/form-urlencoded/multipart/raw/binaryData and `specifyBody` keypair/json, `options`: timeout, redirect, `response.response` (responseFormat autodetect/json/text/file, fullResponse, neverError), batching, allowUnauthorizedCerts, proxy, pagination. Fetch via `undici`, respect proxy from `HTTPS_PROXY` |
| `n8n-nodes-base.merge` (v3.x) | `mode: append`, `combine` with `combineBy: combineByFields/combineByPosition/combineAll`, `joinMode`, `chooseBranch`, `combineBySql`; `numberInputs` |
| `n8n-nodes-base.splitOut` | `fieldToSplitOut`, `include` |
| `n8n-nodes-base.aggregate` | `aggregateIndividualFields` / `aggregateAllItemData` |
| `n8n-nodes-base.splitInBatches` (v3, "Loop Over Items") | output 0 = done, 1 = loop; keep state across runs |
| `n8n-nodes-base.removeDuplicates`, `sort`, `limit`, `summarize` | standard options |
| `n8n-nodes-base.dateTime` (v2), `crypto`, `html` (extractHtmlContent with cheerio), `xml` | frequently used operations first |
| `n8n-nodes-base.wait` | `timeInterval`, `specificTime`, resuming via webhook and via form; long wait times survive a restart |
| `n8n-nodes-base.executeWorkflow` / `executeWorkflowTrigger` | sub-workflows from the workflow directory by name or ID |
| `n8n-nodes-base.stopAndError` | throw an error |

### 4.3 Milestone M5: triggers (server)
| Type | Notes |
|---|---|
| `n8n-nodes-base.webhook` (v2) | `httpMethod`, `path`, `responseMode: onReceived/lastNode/responseNode`, `responseCode`, `responseData`, `options.rawBody`, auth `none/basicAuth/headerAuth`. URL: `/webhook/<path>` (active) and `/webhook-test/<path>` (only during a running test). Item format like n8n: `{headers, params, query, body}` |
| `n8n-nodes-base.respondToWebhook` | `respondWith: json/text/allIncomingItems/firstIncomingItem/noData/binary`, `responseCode`, headers |
| `n8n-nodes-base.scheduleTrigger` (v1.2) | `rule.interval[]` with `field` seconds/minutes/hours/days/weeks/months/cronExpression; workflow time zone; output item with timestamp fields like n8n |
| `n8n-nodes-base.errorTrigger` | started when a workflow with `settings.errorWorkflow` fails |

### 4.4 Filter condition format (for IF, Filter, Switch)
```json
{ "options": { "caseSensitive": true, "typeValidation": "strict", "leftValue": "" },
  "conditions": [ { "id": "...", "leftValue": "={{ $json.x }}", "rightValue": 5,
                   "operator": { "type": "number", "operation": "gt", "singleValue": false } } ],
  "combinator": "and" }
```
Operators per type (`string`, `number`, `boolean`, `dateTime`, `array`, `object`): equals, notEquals, contains, notContains, startsWith, endsWith, regex, notRegex, gt, gte, lt, lte, after, before, exists, notExists, empty, notEmpty, true, false, lengthEquals, lengthGt, lengthLt etc. Rebuild the complete list and type validation (strict vs. loose) from `packages/workflow` (FilterParameter). **Own test table** with all operator/type combinations including edge cases (null, undefined, "", numeric strings).

### 4.5 Milestone M7: AI nodes
Sub-nodes are connected **to** the parent node via `ai_*` connections (source = sub-node, target = parent node). They are not executed themselves but requested by the parent node.
- Models: `@n8n/n8n-nodes-langchain.lmChatGoogleGemini`, `lmChatAnthropic`, `lmChatOpenAi` (direct HTTP calls to the respective API, no LangChain needed)
- `chainLlm` (Basic LLM Chain) with `outputParserStructured` (JSON schema or example JSON)
- `informationExtractor`, `textClassifier`, `sentimentAnalysis`
- `agent` (Tools Agent) with `toolCalculator`, `toolHttpRequest`, `toolCode`, `toolWorkflow`, `memoryBufferWindow`
- `chatTrigger` and `chat` (human in the loop) with a chat view in the interface
Output formats (`output`, `text` etc.) exactly like n8n.

---

## 5. Credentials
- File `credentials.json` (or directory), key = credential **name** as in the workflow (`node.credentials.<type>.name`), fallback to ID.
- Values may reference `{{ env.NAME }}` so that secrets stay in env/secret store.
- Optionally encrypted with `FILUFLOW_ENCRYPTION_KEY` (AES-256-GCM).
- Types: `httpHeaderAuth`, `httpBasicAuth`, `httpQueryAuth`, `httpBearerAuth`, `httpCustomAuth`, `jwtAuth`, `oAuth2Api` (all grant types), plus the credentials of the AI models and the service nodes. Field names as in n8n (`packages/nodes-base/credentials/`).
- Missing credentials: validation reports them before the run.

---

## 6. Validation (`filuflow validate`)
Checks and reports collectively (does not stop at the first error):
- JSON structure, duplicate node names, connections to non-existent nodes
- Unknown node types, unsupported `typeVersion`s, unsupported parameter values (e.g. `mode: combineBySql`)
- `executionOrder` missing or `v0`
- Syntax check of expressions, references `$('X')` / `$node["X"]` to existing nodes
- Missing credentials
Output human-readable or `--json`. Exit code 0/1.

---

## 7. CLI
```
filuflow validate <wf.json> [--json]
filuflow run <wf.json> [--input items.json] [--trigger "Node-Name"] [--json] [--only-last] [--no-pin]
filuflow serve [--dir ./workflows] [--port 5678] [--db ./filuflow.db]
filuflow executions list|show <id> [--json]
filuflow nodes            # list of supported node types and versions
```
By default `run` prints a summary per node (items, duration, errors) and with `--json` the complete `runData`.

---

## 8. Server (`filuflow serve`)
- Loads all `*.json` from `--dir`, watches for changes (hot reload).
- Workflows with `active: true` register webhooks and schedules.
- REST API (JSON, auth via static API key `FILUFLOW_API_KEY` in the `X-API-Key` header):
  - `GET /api/workflows`, `GET /api/workflows/:id`
  - `POST /api/workflows/:id/run` (body = input items)
  - `GET /api/executions?workflow=&status=&limit=`, `GET /api/executions/:id`, `POST /api/executions/:id/cancel`
  - `GET /healthz`
- Webhooks under `/webhook/...` without API key (own auth per node).
- Execution log in SQLite: table `executions` (metadata) and `execution_data` (runData as JSON, compressed). Retention configurable (`FILUFLOW_PRUNE_DAYS`, default 14).
- Concurrency: configurable limit of simultaneous executions (default 5), in-process queue.
- Docker: `Dockerfile` (Node 22 slim, non-root) and `docker-compose.yml` with a volume for workflows, DB, credentials.

---

## 9. Tests and proof of compatibility

### 9.1 Unit tests
Engine order, expressions (including raw value vs. string), every node, filter operators, paired items, error handling.

### 9.2 Golden tests (`npm run test:compat`)
- `fixtures/<name>/workflow.json`, optional `input.json`, `expected.json` (output items per node).
- `expected.json` comes from **real n8n**: the script `scripts/record-expected.sh` starts n8n via Docker (`docker.n8n.io/n8nio/n8n`, version pinned), imports the workflow (`n8n import:workflow`), runs it (`n8n execute`, check the options of the pinned version) and saves the items. If Docker is missing in the environment: write the script anyway, have `expected.json` created by hand and note this in `docs/STATUS.md`.
- The comparison ignores volatile fields (timestamps, IDs), configurable per fixture in `fixtures/<name>/ignore.json`.
- Fixtures for external HTTP calls: requests via a local mock server (or `undici` MockAgent) with recorded responses, so tests run offline.

### 9.3 Required fixtures
1. Linear chain Manual → Set → Code → IF with both branches
2. Fan-out to three branches, order by position, Merge (append and combineByPosition)
3. `$('Node').item` via paired items after a Code node with equal and differing item counts
4. HTTP chain (geocoding → weather) with mock responses, per item
5. Loop Over Items with batch size 2 over 5 items
6. Error cases: `continueRegularOutput`, `continueErrorOutput`, `retryOnFail`
7. Switch with `fallbackOutput: extra` and `allMatchingOutputs`
8. Webhook with `responseMode: responseNode`
9. The existing workflows from the repo folder `fixtures/real/` (exports provided by the user, e.g. phishing triage). For unsupported nodes in them: `validate` must report them correctly.

---

## 10. Milestones
| # | Content | Done when |
|---|---|---|
| M0 | Scaffold: package.json, tsconfig strict, eslint, vitest, folder structure, `docs/STATUS.md`, `docs/DECISIONS.md` | `npm test` and `npm run lint` green |
| M1 | Types, loader, validator, `filuflow validate`, `filuflow nodes` | Validation reports all error classes from section 6, tests |
| M2 | Engine (v1 order, pinData, disabled, alwaysOutputData, executeOnce, onError, retry) + expression engine without extension functions | Engine tests with fake nodes green |
| M3a | Core nodes + filter format | Fixtures 1, 3, 6, 7 green |
| M3b | HTTP, Merge, Split/Aggregate, Loop, rest of 4.2 | Fixtures 2, 4, 5 green |
| M3c | Expression extension functions | Functions from all fixtures covered |
| M4 | CLI `run`, output formats | All fixtures runnable via CLI |
| M5 | Server, webhooks, schedules, REST API, SQLite log, Docker | Fixture 8 green, smoke test via curl documented |
| M6 | Credentials | HTTP with header/Basic auth tested against mock |
| M7 | AI nodes | Basic LLM Chain + Structured Output Parser against mocked Gemini API |
| M8 | Web interface with workflow editor | Editor, executions and credentials overview in the browser, browser test |
| M9 | Master and worker: users, permissions, projects, tenants, SSO | Integration tests with real workers, OIDC against a simulated identity provider |
| M10 | Name filuflow and design | Interface following the design handoff, old names still work |
| M11 | Credentials in the interface | Create, edit, rename, delete with forms per type, on single server and in master; secret values never readable |
| M12 | Python in the Code node | Pyodide and local interpreter, time limit, blocks like n8n, Code Tool with Python |
| M13 | Waiting executions | Wait with resume via webhook and at a point in time, state in SQLite, static data and OAuth2 tokens persistent |
| M14 | OAuth2 with sign-in | Authorization code and PKCE with redirect, refresh, single server and master |
| M15 | HTTP Request extended | Pagination in all modes like n8n, Digest auth, client certificates |
| M16 | Chat Trigger | Webhooks like n8n, hosted chat page, chat window in the editor, Basic auth, previous messages from memory |
| M17 | Forms | Form Trigger, Form node with follow-up pages and completion, Wait via form |
| M18 | Test data, variables, partial execution | pinData by click, Variables page, "Execute up to here", "Wait for test call", expressions in webhook parameters |
| M19 | Parameter forms per node type | Form from the description per node type next to tree and JSON, visibility and defaults like n8n |
| M20 | Node expansion | Merge via SQL, Execute Workflow from file and URL, require with allowlist, execution order v0 |
| M21 | Streaming | Webhook, Respond to Webhook, Chat Trigger and AI Agent with streamed responses like n8n |
| M22a | Chat with response nodes | Respond to Chat and Respond to Webhook in chat, waiting for the user's reply |
| M22 | Credentials from n8n, sharing, OAuth1 | Import of encrypted n8n exports, sharing with projects in the master, OAuth1 with connect |
| M23 | Roles per workflow, central search | Own roles for individual workflows, sharing with guests, searching executions of all workers |
| M24 | Plugin interface | Own nodes as JavaScript modules, nodes and credentials in n8n format (programmatic) |
| M25 | Code helpers, predefined credentials | helpers in the Code node like n8n, HTTP Request with predefined credential types |
| M26 | AI expansion | OpenAI Responses API, Groq, Mistral, Ollama, DeepSeek, OpenRouter, Azure OpenAI, Think Tool |
| M27 | Embeddings and vector stores (RAG) | OpenAI Embeddings, Default Data Loader, Text Splitter, Simple Vector Store, Retriever, Q&A Chain, Vector Store Tool |
| M28 | OAuth2 types of services | Credential types with extends and fixed values (Google, Microsoft, Slack, GitHub and others), connect, service quirks of requestOAuth2 |
| M29 | Declarative nodes | Community nodes with requestDefaults and routing like n8n RoutingNode |
| M30 | Installing community packages | Install, update, remove from the interface and via API, also on the worker via the master |
| M31 | Poll and trigger nodes from packages | Activation with Poll Times and emit like n8n, manual run, error workflow, restart after errors |
| M32 | Webhook nodes from packages | Paths and response modes like n8n, WebhookContext, registration with the service (webhookMethods), test URL |
| M33 | Shared credentials | One credential in the master, distributed to multiple workers, with sync |
| M34 | Custom roles | Roles with freely chosen permissions for projects and individual workflows |
| M35 | Supervisor: Observe | Fixed rules, capturing and analyzing failed executions, "Supervisor" page with findings, reports and settings (section 12) |
| M36 | Supervisor: Improve | Proposals as a diff, validated before display, test run on request, accepting saves, dismissing discards |
| M37 | Supervisor: Create | Supervisor chat in the editor, new workflow from a description with a validate-and-fix loop, inactive as a proposal |
| M38 | Supervisor in the master | Supervisor per worker via the master, proposals create versions in the master, permissions "View Supervisor" and "Accept proposals" |
| M39 | English by default, German selectable | Code, docs, server, CLI and API messages in English; web interface in English with German as a per-browser option, including node and credential labels; Supervisor language setting |

After each milestone: update `docs/STATUS.md` (what works, what is missing) and make a commit with a meaningful message.

---

## 11. Planned work
Open features, roughly ordered by benefit. Each is implemented like a milestone (tests, `docs/STATUS.md`, commit).

### 11.1 Execution and server
(Expressions in webhook parameters, partial execution up to a node, "Wait for test call": M18; execution order v0: M20; streaming: M21)
- Scaling across multiple processes (queue, e.g. Redis) for high load

### 11.2 Nodes
- More credential types of services (API keys with authenticate, Google service account with JWT)
  (helpers in the Code node and predefined credential types in HTTP Request: M25; OAuth2 types with fixed URLs: M28)
- AI: agent variants from typeVersion 1.x, more models (e.g. AWS Bedrock, Vertex), more embeddings and
  vector stores (e.g. PGVector, Qdrant), files such as PDF in the Data Loader
  (Responses API, Groq, Mistral, Ollama, DeepSeek, OpenRouter, Azure OpenAI, Think Tool: M26; Embeddings, Simple Vector
  Store, Retriever, Q&A Chain: M27)
- Service nodes with their own OAuth flows (Gmail, Slack, Microsoft 365 etc.) and more integrations
- Community nodes: AI sub-nodes from n8n packages (plugin interface and programmatic nodes: M24; declarative
  nodes: M29; installation from the interface: M30; poll and trigger nodes: M31; webhook nodes: M32)

### 11.3 Credentials
(Creating and editing in the interface: M11; import of encrypted n8n exports and sharing with projects in the master: M22;
shared credentials for multiple workers: M33)

### 11.4 Interface and master
(Test data by click, Variables page: M18; chat view: M16; parameter forms: M19; roles per workflow and central
execution search: M23; freely definable roles: M34)

---

## 12. Supervisor
A model as a supervisor over the workflows: it observes workflows and executions, explains problems, proposes
improvements and drafts new workflows on request. **The Supervisor never changes anything itself.** Every change is a
proposal that a human accepts or dismisses; accepting activates nothing.

### 12.1 Principles
- Fixed rules first (cheap, without a model), the model explains and proposes.
- The model comes from the existing chat model nodes with an existing credential (all providers from M7 and M26).
- Configurable data scope: "Structure and errors" or additionally truncated sample data; secrets and credential values
  are always masked, individual workflows can be excluded.
- Daily budget in tokens for all model calls; usage per day visible.
- Without a model, the Supervisor works with fixed rules only.

### 12.2 Milestones
| # | Content |
|---|---|
| M35 | Observe: rules (invalid, activation, frequent errors, error rate, crashes, runtime, error handling, plaintext secrets, disabled nodes, nodes without input, older node versions, HTTP without retry), failed executions as a finding per error pattern with analysis by the model, daily report, "Supervisor" page with findings, reports and settings, REST API `/api/supervisor` |
| M36 | Improve: proposal for a finding as a sequence of operations, applied to a copy, validated (validator), shown with a diff; test run only on explicit request; accepting saves if the workflow is unchanged since the proposal |
| M37 | Create: chat with the Supervisor in the editor (questions about the workflow, changes, new workflows); new workflows are created inactive as a proposal |
| M38 | Master: the workers' Supervisors via the master, proposals are accepted in the master as a new version, permissions as role actions (M34) |
