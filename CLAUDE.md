# filuflow: workflow platform with editor, server and multi-tenant operation

## What this is
filuflow is a product of its own: workflow engine, browser editor, CLI, server with webhooks and schedules, AI nodes and
multi-user / multi-tenant operation (master and workers). Workflows use the common workflow JSON format (nodes, connections, `typeVersion`, `executionOrder: "v1"`).
The scope is open; the specification with milestones and planned work is in `docs/SPEC.md`. Read it before any work.

## Guardrails
- **Exported workflows keep working.** Nodes in the common workflow format behave as in the reference implementation (golden tests in `fixtures/`), so exported workflows and community node packages run without changes. Own features beyond that are explicitly welcome.
- **Reference implementation:** the source of the npm packages `n8n-workflow`, `n8n-core`, `n8n-nodes-base` and `@n8n/n8n-nodes-langchain` in the reference version 1.123.0 (nodes-base 1.121.0). Use it to understand parameter schemas and behavior. **Do not copy code** (Sustainable Use License): rebuild the behavior, write your own implementation.
- **Do not guess.** If a parameter name, default or behavior is unclear, look it up in the reference source and note the location (package, version, file, node version) as a comment above the implementation, e.g. `Reference: n8n-nodes-base 1.121.0, nodes/Set/v2/SetV2.node.ts`.
- **Unknown node types or versions** never lead to silent misbehavior: `validate` reports them, `run` stops before starting with a clear list.
- **Neutral naming.** Do not use the reference product's name in prose, UI, messages, docs, comments or tests; only technical identifiers that the format or packages require may contain it (node and credential type strings, package names, format-defined keys).
- **Small steps.** Per milestone: implement, tests green, update `docs/STATUS.md`, then move on.

## Stack
- Node.js 22 LTS, TypeScript (strict), ESM
- Package manager: npm
- Tests: vitest
- Date/time: luxon (the reference uses luxon, `$now` must be a luxon `DateTime`)
- Persistence: SQLite via `better-sqlite3`
- HTTP server: fastify
- Cron: croner
- No further runtime dependencies without a justification in `docs/DECISIONS.md`

## Commands
```bash
npm run build        # tsc
npm test             # vitest run
npm run test:compat  # golden tests against fixtures/
npm run lint         # eslint + tsc --noEmit
npx filuflow validate <workflow.json>
npx filuflow run <workflow.json> [--input data.json] [--json]
npx filuflow serve [--dir ./workflows] [--port 5678]
```

## Code conventions
- One node type = one file under `src/nodes/<typename>.ts`, registered in `src/nodes/index.ts`
- Every node implementation declares its supported `typeVersion`s explicitly
- No `any` without a comment explaining why
- Errors are classes from `src/errors.ts` (`NodeOperationError`, `ExpressionError`, `WorkflowValidationError`) with node name and item index
- Structured logs (pino), no `console.log` in engine code
- Never log secrets, not even in the execution log (mask credential values)

## Security model
Workflows and code nodes are considered **trusted** (internal authors only). `node:vm` is a convenience here, not a security boundary. Still: code nodes and expressions with a timeout, no `require`/`process` in the sandbox context, and say so clearly in `docs/SECURITY.md`.

## Language
- Code, comments, documentation, tests, commit messages and pull requests are in English.
- Server, CLI, logs, validator and API messages are English only.
- The web interface is English by default and can be switched to German (per browser). Interface texts are written in
  English in the code and wrapped in `t()` from `src/ui/i18n.ts`; the German translation goes into the matching catalog
  under `src/ui/locales/de/`. Labels of node parameters and credential fields are English in their definitions and get a
  German entry in `params-nodes-*.ts` or `params-credentials.ts`.
- German interface texts address the user formally ("Sie").
- No em dashes (—) in any text.
