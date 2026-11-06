# Changelog

All notable changes to filuflow are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor versions may contain
breaking changes; they are listed under "Changed" or "Removed".

## [Unreleased]

### Added

- **Microsoft Outlook node.** Messages (send with attachments, reply, move, update, get and list with search, filters
  and attachment download, the whole message as an .eml file, delete), drafts, mail folders and the messages of a
  folder, message attachments (add, also large files, download, list), calendars, events (also all-day events and
  events of all calendars) and contacts of a Microsoft 365 or Outlook.com mailbox, also of a shared mailbox, through
  Microsoft Graph. "Send and Wait for Response" sends an email with approval buttons or a link to a response form and
  continues the workflow when someone answers. Calendars, contacts, drafts, messages, events, folders and attachments
  are picked from searchable lists in the editor, categories and folders from option lists. Exported workflows with
  Outlook nodes of version 2 run without changes; version 1 is reported as not supported. German texts included.
- **Slack Trigger.** Starts a workflow on Slack events (any event, mentions of the app, shared or public files, new
  messages, new public channels, new users, reactions) sent by the Slack Events API to the trigger's URL, for one
  channel or the whole workspace. Requests are checked against the app's signing secret ("Signature Secret" in the Slack
  credential) and Slack's URL check is answered automatically. Options resolve user and channel IDs to names, ignore
  chosen users and download shared files as binary data. The editor shows the production and test URL to enter in the
  Slack app. Exported workflows with the Slack Trigger run without changes. German texts included.
- **Slack node.** Channels (create, archive, history, replies, members, invite, kick and more), messages (send as text,
  blocks or attachments to a channel or user, as thread reply or ephemeral message; update, delete, permalink, search),
  files (upload from binary data, get, list), reactions, stars, users (profile and status) and user groups, with an
  access token or OAuth2. "Send and Wait for Response" posts a message with approval buttons or a link to a response
  form and continues the workflow when someone answers. Channels and users are picked from searchable lists in the
  editor, also by ID, name or URL. Exported workflows with Slack nodes of version 2 to 2.4 run without changes; version 1
  is reported as not supported. German texts included.
- **Dynamic option lists in the editor.** Fields whose values come from a connected account are now picked from a list
  loaded from the service when the field opens, with search, refresh and manual entry; expressions keep working. First
  users: Gmail labels (all label fields, also in the Gmail Trigger), the "send as" alias of drafts and the message of a
  thread reply. Stored values do not change, so existing workflows keep working. New endpoints
  `POST /api/editor/load-options` (single server and worker) and `POST /api/projects/:pid/load-options` (master, needs the
  "Edit" permission and checks credential sharing), with rate limits and masked error messages. German texts included.
- **Searchable resource lists, model lists and a workflow picker.** Resource locator fields in "From list" mode search on
  the service while you type, load further pages with "Load more" and remember the chosen entry's name, so the closed
  field shows it without a request; ID and URL modes check their format while typing, and the engine now extracts the ID
  from URL mode values like the reference (also for nodes from community packages). The model fields of the OpenAI,
  Anthropic, Gemini, Groq, Mistral, DeepSeek, OpenRouter and Ollama chat models and of Embeddings OpenAI list the
  provider's models (Azure OpenAI stays a text field). Execute Workflow and the workflow tool offer a workflow picker
  (in the master: the workflows of the same project). Stored values do not change. A resolved expression whose result
  starts with "=" is no longer evaluated a second time when a list loads.
- **Dynamic option lists for community node packages.** Fields of package nodes that load their values
  (`loadOptionsMethod`, resource locator lists with `searchListMethod`, declarative `loadOptions.routing`) now show the
  loaded list in the editor instead of a text field, using the methods of the node's own version. Resource locator modes
  of packages keep their URL extraction and format checks. Stored values do not change.

## [0.1.1] - 2026-11-04

### Changed

- **The installer uses the published image and installs releases by default.** `scripts/install.sh` with Docker pulls
  `ghcr.io/mebytede/filuflow:<version>` of the latest release instead of building `main` from source; the native method
  builds the release tag instead of `main`. `--version X.Y.Z` pins a release, `--build` builds the image from the
  release's source, `--ref` builds a branch or commit (e.g. `main`), `--source` and `--image` work as before. The image
  is recorded as `FILUFLOW_IMAGE` in `.env`. `--update` moves to the latest release (or `--version`), prints the old and
  new version and keeps the way the installation was made; a plain re-run keeps the version. `--version` is no longer an
  alias of `--ref`. Docker installations made with the 0.1.0 installer keep building their git ref;
  `--update --version latest --no-build` switches them to the release image.

### Fixed

- **Invalid numeric query parameters no longer cause a 500 with an SQL error.** `limit` (and the audit log's `before`) on
  the list endpoints of the single server, the worker and the master, and `limit` in the execution search body, must be
  whole numbers of at least 1; anything else (letters, decimals, zero, negative numbers, repeated keys) is answered with
  400 and a message naming the parameter. Values above the endpoint's maximum are capped. Text filters given several
  times are rejected with 400 as well.

### Security

- **Internal error texts are no longer sent to clients.** Unexpected errors in the server, worker and master are
  answered with a generic "Internal server error" (500) and logged instead of returning the original message, which
  could contain SQL errors.
- **Supervisor proposals for new workflows are scoped to their project.** A workflow drafted in the editor chat of the
  master was visible to, and could be accepted by, editors of any project on the same worker. Such proposals now record
  the project of the conversation; only members of that project can see, test, reject or accept them, and they are only
  created in that project. Proposals of this kind created before this release have no project and are visible to
  global admins only.

## [0.1.0] - 2026-10-30

First public release.

### Added

- **Workflow engine for the common workflow JSON format** (nodes, connections, `typeVersion`, `executionOrder: "v1"`):
  exported workflows run without changes and produce the same data at the same nodes as the reference implementation
  (reference version 1.123.0), verified by golden tests against recorded reference results. Expressions with the
  standard extension functions, `$now` as a luxon `DateTime`, paired items, pinned data, retries,
  error outputs, waiting executions and error workflows.
- **Validation before every run**: unknown node types or versions are reported by `filuflow validate` and stop
  `filuflow run` before it starts.
- **Core nodes**: Set, If, Filter, Switch, Merge (including SQL), loops, Split Out, Aggregate, Sort, Limit, Summarize,
  Remove Duplicates, Date & Time, Crypto, HTML, XML, Wait, Execute Workflow and more; Code node in JavaScript and Python
  (Pyodide, optionally native Python) with the standard helpers.
- **HTTP Request** with pagination, Digest auth, client certificates and all credential types; Gmail node and Gmail
  Trigger.
- **Triggers**: webhooks with response nodes, authentication and streaming, schedules, forms, chat (hosted and
  embedded, human in the loop), polling, error triggers and calls from other workflows.
- **AI nodes**: AI Agent, Basic LLM Chain, Information Extractor, Text Classifier, Sentiment Analysis, chat models
  (OpenAI, Anthropic, Google Gemini, Azure OpenAI, Mistral, Groq, DeepSeek, OpenRouter, Ollama), tools, memory,
  embeddings, vector stores and retrieval (RAG).
- **Credentials** from files, exported credential files (also encrypted) or the interface, stored encrypted (AES-256-GCM), OAuth1
  and OAuth2 with PKCE; secret values are masked in logs and the execution log.
- **Browser editor**: canvas with palette, parameter forms per node type, undo and redo, test runs, pinned test data,
  "Execute up to here", run history with node by node trace, variables, light and dark theme; English interface with
  German as an option.
- **Server** (`filuflow serve`): REST API with API keys, execution log in SQLite with retention, queue, cancellation,
  hot reload of the workflow folder.
- **CLI**: `validate`, `run` (with input, credentials, variables and JSON output), `serve`, `executions`, `nodes` and
  `credentials` (encrypt, decrypt, check, and `credentials import` for exported credential files; encrypted exports
  take the source instance's key from `--import-key` or `FILUFLOW_IMPORT_ENCRYPTION_KEY`, the key is never stored).
- **Multiple users and tenants**: master with users, password and TOTP login, OpenID Connect, projects, roles per
  project and workflow, custom roles, shared credentials, audit log, central execution search, and workers per tenant
  that receive their workflows from the master.
- **Supervisor**: rules and model based analysis of failed executions, proposals as a diff that can be tested and
  accepted, a conversation in the editor that changes or creates workflows; also across workers in the master.
- **Extensibility**: custom nodes and community node packages (programmatic, declarative, poll, trigger and webhook
  nodes), installable from the interface.
- **Installation**: multi-arch Docker image for amd64 and arm64 (`ghcr.io/mebytede/filuflow`), Docker Compose examples
  for single server, master and worker, and the installation script `scripts/install.sh`: single server, master or
  worker with Docker Compose or natively with Node.js 22 and a hardened systemd unit, generated secrets, optional
  HTTPS through Caddy, updates, uninstall and a dry run that installs nothing. Step by step guide in `docs/INSTALL.md`.
- **Configuration** through `FILUFLOW_*` environment variables only (the Code node additionally reads the common
  `NODE_FUNCTION_ALLOW_BUILTIN` and `NODE_FUNCTION_ALLOW_EXTERNAL`); see the table in the README.
- **Neutral wording**: interface, messages and documentation describe compatibility in neutral terms ("common
  workflow JSON format", "reference implementation"); node and credential type strings in workflows stay unchanged.
- **License**: AGPL-3.0-or-later, with notices for bundled third-party components in `THIRD_PARTY_NOTICES.md`.

[Unreleased]: https://github.com/mebytede/filuflow/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mebytede/filuflow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mebytede/filuflow/releases/tag/v0.1.0
