# Decisions

## Reference version 1.123.0
The specification requires compatibility with "current 1.x". The pinned image is `n8nio/n8n:1.123.0`
(Docker Hub; the vendor registry is not reachable from the build environment, the image is identical).
Source code locations in comments refer to the tag `n8n@1.123.0`.

## Name filuflow
The project was first called flowlite and has been called filuflow since October 2026 (Latin *filum*, the thread). Renamed are the package, CLI
(`filuflow`), environment variables (`FILUFLOW_*`), cookies, headers, default file names and docs. Transition without breakage:
`FLOWLITE_*` is taken over when the CLI starts if the new variable is missing (`src/cli/legacyEnv.ts`, with a notice); API tokens
`flt_…`, the marker `flowliteMaster` in distributed workflows and binary references `flowlite-fs:` are still read.
The golden fixtures keep their test data (e.g. user agent `flowlite-fixture`), because they were recorded against the real reference implementation.

## Runtime dependencies
In addition to the stack from CLAUDE.md (luxon, better-sqlite3, fastify, croner, pino):

| Package | Reason |
|---|---|
| `undici` | HTTP client per SPEC 4.2 (proxy via `EnvHttpProxyAgent`, `MockAgent` for tests) |
| `jmespath` | `$jmespath()` per SPEC 3.2 |
| `acorn`, `astring` | AST rewriting of expressions for extension functions (SPEC 3.3). Lighter than recast/esprima, same capability |
| `cheerio` | HTML node (`extractHtmlContent`) per SPEC 4.2 |
| `xml2js` | XML node; the reference uses the same library, hence identical output shape |
| `lodash` | The reference uses `get`/`set`/`unset`/`isEqual` and others for paths like `a.b[0]`; same library = same semantics (e.g. keys containing a dot) |
| `jsonrepair` | The reference repairs JSON in the Set node (`repairJSON`) with this library |
| `qs` | HTTP Request: the reference serializes form and query data with `qs`; same library = same encoding |
| `pyodide` (0.28.0) | Python in the Code node (M12): the same version as the reference version 1.123.0, so that Python code behaves the same (Python 3.13, conversion of dicts and JS objects). Runs without an installed Python; about 12 MB, only loaded when Python is used. Dependency `ws` (for the browser part, unused). The alternative would have been a separate interpreter process for all cases, in which case every server would need Python |
| `math-expression-evaluator` | Calculator tool (M7): the reference uses the LangChain calculator, which calls exactly this library (2.0.7). Its own syntax (angles in degrees, `root`, `Mod`, `C(n,k)` etc.); a rebuild would inevitably diverge. MIT license, no dependencies |

## Web interface (M8)
- TypeScript without a framework and without a bundler: `tsc -p tsconfig.ui.json` produces ES modules for the browser, `scripts/copy-ui-assets.mjs`
  copies HTML, CSS and icon to `dist/ui`. No new runtime dependency, no build chain besides tsc; for an internal tool
  of manageable scope, DOM and SVG are enough.
- The server serves `dist/ui` itself (no `@fastify/static`), with a Content Security Policy without inline scripts.
- Parameters: filuflow does not know the parameter descriptions of the reference nodes. Instead of rebuilding them, the editor edits the
  parameter tree directly (text, number, yes/no, object, list, expression) or as JSON. New nodes get starting values from
  `src/ui/editor/templates.ts`.
- Saving writes the workflow file in the workflow directory (the reference format, indented with 2 spaces); hot reload and activation
  work as with manual changes. New workflows get a random ID and a file name derived from the workflow name.
- `playwright-core` (dev dependency, version matching the preinstalled Chromium) for the browser test `test/ui.e2e.test.ts`;
  without Chromium the test is skipped.

## filuflow design
- Implemented following the design handoff (logo "Strand", tokens `--ff-*` dark and light, IBM Plex Sans and Mono, Lucide icons,
  editor with header, icon bar and "Last run" panel, workflow overview with metrics). The design rules
  (radius 0, no shadows or gradients, status always as a word, formal "Sie" address in German texts) apply to the whole interface, including the master and
  administration, which the handoff does not design.
- The handoff recommends Vite, React and React Flow. The interface stays with TypeScript without a framework (see M8): the editor with
  canvas, connecting, undo and parameter form exists and is tested; a rewrite would bring three runtime dependencies
  and a second build chain without any functional gain. The node and edge rendering from the handoff (176 x 104,
  header bar in the category color, orthogonal edges with 8 px radius, square ports) is rebuilt in the own SVG canvas.
- Fonts (IBM Plex, SIL Open Font License 1.1) are stored as woff2 in `src/ui/static/fonts`, icons (Lucide 0.545.0, ISC license) as
  path data in `src/ui/icons.ts`. No runtime dependency, no external sources (CSP stays `default-src 'self'`).
- Dialogs have no dimming backdrop (rule: no transparency overlays); they stand out through borders and the 2 px gradient line.
- For the overview the server provides `GET /api/overview` (metrics from SQLite, queue utilization, source and time
  of the last load) and in `GET /api/workflows` triggers and validity per workflow. The master passes through a project's metrics
  from the worker (`GET /api/projects/:pid/overview`, only workflows of the project).

## Master and Worker (M9)
- **The master connects to the worker** (not the other way round): the worker is a normal `filuflow serve` with an additional worker API,
  protected with its `FILUFLOW_API_KEY`. The master needs network access to the worker (direct, VPN or reverse proxy with TLS);
  the worker needs no access to the master and keeps running if the master fails.
- **Data on the worker:** credentials and execution data do not permanently leave the tenant's environment. The master holds
  users, permissions, projects and workflows (with versions) and queries executions live. The master can set and delete credentials on the worker,
  but not read them (file `credentials.managed.json` next to the hand-maintained credential file).
- **Distribution:** saving in the master immediately writes the workflow as `<id>.json` into the worker's workflow directory, marked
  with `meta.filuflowMaster` (version, project). A sync (`FILUFLOW_SYNC_SECONDS`, default 60) catches up on missed changes and
  removes marked workflows that the master no longer knows. Files without a marker stay untouched, so workers can
  additionally have local workflows.
- **One project, one worker:** a project is assigned to exactly one worker (and thus one tenant). Multiple workers per tenant
  are possible (e.g. test and production), then as separate projects.
- **No new dependencies:** passwords with scrypt from `node:crypto`, TOTP (RFC 6238) and OIDC (code flow with PKCE, JWKS,
  signature verification RS/PS/ES) are implemented in-house. The building blocks are small and well specified; an OIDC or JWT library
  would have brought more code and dependencies than it saves. HTTP to the worker and to the identity provider via `undici` (already present).
- **Sessions** are stored in the master's SQLite database (hashed), not as JWT: logging out, locking and password changes take effect immediately.
- **Interface:** the same SPA as on a single server; it detects the master via `GET /healthz` (`mode: "master"`) and then loads
  `master/app.js`. Editor and execution view are connected to master or single server via a small backend interface.

## Credentials in the interface (M11)
- **Two sources:** `credentials.json` remains the hand-maintained source (read-only, takes precedence); what is created in the interface or
  by the master ends up in `credentials.managed.json`. This keeps existing installations unchanged, and entries
  that someone deliberately maintains in a file (or via configuration management) cannot be overwritten via the API.
- **Secrets write-only:** the API returns public fields so that the form can show them, never secret fields.
  When editing, the interface sends changed values and, in `keep`, the secret fields that should stay. A placeholder
  such as `********` as a value would be error-prone (it could be stored as a real value).
- **Declarative types:** the fields of the built-in types are stored as data in `src/credentials/types.ts` (following the reference definitions,
  but an own description) and reach the interface via `GET /api/credential-types`. The same description decides which
  fields are secret; for other types the name heuristic still applies. Other the reference types can be created with free fields.
- **IDs like the reference:** new credentials get an ID of 16 characters. Workflows reference `{ id, name }`; lookup is by name,
  then by ID. Renaming keeps the ID so that workflows with a stored ID still find the credential.
- No new dependency.

## Forms (M17)
- **HTML forms without scripts:** the reference renders a template with JavaScript, submits via fetch and redirects with 307.
  filuflow serves normal forms (multipart/form-data), redirects as 303, and briefly shows a page with reload while the
  wait state is being saved. Field names (`field-0` …) and the nodes' output are as in the reference.
- **Completion page:** the reference resumes the execution when the completion page reports back via script; filuflow resumes it when
  the page is displayed.
- **HTML sanitizing** as a small own filter with the reference's allowlist (instead of sanitize-html).
- Required checkboxes and selection limits are checked by the server (the reference checks in the browser).

## Chat Trigger (M16)
- **Own chat page instead of @n8n/chat:** the reference loads the chat widget from a CDN. filuflow serves a small page of its own
  (`src/ui/chat/`, built to `dist/ui/chat/`), without third-party sources and with a strict CSP. The protocol is the same
  (`action`, `sessionId`, `chatInput`; response `output` or `text`), so embedded the reference widgets keep working.
- **Chat in the editor** is a test run from the Chat Trigger with the message as input, like the chat in the reference editor.
- Streaming and "the reference User Auth" are still missing (validation reports them).

## HTTP Request extended (M15)
- **Pagination:** same options and stop rules as the reference; the per-page values are merged into query,
  headers and body before serialization (lodash merge like `applyPaginationRequestData`). Each page goes through the same
  response evaluation as a single request.
- **Digest auth** implemented in-house (RFC 7616, about 40 lines): the reference uses the old "request" library for it.
- **Client certificates** via separate undici agents per certificate (cached by hash); a given CA
  replaces the default CAs, as in Node.

## OAuth2 with authorization code (M14)
- **Tokens in the database, not in the credential:** the reference writes `oauthTokenData` into the credential. filuflow puts the tokens
  (encrypted) into the key-value table, keyed by the credential's ID. This way credentials from the
  hand-maintained file can be connected too, and editing in the form does not overwrite tokens. `oauthTokenData` from an
  exported credentials is still read.
- **Redirect URI like the reference** (`/rest/oauth2-credential/callback`), so existing app registrations still fit.
- **Master:** the worker builds the authorization URL with the master's redirect URI and remembers `state` and
  `code_verifier`; the master only remembers which worker the `state` belongs to, and forwards the callback.
- **No script on the callback page** (strict CSP); the interface notices from the closed window that it should reload.

## Waiting executions (M13)
- **Like the reference:** the Wait node calls `putExecutionToWait`, the engine puts it back on the stack and ends the run with
  status "waiting". On resume it is disabled (passes on its input data or the webhook's data) and its
  last run is removed. Under 65 s the process waits itself; the wait tracker fetches every 60 s those due in the next 70 s.
- **State:** stack, waiting inputs, node contexts and runData are stored as JSON in `execution_resume`
  (gzip, encrypted with the key). Resumption uses the workflow state from the start of the execution, like the reference.
- **Not in sub-workflows and the CLI:** there is no place to store state there; durations are waited out in the process,
  waiting for a webhook reports a clear error.
- **Wait v1:** defaults as in the reference description (v1: 1 hour, v1.1: 5 seconds); previously they were swapped.

## Python in the Code node (M12)
- **Two ways like the reference:** "Python" runs with Pyodide in the server process (context with `_` instead of `$`, like the reference `PythonSandbox`),
  "Python (Native)" with a real interpreter in a separate process (like the reference's Python task runner). The reference requires a
  separate task runner for Native (`N8N_RUNNERS_ENABLED`); filuflow instead starts `python3` per execution with its
  own small runner (task as JSON via stdin, result as JSON via stdout). This saves a service; the start costs
  about 30 ms per execution of the node (not per item).
- **Time limit for Pyodide:** the reference has none in Pyodide mode. Python blocks the main thread, so a timer cannot
  fire. Therefore a worker thread sets the interrupt buffer (SharedArrayBuffer); Python aborts with KeyboardInterrupt, the
  wrapper turns this into "Code execution timed out". If an interrupt escapes into Pyodide's event loop, a custom
  handler catches it so that the server keeps running.
- **Security defaults for Native like the reference** (allowlists empty, blocked builtins, empty environment), so that exported
  workflows have the same limits; variables with the reference names apply as well.

## Server
- fastify with its own content type parser for webhooks: the body is read raw (gzip/deflate like the reference) and evaluated in the Webhook node
  according to the reference's rules (`parseRequestBody`, `body-parser.ts`). Responses rebuild Express semantics
  (`res.json` and `res.send`: content type, charset, CSP sandbox header).
- Query strings are parsed with `qs` as in the reference (Express `query parser: extended`).
- multipart/form-data is read with Node's Fetch API (undici `Request.formData()`) instead of formidable; no new dependency.
- Execution log: SQLite via better-sqlite3, tables `executions` and `execution_data` (gzip-compressed JSON).
  At startup, incomplete executions are marked as `crashed`.
- Webhook golden tests: `scripts/record-webhook.sh` imports the workflow into the reference, activates it directly in the database
  (`update:workflow --active=true` fails in 1.123 after an import, see `scripts/activate-n8n-workflow.mjs`), starts
  `n8n start`, sends the requests from `webhook.json` with `scripts/webhook-client.mjs` and reads the executions from the SQLite file.
  The same client sends to filuflow in the test, so headers and order are identical.

## Expression evaluation
- Own evaluator instead of `@n8n/tournament`: templates are split like tournament does and translated into a
  JS expression that runs in a shared `node:vm` context with a timeout.
- Identifiers are resolved via `with (proxy)`. The proxy reports every name as present,
  unknown names yield `undefined` (like tournament, which rewrites every identifier to the data object).
- The specification says "otherwise string concatenation (objects as JSON)". The reference concatenates via `Array.join`,
  where objects become `[object Object]`. According to CLAUDE.md compatibility applies, so
  filuflow behaves like the reference.

## Time zone
Default `Europe/Berlin` (SPEC). Can be overridden via `settings.timezone`, `FILUFLOW_TIMEZONE` or `GENERIC_TIMEZONE`.
The reference's default is `America/New_York`; for golden tests the reference container is started with `GENERIC_TIMEZONE=Europe/Berlin`.

## Start node
Explicit (`--trigger`), otherwise the only active trigger, otherwise an error (SPEC 2.1). With multiple
triggers the reference CLI picks the first matching one; filuflow deliberately requires a choice in that case.

## Golden tests and oracles
- `scripts/record-expected.sh` runs fixtures in `n8nio/n8n:1.123.0` via `n8n import:workflow` + `n8n execute --rawOutput`.
  `n8n execute` ignores `pinData` (only active in manual mode), so fixtures generate their data with Code nodes.
- HTTP fixtures talk to a local mock server (`scripts/mock-server.mjs`, port 18089); the reference container runs with `--network host`.
- For functions with very many combinations (filter operators, extension functions), the reference code is called directly in the container
  as an oracle (`scripts/record-filter-table.sh`) and the result is checked in as a table.

## Versions like the reference
Libraries whose behavior is visible in outputs are pinned exactly to the versions of the reference version 1.123.0:
luxon 3.4.4, lodash 4.17.21, cheerio 1.0.0-rc.6, html-to-text 9.0.5, xml2js 0.6.2, qs 6.11.0, jsonrepair 3.13.1, jmespath 0.16.0,
title-case 3.0.3 and transliteration 2.3.5 (extension functions `toTitleCase()`, `replaceSpecialChars()`).
`html-to-text` is used by the HTML node (v1.2, return "text").

## Variables (M18)
Variables maintained in the interface are stored in the SQLite table `kv` (key `variables`), not in `vars.json`: the
file remains hand-maintained and takes precedence, as with credentials. The object for `$vars` is changed in place
on save, so that new executions see the values without a restart. Rules for keys and values like the reference
(`packages/@n8n/api-types/src/dto/variables/base.dto.ts`).

## Expressions in webhook parameters (M18)
Path and methods are evaluated on activation (the reference `getNodeWebhooks`), all other parameters of the Webhook node
on every call (the reference `executeWebhook`), each without items. If a variable used in the path changes, the new path only applies
after the next load of the workflow (save, activation, restart). If the path expression yields no value,
The reference silently skips the webhook; filuflow reports an activation error.

## Wait for test call (M18)
In filuflow, test URLs are always registered for all saved workflows. "Wait for test call" creates a separate registry for the
submitted editor state, which takes precedence for test URLs and is removed after the first call, after the wait time
expires (at most 5 minutes) or when the request is aborted. This does not exist in the master yet.

## Parameter forms (M19)
The descriptions are in the node files (`parameters`) in an own, simplified format; names, defaults,
option values and visibility rules match the reference version 1.123.0, so that saved workflows have the same structure. The
form only writes a parameter once it is changed; execution keeps using its own defaults (the same
as the reference). Exceptions:
- Code fields: the reference has an empty default and sets the starter code in the editor. filuflow shows the starter code as the default
  and saves it on display, so that visible and executed code match.
- `customCss` of Form Trigger, Form and Chat Trigger has an empty default; the own pages do not use the reference's
  CSS variables.
- Options that filuflow does not execute (Webhook `streaming`, Chat Trigger `responseNodes` and `n8nUserAuth`) are missing from
  the option lists; `validate` still reports them when an imported workflow uses them.
- Expressions in a controlling parameter cannot be evaluated in the editor; dependent fields then stay visible.

## Merge via SQL with alasql (M20)
`combineBySql` runs SQL over the inputs. The behavior (dialect, joins, types, result shape) is that of alasql;
an own SQL interpreter would never deliver the same results. That is why alasql was added as a runtime dependency,
exactly in the version of the reference version 1.123.0 (4.4.0), like the other libraries under "Versions like the reference". alasql's file functions
are blocked.

## Execution order v0 (M20)
As in the reference, every value except "v1" counts as the old order, including a missing value (the validator then warns). Implemented
following `packages/core/src/execution-engine/workflow-execute.ts`: breadth-first search (`push` instead of `unshift`), children in
connection order instead of by position, for nodes with multiple inputs missing predecessors without data are started with an
empty item, an empty output on a second input counts as data, input data always comes from input 1,
`requiredInputs` does not apply, and a node without data on all inputs goes back on the stack (with an abort for
infinite loops). Golden tests against a running the reference are still missing, because no reference container ran in this environment.

## Execute Workflow from file and URL (M20)
As in the reference, relative paths are relative to the process's working directory. The reference reads without restriction; filuflow additionally offers
`FILUFLOW_RESTRICT_FILE_ACCESS_TO` (name like `N8N_RESTRICT_FILE_ACCESS_TO`). External modules for `require` come
from the filuflow installation, as with the reference from that of the task runner.

## Streaming (M21)
Like the reference: a run hook `sendChunk` only exists when the response is streamed; `isStreaming()` checks it and the mode
(manual, webhook, integrated). Nodes write `begin`/`item`/`end`, the engine writes `error` on errors. The server writes every
line immediately (chunked) and ends the response with the execution. The models stream via server-sent events; the
HTTP client delivers partial responses for that (`onChunk`), but keeps the complete body, so that tracing, token counting and
result come out exactly as without streaming. The V2 agent returns the response of the last model call as its result
(the reference assembles the entire streamed text there; for tool calls without accompanying text that is the same). The
chat window in the editor still uses test runs without streaming.

## Chat with response nodes (M22a)
The reference connects the chat page to the waiting execution via a WebSocket (`/chat`, package ws). filuflow uses
server-sent events for the way to the page and POST for replies: same flow (message, "continue", end, checking at
intervals of 500 ms instead of 3 s), but without a new dependency and with the fastify server alone. The reference's embedded chat widget
(`@n8n/chat`) does not speak this channel; filuflow's hosted chat page does.

## Imported credentials and OAuth1 (M22)
The reference encrypts credentials with crypto-js in OpenSSL format ("Salted__", 8 byte salt, key and IV via EVP_BytesToKey
with MD5, AES-256-CBC, Base64). filuflow rebuilds this with `node:crypto` (no new dependency) and tests it against
`openssl enc -md md5`. Imported entries keep their the reference ID, so that workflows with `credentials.<type>.id` find them.

Sharing applies per worker and project in the master database (`credential_access`), not on the worker: the worker knows no
projects, and the master checks every workflow before distribution anyway. Without an entry, every project of the worker may use the
credential, as before; so the introduction changes nothing for existing installations.

OAuth1 follows the reference (oauth-1.0a): signature over URL query and form fields; on the call, the Authorization header replaces all
other headers. filuflow keeps the body's content type, because in the reference the HTTP library sets it again afterwards. For the
request token, filuflow additionally sends `oauth_callback` in the header (the reference only in the JSON body), since providers mostly
do not read the JSON body; the signature is the same. As in the reference, the access token request is unsigned (form with
`oauth_token` and `oauth_verifier`).

## Roles per workflow and central search (M23)
Roles per workflow complement the fixed project roles instead of introducing a freely configurable permission model: the existing
roles cover the cases "single workflow editable for readers", "confidential workflow" and "sharing with externals" and
stay manageable. Project admins deliberately cannot be restricted, so that nobody can make a project unmanageable.

The central search keeps no index in the master: executions and their data stay on the worker (data kept with the tenant).
The master queries the workers in parallel with the readable workflow IDs (POST, because the list can get long) and merges the
results by start time. Paging is based on the start time of the last hit; this is stable across multiple workers
as long as no two executions start at exactly the same millisecond.

## Plugins (M24)
Nodes in the community node format are CommonJS and import `n8n-workflow`. filuflow provides its own replacement for it (error classes,
connection types, small helpers), which takes effect via `Module._resolveFilename` when the package is not installed with the plugin:
the real package brings many dependencies and is under the Sustainable Use License; the replacement is own work based on
the observable behavior. Classes are determined from the file name as in the reference; the isolation via `vm` that the reference uses when
loading is omitted (it is not a security boundary in the reference either).

The context for `execute` rebuilds the frequently used functions instead of the whole `IExecuteFunctions`. If a
function is missing, the node fails with a clear message. Triggers, polling and webhooks need their own runtime parts
(activation) and are deliberately left out; the loader reports them instead of silently running them incorrectly. Declarative nodes
were added with M29 (see below).

Own filuflow plugins write nodes against the same interface as the built-in nodes. There is no separate
sandbox mode: plugins are operator code and run in the process.

## Predefined credential types (M25)
The reference ships hundreds of credential types with their own `authenticate` description. filuflow does not take them over as a copy,
but describes a selection of frequently used types itself based on the observable behavior (source location per type in
`src/credentials/authenticate.ts`); more come via plugins (M24), whose `authenticate` uses the same place. Types ending in
`…OAuth2Api` run without their own description via the connected or imported token; the refresh needs the
token URL in the credential.

The helpers of the Code node and the plugin nodes are the same implementation (`src/nodes/shared/executeHelpers.ts`), so that
code that works with `this.helpers` or `helpers` in the reference behaves the same in both places.

## More AI models (M26)
The models talk to the providers directly via HTTP, like OpenAI, Anthropic and Gemini already do, without the SDKs of Groq,
Mistral or Ollama. The benchmark is what the LangChain packages in the versions of the reference version 1.123.0 send (read via `npm pack`):
field names, defaults (temperature 0.7 for Groq and Mistral), message conversion and quirks that the reference
inherits through them. Quirks are also deliberately adopted, such as: Mistral always streams (the reference always passes an
AbortSignal), Ollama does not send tool calls of earlier responses, the Ollama options "useMLock"/"useMMap" have no
effect, the Responses API delivers no token counts to tracing (the reference then estimates). Agent V3 rebuilds its steps like
The reference from the engine responses; the IDs of the Responses API are lost in the process, as there.

## Embeddings and vector stores (M27)
The RAG nodes also work without LangChain. The benchmark is the behavior of the reference version 1.123.0 with @langchain/core 1.1.0,
@langchain/classic 1.0.5 and @langchain/textsplitters 1.0.1 (read via `npm pack`); `scripts/rag-oracle.mjs` records the
results of the real packages for splitters, loader and similarity search, `test/rag.test.ts` compares against them. The
separators per programming language are data from @langchain/textsplitters (MIT license) and are therefore adopted verbatim; the
splitter itself is own code.

Deliberately adopted quirks:
- The Simple Vector Store keeps the data in the process's memory, shared across all workflows that use the same key
  (up to v1.1 prefixed with the workflow ID, from v1.2 the value from the resource locator), and loses it on restart.
- The similarity search sorts with MemoryVectorStore's comparison (`a > b ? -1 : 0`), which keeps the insertion order
  for equal values.
- OpenAI Embeddings request `encoding_format: "base64"` like the SDK and read Float32 (little endian).
- The reference node's Recursive Character Text Splitter does not keep the separators (`keepSeparator: false`), although the
  class otherwise uses `true`.
- Sub-node logging follows logWrapper: embeddings, splitters, loader, vector store and tool appear with
  their own runs, the retriever does not (in the reference version 1.123.0 the wrapping does not apply there).
- PDF, DOCX and EPUB would need additional libraries; the Data Loader rejects them with a clear message instead of
  reading them incorrectly. A reranker on the vector store likewise aborts the execution with a message.

## OAuth2 types of services (M28)
As in the reference, the types only describe fixed values via `extends: ['oAuth2Api']`; code exchange, refresh and signing remain
the existing OAuth2 implementation. The values (URLs, scopes, query parameters, kind of client authentication) are data
of the respective services, read from n8n-nodes-base 1.121.0 and written down in an own structure
(`src/credentials/oauth2Types.ts`). A selection of frequently used services is included; other `…OAuth2Api` types
from an export keep working if the stored data contains URLs (the reference editor stores them too).

Defaults apply when loading in the engine for all types with a description, like the reference `applyDefaultsAndOverwrites`: missing
values of visible fields get their default, stored values take precedence. Differences from the reference:
- filuflow evaluates expressions (`=…{{ $self.field }}`) only in hidden fields. They come from the type description or
  an export; entered values, such as a password starting with "=", stay unchanged. For credentials filuflow still
  supports `{{ env.NAME }}`, but no the reference expressions with `$vars` or `$secrets`.
- filuflow does not discard fields that no description knows (the reference only passes on described fields).
- Evaluation runs in `node:vm` with a time limit; credentials and types are considered trusted like workflows.

As in the reference, the `requestOAuth2` options per service (getOAuth2AdditionalParameters) also apply to types without their own
description (e.g. `shopifyOAuth2Api` from an export). Quirks are adopted as well: HTTP Request enforces the token type "Bearer" for
`oAuth2Api`; after a refresh the reference signs the request again without applying `keepBearer`, and
sets the extra header (Shopify) with the previous token.

## Declarative nodes (M29)
Nodes without `execute` that describe their requests (`requestDefaults`, `routing` on parameters and option values,
`requestOperations`) are run by `src/plugins/routingNode.ts`. The benchmark is n8n-core 1.122.0 (in the reference version 1.123.0)
`execution-engine/routing-node.ts`; rebuilt are the order and merging of the request parts (lodash merge),
visibility against the top-level parameters, `$credentials`, `$value`, `$index`, `$parent`, `$request`,
`$response`, `$responseItem` and `$version` in expressions, preSend and postReceive (functions as well as rootProperty, filter,
limit, set, sort, setKeyValue, binaryData), pagination (function with `makeRoutingRequest`, generic, offset), maxResults,
batching and the "Request Options" setting that the reference adds on loading. Errors become NodeApiError as there, for 429
with the hint about batching.

For this, `helpers.httpRequest` now follows convertN8nRequestToAxios more closely: an empty body (e.g. `{}` from the defaults)
is not sent, and never a body with GET. Not rebuilt: `preAuthentication` of credential types (tokens that the reference fetches before
the request and stores in the credential) and the header `User-Agent: n8n`.

## Community packages from the interface (M30)
The flow follows the reference version 1.123.0 `community-packages.service.ts`: check the package name, resolve the version via the registry,
`npm pack` into a download folder, extract to `<folder>/node_modules/<package>`, remove dev, peer and optional
dependencies, `npm install --ignore-scripts` with the same switches, add the dependency to `<folder>/package.json`;
a package without loadable nodes is removed again. Differences from the reference:
- filuflow checks the version with `npm view` instead of via HTTP; this way the npm configuration's proxy and authentication apply to it too.
- The list of packages is stored as the file `filuflow-packages.json` in the package folder (the reference: table `installed_packages`); this way
  the folder needs no database and also works for `validate` and `run`.
- On update and removal filuflow removes node and credential types from the registry and clears the package's
  `require` cache; no restart is needed. There is no check for "verified" packages and no
  checksums, because filuflow does not obtain a list of vetted packages from the reference.

## Poll and trigger nodes from packages (M31)
Nodes with `poll()` or `trigger()` get a general activation (`NodeType.activate`, `src/server/activations.ts`)
instead of a separate service per node type. The benchmark is n8n-core 1.122.0: `activatePolling` (Poll Times via
`toCronExpression` with a random second, first poll on activation, errors there prevent activation, interval
at least one minute), `runTrigger` and `executePollNode`/`executeTriggerNode` for the manual run. As there,
`emit` saves the static data and starts an execution from the node; errors start the error workflow with the data
`{ trigger: { error, mode }, workflow }`. A trigger node that reports `emitError` is closed and restarted with a doubling
interval starting at one second (at most 24 hours), like the reference with `addQueuedWorkflowActivation`.

The context of an active trigger is the same as for an execution (`WorkflowExecutor.contextFor`), only without
input data; this way credentials, expressions and static data apply as usual. The CLI runs poll and
trigger nodes like the manual run when no input data is passed.

## Webhook nodes from packages (M32)
Package nodes with `webhook()` and `description.webhooks` run via the existing WebhookService; only description,
invocation and registration come from the node (`NodeType.packageWebhooks`, `src/plugins/webhookNode.ts`). The benchmark is the reference version 1.123.0
`webhook.service.ts` (getNodeWebhooks, runWebhookMethod, runWebhook), `webhook-helpers.ts` (executeWebhook,
evaluateResponseOptions, parseRequestBody) and the contexts WebhookContext and HookContext. Quirks are adopted
as well: without `responseData` in the description, the reference responds in "onReceived" mode with the text `firstEntryJson`
(default of getComplexParameterValue, which extractWebhookOnReceivedResponse checks before `webhookResponse`); from node version
2 only JSON, text, form and XML bodies are read.

Registration with the service (`checkExists`, `create`, `delete`) runs on activation before the poll and trigger nodes;
if it fails, the workflow is not activated. While waiting for a test call, filuflow registers the test webhook
and unregisters it afterwards. For custom responses (`noWebhookResponse`) there is an Express-style response object that
collects status, headers and body; streaming via this object is not rebuilt.

## Shared credentials (M33)
A shared credential has its source in the master; on the worker it is an ordinary managed credential that the
master writes via the existing worker API. This way workers need no change, sharing with projects (M22) and the
validation of workflows apply unchanged, and a worker keeps running without the master. The master remembers per worker
the distributed name and the version; the sync only distributes what is outdated or failed, and works through a
list of pending removals. The ID from the master is passed along, so that workflows referencing by ID find the same credential on all
workers. Copies changed by hand on the worker are only overwritten on the next change in the master;
the interface marks them as "Master (shared)".

## Custom roles (M34)
Custom roles are lists of the existing actions (`project.manage`, `workflow.edit`, `workflow.run` …) and are stored as
"custom:<id>" where the built-in roles were stored before (project members, roles per workflow). This keeps
the check at every route the same (`allows(role, action)`); only the resolution now also knows custom roles. Viewing the project
is always included. Project admins and global administrators keep full access regardless, even if a
custom role contains `project.manage`. Assigned roles cannot be deleted, changes take effect immediately. Older
databases get a new version of the member tables at startup, because SQLite cannot change a CHECK.

## Supervisor (M35)
The Supervisor is part of the server, not a workflow: it needs access to all workflows, executions and the
validator, and its results (findings, proposals, reports) are administrative data. It lives under `src/supervisor/`
and stores in the same SQLite database as the executions (tables `supervisor_*`), so that server and worker bring
what it needs without further setup.

There is no separate client for the model. The Supervisor builds an internal workflow from a placeholder and the
chat model node of the chosen provider with the chosen credential, and fetches the model like an AI Agent via the
AI input (`Runner.activationContext`, `getSubNodeInstance`). This way the same providers, credentials, header options
and error messages apply as in workflows, and every new model node becomes available to the Supervisor via one line in the
`PROVIDERS` table. The Supervisor uses tools via the models' tool calls; the loop is its own and
short (at most four steps for analyses), because the Supervisor does not need output for a runData.

Fixed rules come before the model: they cost nothing, are traceable and also run without a model. The model is
only asked for explanations, proposals and reports, failed executions once per error pattern (key from
workflow, node and the message without numbers and IDs), so that an error in a loop does not use up the budget.
The daily budget applies to all calls together; token counts come from the providers' responses, otherwise from an
estimate (characters divided by four).

Findings from rules describe a state: if they no longer occur at the next check, they are resolved.
Findings from executions are events: they count up and are considered resolved when they have not occurred for three days
and the last execution succeeded. Dismissed findings stay dismissed until someone reopens them.

## Supervisor proposals (M36)
The model does not send complete workflows, but operations (`src/supervisor/operations.ts`), which the Supervisor
applies to a copy of the saved state. There are three reasons for this: the model only sees secrets masked and must
never write them back (unchanged parts are thus preserved exactly, `***` as a value is rejected); every change is
individually visible and traceable in the diff; and errors can be named precisely ("Operation 2: node X does not
exist"), so the model can fix them in a targeted way. The proposed state is validated with the validator; new errors
prevent the proposal, except missing credentials, which a human must create first.

Accepting is bound to the original state: a checksum over the saved workflow (keys sorted) is remembered with the
proposal and compared on accepting. If the workflow has changed in the meantime, the proposal is outdated
instead of overwriting other people's changes. Accepting never changes the activation; new workflows are created inactive.

A test run really executes nodes (services, messages, databases). It therefore only runs on explicit
request after a confirmation and never automatically; only validation is automatic.

## Conversation with the Supervisor (M37)
The conversation runs without state on the server: the interface sends the history (at most 30 messages) with every
message, the server adds the saved state of the workflow and the open findings in the system prompt. This way there is
no conversation data to store or clean up, and every response sees the current state. New workflows and
changes use the same operations and checks as proposals for findings (M36); new workflows are built from an
empty workflow and created inactive. Proposals always refer to the saved state, not to
unsaved changes in the editor; the panel says so, and accepting warns if something in the editor is unsaved.

## Supervisor in the master (M38)
The Supervisor runs on the worker, not in the master: that is where the executions, the credentials for the model and the
validator with the installed packages are, and a tenant's data only leaves its environment towards the model, not
towards the master (the master gets findings, analyses and proposals, but no execution data). The master collects
findings and proposals from the workers and filters them by the person's permissions; there is no copy in the master that
could become outdated.

Accepting happens in the master, because that is where the source of the workflows is: a state saved on the worker would be overwritten at the next
sync. The proposal carries the master version it is based on (from the marker of the distributed
workflow); only if it matches the current version is the proposed state saved without the marker as a new
version and distributed. Afterwards the worker marks the proposal as accepted. There are two new
actions for permissions: `supervisor.read` (view findings and proposals) and `supervisor.use` (analyses, proposals and conversations that
cost tokens); accepting additionally requires `workflow.edit`, because it changes the workflow.

## Languages (M39)
English is the default language of the product and the repository. Server, CLI, validator, logs and API messages are
English only: they end up in logs, scripts and tickets, where one language is easier to search, and the reference's own messages
are English as well. Only the web interface can be switched to German.

The interface uses the English text itself as the key (`t('Saved {time}', { time })`), with German catalogs as plain
objects in `src/ui/locales/de/`. Missing entries fall back to English, so an untranslated text never breaks the page,
and no key names have to be invented or kept in sync. There is no library: placeholders are the only feature needed;
plural forms are written as separate texts. The catalogs are bundled with the interface (a few hundred kilobytes
unminified), which avoids an extra request and a loading state.

Node parameter and credential labels are defined in English next to the implementation (as in the reference) and translated in
the browser with the same catalogs, so the server stays language neutral and a German interface still sends and stores
the same workflow JSON. The language is stored per browser, not per user, because the single-instance interface has no
users; switching reloads the page so that no view keeps texts in the old language.

The Supervisor writes analyses, proposals and reports in the language from its settings (one per installation or
worker, since several people read them); the conversation in the editor uses the language of the person's interface.

## Gmail node (M40)
The Gmail node builds and parses MIME messages itself (`src/nodes/shared/mime.ts`) instead of adding nodemailer and
mailparser (the libraries the reference uses) as runtime dependencies. The node needs only a small part of them: single part,
multipart/alternative and multipart/mixed with attachments, encoded words, RFC 2231 file names, quoted-printable and
base64, address lists, and on the reading side the fields the reference's `parseRawEmail` takes over. Both directions are checked
against the real libraries in the versions of the reference version 1.123.0 with a recorded oracle (`test/oracle/gmail-mime.json`,
`scripts/gmail-mime-oracle.mjs`). Known gaps: `textAsHtml` links only URLs with a scheme, `www.` addresses and email
addresses (mailparser also links bare domains and @mentions), and named HTML entities there cover Latin-1 and the
HTML 4 special characters.

The service account (credential type `googleApi`) signs its JWT with `node:crypto` (RS256); no JWT library is needed.
Two deliberate differences to the reference: the reference puts the whole private key into the `kid` header of the JWT, filuflow never sends
the key; and filuflow keeps the access token until shortly before it expires instead of requesting a new one for every
API call. Neither changes what the node returns.

The reference appends "This email was sent automatically with the reference" with a link to n8n.io to sent emails (option "Append the reference
Attribution", on by default from typeVersion 2.1) and to "Send and Wait" emails. filuflow is not the reference and does not
advertise it: the option is accepted and kept in the workflow, but nothing is appended (as with the attribution of the
forms). The "Send and Wait" email and its pages use filuflow's own HTML with the same texts and buttons.

"Send and Wait for Response" uses the existing waiting executions (M13). The resume links are signed like the reference
(HMAC-SHA256 over host, path and query, parameter `signature`); the secret comes from `FILUFLOW_HMAC_SIGNATURE_SECRET`
or `N8N_HMAC_SIGNATURE_SECRET`, otherwise the server generates one and keeps it in its database so that links in sent
emails stay valid after a restart. The values the form pages need (title, description, fields) are resolved when the
email is sent and stored in the node context of the waiting execution, so the webhook does not have to evaluate
expressions without the execution's data.

The reference loads labels, aliases and thread messages for its option lists via the API. filuflow's forms have no dynamic option
lists yet, so label IDs are a JSON list (stored as an array, as in the reference) and alias and message ID are text fields; the node
also accepts label IDs as JSON text or comma separated text.

## Built-in poll nodes (M41)
Poll nodes from community node packages (M31) already had activation with "Poll Times", the first poll on activation and the
manual run, but bound to the reference's `poll()` with `this` as PollContext. Built-in nodes now get the same behavior from
`src/nodes/shared/polling.ts`: `pollingTrigger(poll)` returns the trigger methods (`activate`, `execute`, no inputs)
for a plain function `poll({ ctx, manual })`, and `pollTimesParam` is the "Poll Times" form. The cron conversion, the
interval check and the polling loop live there once and the package adapter uses them too, so both kinds behave the
same; a test keeps the built-in form equal to the one package nodes get. The Gmail Trigger is the first user; Slack or
Outlook triggers only need their `poll` function and parameters. No new service is needed: the server's existing
trigger activations (`src/server/activations.ts`) start every node type that has `activate`.

Manual runs of poll and trigger nodes work on a copy of the static data. The reference runs a test execution on its own
Workflow instance and does not save its static data; in filuflow's server the in-memory static data is shared with the
active workflow, so without the copy a test run of the Gmail Trigger would move the active trigger's window. The copy
still starts from the stored values, so like the reference a test run does not return a message that the active trigger already
counts as a possible duplicate. After a successful activation the static data is saved (as the reference does in
`ActiveWorkflowManager.add`), so the first poll time survives a restart even before the first execution.

## Installer (M42)
`scripts/install.sh` builds the Docker image from source on the server by default instead of pulling
`ghcr.io/mebytede/filuflow:main`. The package in the GitHub Container Registry is private, so other people cannot pull it,
and building from a git ref makes the installed version explicit (`--ref`) and works the same for the native method.
`--image` uses a prebuilt image for those who have access to one; the build costs a few minutes and about 2 GB of RAM
once per update.

For HTTPS the installer uses Caddy from its official repository: it obtains and renews Let's Encrypt certificates by
itself, redirects HTTP to HTTPS and needs a configuration of a few lines, so the installer has no certbot timers, renewal
hooks or TLS settings to maintain. Caddy runs on the host for both methods (not as a container), so the same site file
serves a Docker or a native installation, and filuflow only listens on 127.0.0.1 behind it. Other proxies (nginx,
Traefik) remain possible with `--public-url`; `docs/INSTALL.md` has an nginx example.

The installer is a bash script without dependencies beyond curl, git and the package manager. Generated configuration
files (compose file, systemd unit, Caddy site) are rewritten on every run; own changes go into
`docker-compose.override.yml` or a systemd drop-in. The env file is only amended, so secrets and own settings survive
updates. No new runtime dependencies for filuflow itself.


## Public release (M43)
**License AGPL-3.0-or-later.** filuflow is a server product: most users will run it as a network service, not
redistribute it. Under a permissive license or the plain GPL, anyone could offer a modified filuflow as a hosted service
without sharing the changes. The AGPL closes that gap (section 13: users of a modified version over a network can get
its source) while leaving self-hosting, internal company use and commercial use free, and it does not reach into the
workflows, credentials and configuration people run on filuflow. "Or later" follows the FSF recommendation and keeps the
door open for a future AGPL version without having to ask every copyright holder; nothing in the repository requires
"only" (no third-party code under AGPL-3.0-only is included, and the bundled material under OFL-1.1, ISC, MIT and MPL-2.0
is compatible). The reference code is not copied (Sustainable Use License), so the reference license does not constrain the choice.
`private: true` stays in `package.json`: filuflow is distributed as source and Docker image, not on npm, and the flag
prevents an accidental publish. Copyright line: "the filuflow authors", maintained by the GitHub account mebytede.

**No external pull requests for now.** As long as all code comes from the maintainers, the copyright situation stays
simple (no contributor license agreement or DCO process, the license can still be adjusted, for example for dual
licensing) and the review effort stays manageable while the architecture is still moving. Issues, the reference compatibility
reports and private security reports are welcome and are the main input. The pull request template and CONTRIBUTING
say so; the decision is to be revisited, together with a DCO, once the project has settled.

**Release flow.** Releases are cut from `main` by `.github/workflows/release.yml`. It can be started by pushing a tag
`vX.Y.Z` or by hand with the version as input; in the second case it creates and pushes the tag itself with
`GITHUB_TOKEN` (`contents: write` only for that job), but only after the version check and the full test suite, so a
failed run leaves no tag behind. This path exists because the maintainer's tooling cannot push tags. A tag pushed with
`GITHUB_TOKEN` does not trigger workflows, so there is no second run. The version in `package.json` and a dated
CHANGELOG section must match the tag, the release notes are that section (`scripts/changelog-section.mjs`), so the
changelog stays the single source. Images are multi-arch (amd64, arm64; arm64 built with QEMU, which is slow but
needs no extra runners) and tagged `X.Y.Z`, `X.Y` and `latest`; pre-releases get only their own tag. The amd64 image is
started and checked via `/healthz` before anything is pushed. Actions from GitHub (`actions/*`) and Docker
(`docker/*`) only, plus the preinstalled `gh` CLI for the release, no other third-party actions. CI and release use
`actions/checkout@v5` and `actions/setup-node@v5` (Node 24 runtime, ends the Node 20 deprecation warnings); newer
majors exist and are left to Dependabot.

**Third-party notices.** `THIRD_PARTY_NOTICES.md` lists the material that ships inside the repository or image (fonts,
icon data, separator data, Pyodide) with license texts, and a table of all runtime npm packages generated from
`package-lock.json` by `scripts/third-party-licenses.mjs` (no new dependency). The Docker image contains `LICENSE`
and the notices next to `node_modules`, whose packages carry their own license files.
