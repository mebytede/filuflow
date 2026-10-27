# Security model

Workflows, expressions and code nodes are considered **trusted**: they come exclusively from internal authors.

`node:vm` serves convenience here (own global context, timeout), **not** as a security boundary.
A malicious workflow can break out of the vm context. Anyone who wants to run third-party workflows needs real isolation (separate process, container, gVisor or similar).

Still:
- Expressions run with a timeout (default 1000 ms), code nodes with a timeout (default 60 s, `FILUFLOW_CODE_TIMEOUT_MS`).
- Python (Pyodide) runs as WebAssembly in the server process. As in the reference implementation, the Python module `js` (access to JavaScript) and
  `os.system` are blocked, additionally `pyodide_js`; the file system is a separate in-memory one, not the server's. Anyone
  who sets out to do so can bypass the blocks (e.g. via Pyodide's internal modules); they prevent accidents, not attacks. The
  time limit is enforced by a separate thread via Pyodide's interrupt buffer, even for infinite loops. Runs are sequential;
  while Python is computing, the server's other tasks wait (as with JavaScript in the Code node).
- Python (Native) starts a separate process with the server's privileges. Before starting, filuflow checks the code like
  the reference implementation's task runner: imports only from the allowlists (default: none), no relative or dynamic imports, no attributes such
  as `__class__` or `__globals__`; builtins such as `eval`, `exec`, `open`, `getattr` are missing. The process gets an empty
  environment (no server keys), unless `FILUFLOW_PYTHON_ENV_ACCESS=true`. With allowed modules such as `os` or `subprocess`
  the code has full access to the system; that is a deliberate decision by the operator.
- In the sandbox context there is no `process` and no `import()`. As in the reference implementation, `require` only loads allowed modules
  (`NODE_FUNCTION_ALLOW_BUILTIN`, `NODE_FUNCTION_ALLOW_EXTERNAL` or `FILUFLOW_FUNCTION_ALLOW_*`, default: none); any
  other request ends with "Module 'x' is disallowed". With allowed modules such as `fs` or `child_process` the code has
  the server's privileges; that is a deliberate decision by the operator.
- Execute Workflow with the source "Local File" reads arbitrary server files, as in the reference implementation. This can be restricted with
  `FILUFLOW_RESTRICT_FILE_ACCESS_TO` (directories separated by ";"); symlinks are resolved in the process. The source
  "URL" loads via the server's HTTP client.
- Merge via SQL (alasql) cannot read or write files: alasql's file functions and sources are blocked
  (like the reference implementation).
- `$env` only returns allowed environment variables (`FILUFLOW_ENV_ALLOW`, default: prefix `FL_`).
- Chat with response nodes: the channel (`/chat/<id>/events`) and replies (`POST /chat/<id>`) are reachable without
  login like the chat page, but only with the sessionId the execution was started with. Anyone who knows the execution ID
  and sessionId can read along and reply; the chat page generates the sessionId randomly in the browser.
- Variables (`$vars`) are not secrets: the interface shows their values in plain text, they are stored unencrypted in
  SQLite. Logs only name the keys. Secrets belong in credentials.
- "Wait for test call" runs a state from the editor on the next call of the test URL. Only someone with the API key may
  do this (or in the master, someone with edit permission in the project); the test URLs themselves are reachable without
  login, as in the reference implementation.
- Credential values are never logged and not stored in the execution log.
- The REST API is protected with `FILUFLOW_API_KEY`. Without a key set, the API is locked (except `/healthz` and webhooks).
- The API key comparison is constant-time. Webhooks are reachable without an API key; their authentication comes from the Webhook node
  (Basic, Header, Bearer, JWT) with credentials from `credentials.json`.
- The Docker container runs as user `node` (not root).
- Request bodies are limited to `FILUFLOW_PAYLOAD_SIZE_MAX` MB (default 16, like the reference implementation).
- AI agents let the model call tools: the HTTP Request Tool sends requests with values from the model (with
  authentication, a placeholder in the domain is forbidden, as in the reference implementation), the Workflow Tool starts sub-workflows, the
  Code Tool runs its code in the same sandbox as the Code node (same timeout). LLM responses are not
  trustworthy; tools should only be connected with the privileges the agent really needs.
- Model API keys come from credentials and are masked like all secret fields.
- Web interface: the static files can be fetched without login and contain no data; all data comes via the REST API
  with `X-API-Key`. The key is stored in the browser's localStorage (logging out deletes it). Anyone with the API key can
  create, change, delete and run workflows, including code nodes with arbitrary code; the key must be protected accordingly.
  For access from the network, put a reverse proxy with HTTPS in front. With `FILUFLOW_UI=false` the interface is disabled.
- Credentials in the interface: reading returns name, ID, type, the public fields (e.g. header name, client ID, URL) and the
  names of the secret fields that are set, never their values. Secret are the fields with `typeOptions.password` of the
  credential type definitions, the JSON of Custom Auth and, for unknown types, fields whose name looks like password, secret, token, key
  or value. When editing, the interface lists in `keep` the secret fields that should remain unchanged; the server only keeps them
  if the type is the same. Data is stored in `credentials.managed.json` (file mode 0600, replaced atomically, with
  `FILUFLOW_ENCRYPTION_KEY` AES-256-GCM encrypted per entry). Without a key the values are stored in plain text in the file; the
  interface points this out. Entries from the hand-maintained `credentials.json` cannot be changed via the API. The
  log names the name and type of changed credentials, never values. Anyone with the API key can create and change credentials and,
  via workflows (Code node, HTTP Request to their own servers), also use the values of existing credentials; the separation
  protects against accidental display, not against an attacker with the API key.
- OAuth2 "Authorization Code"/"PKCE": authorization only starts with the API key (or as an admin in the master). The callback
  `/rest/oauth2-credential/callback` is reachable without login (the browser returns from the provider) and only accepts
  a one-time, random `state` valid for 10 minutes; with PKCE the `code_verifier` stays on the server. Tokens
  are stored encrypted in the database (on the worker), not in the interface and not in the master.
- OAuth1: same procedure with `/rest/oauth1-credential/callback`; the one-time `state` is in the redirect URL,
  which filuflow registers with the provider as `oauth_callback`. Access token and token secret are stored encrypted in the
  worker's database like OAuth2 tokens.
- Import of exported credentials: the source instance's encryption key is only used for decryption, never stored or logged. The import response
  only names names. Entries from `credentials.json` are never overwritten.
- Sharing with projects (master): a credential with sharing can only be used in the named projects; the
  master rejects workflows of other projects on create, save and run. Sharing protects against
  accidental use; anyone allowed to write code nodes in the project can still reach the worker's files
  and environment (see below).
- Forms: the pages under `/form/` and `/form-waiting/` run without scripts (CSP `script-src 'none'`). Descriptions
  and custom HTML are reduced to allowed tags (like the reference implementation: text, lists, tables, links, images, videos, iframes in
  a sandbox), links and sources only via http(s). Anyone who knows the address of a follow-up page can fill it out; for
  confidential processes use Basic auth on the Form Trigger.
- Chat Trigger: a public chat is reachable without login, unless the node requires Basic auth. Every message
  starts an execution; for the internet, put rate limiting (reverse proxy) in front. The chat page only loads its own
  scripts (CSP `script-src 'self'`), settings are embedded as JSON data in the page; custom CSS (`customCss`) is allowed.
- Execution results are masked like in the execution log.
- Waiting executions: to resume, filuflow stores the state unmasked (the data flows into later nodes), in
  a separate table, encrypted with `FILUFLOW_ENCRYPTION_KEY`, and deletes it on resume or cancellation. OAuth2 tokens
  are likewise stored encrypted in the database. Anyone who knows `$execution.resumeUrl` can resume the execution; for approvals
  the Wait node should use authentication (`incomingAuthentication`), the URL only contains the execution ID.
- The pages send a Content Security Policy (`script-src 'self'`, no `eval`, no third-party sources), `X-Content-Type-Options`
  and `frame-ancestors 'none'`. Static paths outside `dist/ui` are rejected.

## Gmail (M40)
The service account key (`googleApi`) stays on the server: it only signs the JWT for the token request and is never
sent (the reference implementation puts it into the JWT header). Access tokens are kept in memory until shortly before they expire.
The links in "Send and Wait for Response" emails are signed with HMAC-SHA256 (secret from
`FILUFLOW_HMAC_SIGNATURE_SECRET` or generated and stored in the database); a changed link
(e.g. `approved=false` instead of `true`) is rejected with 401, link previews of bots do not count as an answer. Anyone
who has the email can answer, as in the reference implementation.

## Supervisor (M35)
The Supervisor sends data to the configured model, i.e. to that model's provider. What goes out:
- always: the workflow structure (nodes, parameters, connections, settings), error messages, status and runtimes
  of the executions, texts of the findings;
- only with the data scope "With sample data": truncated data (at most two items, about 1500 characters) of the node at which
  an execution failed and of its predecessor, as well as truncated test data (pinData).

What never goes out: credential values. Credentials only appear by name; all known secret values are replaced in every
text (as in the execution log); parameters whose name suggests a secret (password, token, apiKey,
authorization, secret …) or whose value looks like a key (sk-…, ghp_…, Bearer …) are sent as `***`.
Static workflow data is not sent. The model never sees workflows on the "Excluded workflows" list.
Anyone who does not want to give data to an external provider uses Ollama on their own server or no model (fixed
rules only).

The Supervisor changes nothing on its own. Its tools only read; changes arise as a proposal that a human accepts
(M36). Proposals cannot write back masked values, accepting does not change the activation, and a test run
that actually executes nodes only starts after a confirmation. Anyone allowed to use the server's REST API may also
accept proposals; in the master this is governed by roles (M38): findings and proposals are visible to anyone with
`supervisor.read` for the workflow, analyses, proposals and conversations (costs, data sent to the model) need
`supervisor.use`, accepting additionally `workflow.edit`. Proposals cannot be accepted on the worker itself. Findings,
analyses and proposals go to the master, no execution data; the Supervisor settings per worker can only be changed by global
admins (with an audit entry).
Model responses are displayed as text, not as HTML. The daily budget limits costs even when an
error occurs very frequently.

## Simple Vector Store (M27)
The Simple Vector Store keeps documents and embeddings in the process's memory, shared across all workflows of this
process with the same key (from v1.2 without workflow ID, like the reference implementation). Workflows on a worker can therefore read and overwrite
the data of other workflows on the same worker. Confidential content therefore belongs in its own keys or on
separate workers; nothing is stored permanently.

## Plugins (M24)
Plugins (own modules and nodes in the community node format) run without a sandbox in the filuflow process, with all privileges of the process
(files, network, environment, credentials of other workflows). Like workflows, they are considered trusted: only put packages from
known sources into the plugin folders and keep these folders writable only by operators. Credential values reach
plugins only via `getCredentials` of the respective node; in logs and executions they are masked as usual.

Community packages from the interface (M30) are the same: anyone allowed to install (on a single server anyone with the API key, in the
master only global admins, on the worker the master) can use this to run arbitrary code with filuflow's privileges.
filuflow installs without npm install scripts (`--ignore-scripts`), checks the package name strictly (only `n8n-nodes-…`,
no special characters) and calls npm without a shell; the package's code still runs when loaded. Where this is not wanted,
`FILUFLOW_COMMUNITY_PACKAGES_ENABLED=false` disables installation (packages already installed are still loaded).

## Master and Worker (M9)
Shared credentials (M33) are stored in the master encrypted with `FILUFLOW_ENCRYPTION_KEY` and travel in plain text only over
the connection to the worker (TLS recommended) to the selected workers; the interface never gets secret values back. Anyone who has
the master key and the database can decrypt them; on the worker the rules for credentials managed there
apply.

Users of the master are the internal team. Anyone allowed to edit in a project can write code nodes and thereby run arbitrary
code on the project's worker, i.e. in the tenant's environment. Grant the "Edit" permission accordingly.
This also applies to edit permissions on a single workflow (M23): anyone allowed to edit a workflow reaches the whole worker via its
code nodes, including credentials and data of other workflows there. "No access" for a workflow protects
against viewing in the master (workflow, executions and their data), not against project members who may run code
on the same worker.

Roles per workflow and execution search:
- The effective role for a workflow is always admin for project admins, otherwise the person's own role for the workflow (if set)
  or the project role. Blocked workflows respond with 404 (not 403) so that their existence is not revealed.
- Removal from a project also deletes the person's roles for its workflows.
- The central search asks each worker only for the workflow IDs the person may read, and discards hits for other
  workflows once more in the master. Execution data is only loaded by the detail view, with the same check.

Login and sessions:
- Passwords with scrypt (N=32768, r=8, p=1, 16 byte salt), at least 12 characters. For an unknown email a hash is still
  computed (same response time, same message).
- After 10 failed attempts an account is locked for 15 minutes; at most 20 login attempts per IP and per email in 15 minutes,
  5 TOTP attempts per login in 5 minutes. Behind a reverse proxy set `FILUFLOW_TRUST_PROXY=true` so that the IP from
  `X-Forwarded-For` counts (otherwise everyone shares the proxy's IP). Without a proxy it stays off, because otherwise anyone could
  claim any IP.
- TOTP per RFC 6238 (SHA-1, 30 s, 6 digits, ±1 time step), a code is valid only once. The secret is stored encrypted with
  `FILUFLOW_ENCRYPTION_KEY` (AES-256-GCM) in the database. Admins can require TOTP for all users with a password;
  emergency access via `filuflow master user reset-totp` on the server.
- Session as a random token in the cookie `filuflow_session` (HttpOnly, SameSite=Lax, Secure with `https://` in
  `FILUFLOW_PUBLIC_URL`); the database only stores the SHA-256 hash. Expiry after 12 hours of inactivity
  (`FILUFLOW_SESSION_HOURS`), at the latest after 7 days. Logging out, locking, password or role changes end sessions immediately.
- CSRF: every modifying request with a session (including login) needs the header `X-Filuflow-Csrf: 1`. Third-party pages cannot
  set it without CORS permission; the master sends no CORS headers.
- API tokens (`ffl_…`, before the rename `flt_…`, both valid; 32 bytes of randomness) are only shown on creation and stored hashed, optionally with an expiry date. They
  have the permissions of their user; new tokens only from a logged-in session.
- The first admin is created via a setup token that the master writes to the log at startup (only as long as there are no users),
  via `FILUFLOW_ADMIN_EMAIL`/`FILUFLOW_ADMIN_PASSWORD` or `filuflow master user add --admin`.

SSO (OpenID Connect):
- Authorization code flow with PKCE (S256); `state`, `nonce` and verifier are stored encrypted in a cookie (10 minutes, only
  `/api/auth/oidc`). The ID token is fully verified: signature via the issuer's JWKS (RS256/384/512, PS256/384/512,
  ES256/384/512; unknown algorithms and `none` are rejected), issuer, audience (`aud`), expiry and issued-at time
  (60 s tolerance), `nonce`. The issuer in the discovery document must match the configuration.
- Mapping via `iss` + `sub`, the first time via the email. An email counts as verified as long as the identity provider does not
  explicitly report `email_verified: false` (Entra ID does not send the claim). This assumes that users cannot freely choose their
  email at the identity provider; otherwise set `FILUFLOW_OIDC_ALLOWED_DOMAINS` and create users in advance instead of
  `FILUFLOW_OIDC_AUTO_CREATE`.
- Locked users cannot log in via SSO either. Failed SSO logins are recorded in the audit log.

Permissions:
- Projects in which someone is not a member are invisible to them (404 instead of 403). Executions and credential names of a
  worker are only visible to those who may read in the associated project; executions are filtered to the project's workflows.
- Administration (users, tenants, workers, setting credentials, audit log) only for global admins. The last active admin cannot
  be demoted, locked or deleted.
- Audit log for logins (including failed ones), user, project, workflow and worker changes, runs via the master
  and credential changes, without passwords, tokens or credential values.

Connection to the worker:
- The master authenticates to the worker with the worker's `FILUFLOW_API_KEY` (header `X-API-Key`, at least 16 characters). The tokens
  are stored encrypted with `FILUFLOW_ENCRYPTION_KEY` in the master's database and are never output.
- For connections over untrusted networks use HTTPS; the TLS certificate is verified (can only be disabled explicitly per worker,
  own CA certificate possible). The worker needs no access to the master.
- Anyone with a worker's token can distribute workflows there and thereby run code; treat it like root access.
- Credentials: the master transfers new values once to the worker, does not store them and cannot read back secret values
  (only public fields for the edit form). In a project's editor only global admins can create new credentials on the
  worker. The worker
  stores them in `credentials.managed.json` (file mode 0600, encrypted with the worker's `FILUFLOW_ENCRYPTION_KEY` if
  set). The master can neither overwrite nor delete entries from the worker's hand-maintained credential file.
- Execution data stays on the worker and is only displayed via the master when needed (masked like in the execution log).
