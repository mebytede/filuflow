# Changelog

All notable changes to filuflow are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor versions may contain
breaking changes; they are listed under "Changed" or "Removed".

## [Unreleased]

## [0.1.0] - Unreleased

First public release.

### Added

- **Workflow engine for the n8n format** (`executionOrder: "v1"`): exported n8n workflows run without changes and
  produce the same data at the same nodes as n8n 1.x (reference 1.123.0), verified by golden tests against real n8n.
  Expressions with the n8n extension functions, `$now` as a luxon `DateTime`, paired items, pinned data, retries,
  error outputs, waiting executions and error workflows.
- **Validation before every run**: unknown node types or versions are reported by `filuflow validate` and stop
  `filuflow run` before it starts.
- **Core nodes**: Set, If, Filter, Switch, Merge (including SQL), loops, Split Out, Aggregate, Sort, Limit, Summarize,
  Remove Duplicates, Date & Time, Crypto, HTML, XML, Wait, Execute Workflow and more; Code node in JavaScript and Python
  (Pyodide, optionally native Python) with the n8n helpers.
- **HTTP Request** with pagination, Digest auth, client certificates and all credential types; Gmail node and Gmail
  Trigger.
- **Triggers**: webhooks with response nodes, authentication and streaming, schedules, forms, chat (hosted and
  embedded, human in the loop), polling, error triggers and calls from other workflows.
- **AI nodes**: AI Agent, Basic LLM Chain, Information Extractor, Text Classifier, Sentiment Analysis, chat models
  (OpenAI, Anthropic, Gemini), tools, memory, embeddings, vector stores and retrieval (RAG).
- **Credentials** from files, n8n exports (also encrypted) or the interface, stored encrypted (AES-256-GCM), OAuth1
  and OAuth2 with PKCE; secret values are masked in logs and the execution log.
- **Browser editor**: canvas with palette, parameter forms per node type, undo and redo, test runs, pinned test data,
  "Execute up to here", run history with node by node trace, variables, light and dark theme; English interface with
  German as an option.
- **Server** (`filuflow serve`): REST API with API keys, execution log in SQLite with retention, queue, cancellation,
  hot reload of the workflow folder.
- **CLI**: `validate`, `run` (with input, credentials, variables and JSON output), `serve`, `executions`, `credentials`.
- **Multiple users and tenants**: master with users, password and TOTP login, OpenID Connect, projects, roles per
  project and workflow, custom roles, shared credentials, audit log, central execution search, and workers per tenant
  that receive their workflows from the master.
- **Supervisor**: rules and model based analysis of failed executions, proposals as a diff that can be tested and
  accepted, a conversation in the editor that changes or creates workflows; also across workers in the master.
- **Extensibility**: custom nodes and n8n community packages (programmatic, declarative, poll, trigger and webhook
  nodes), installable from the interface.
- **Installation**: Docker image (`ghcr.io/mebytede/filuflow`), Docker Compose examples for single server, master and
  worker, and `scripts/install.sh` for Docker or systemd with optional HTTPS through Caddy.

[Unreleased]: https://github.com/mebytede/filuflow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mebytede/filuflow/releases/tag/v0.1.0
