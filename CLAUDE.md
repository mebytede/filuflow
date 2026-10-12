# flowlite: n8n-kompatible Workflow-Engine (internes Tool)

## Was das ist
flowlite führt **n8n-Workflow-JSONs** (Export aus n8n, `executionOrder: "v1"`) ohne n8n aus.
Internes Tool, kein Produkt. Erst Engine, CLI und Server; ein Editor kommt später.
Die vollständige Spezifikation mit Meilensteinen steht in `docs/SPEC.md`. Lies sie vor jeder Arbeit.

## Leitplanken
- **Kompatibilität schlägt Eleganz.** Wenn n8n sich in einem Punkt seltsam verhält, verhält sich flowlite genauso. Abweichungen nur bewusst und in `docs/DEVIATIONS.md` dokumentiert.
- **Referenz ist der n8n-Quellcode** (`github.com/n8n-io/n8n`, v. a. `packages/workflow`, `packages/core`, `packages/nodes-base`, `packages/@n8n/nodes-langchain`). Nutze ihn, um Parameter-Schemas und Verhalten nachzuvollziehen. **Keinen Code kopieren** (Sustainable Use License): Verhalten nachbauen, eigene Implementierung schreiben.
- **Nicht raten.** Ist ein Parametername, Default oder Verhalten unklar, im n8n-Quellcode nachsehen und die Fundstelle (Datei, Node-Version) als Kommentar über der Implementierung notieren.
- **Unbekannte Node-Typen oder Versionen** führen nie zu stillem Fehlverhalten: `validate` meldet sie, `run` bricht vor dem Start mit klarer Liste ab.
- **Kleine Schritte.** Pro Meilenstein: implementieren, Tests grün, `docs/STATUS.md` aktualisieren, dann erst weiter.

## Stack
- Node.js 22 LTS, TypeScript (strict), ESM
- Paketmanager: npm
- Tests: vitest
- Datum/Zeit: luxon (n8n nutzt luxon, `$now` muss ein luxon `DateTime` sein)
- Persistenz: SQLite über `better-sqlite3`
- HTTP-Server: fastify
- Cron: croner
- Keine weiteren Laufzeit-Abhängigkeiten ohne Begründung in `docs/DECISIONS.md`

## Befehle
```bash
npm run build        # tsc
npm test             # vitest run
npm run test:compat  # Golden-Tests gegen fixtures/
npm run lint         # eslint + tsc --noEmit
npx flowlite validate <workflow.json>
npx flowlite run <workflow.json> [--input data.json] [--json]
npx flowlite serve [--dir ./workflows] [--port 5678]
```

## Code-Konventionen
- Ein Node-Typ = eine Datei unter `src/nodes/<typname>.ts`, registriert in `src/nodes/index.ts`
- Jede Node-Implementierung deklariert die unterstützten `typeVersion`s explizit
- Keine `any` ohne Kommentar, warum
- Fehler sind Klassen aus `src/errors.ts` (`NodeOperationError`, `ExpressionError`, `WorkflowValidationError`) mit Node-Name und Item-Index
- Logs strukturiert (pino), keine `console.log` im Engine-Code
- Secrets nie loggen, auch nicht im Execution-Log (Credential-Werte maskieren)

## Sicherheitsmodell
Workflows und Code-Nodes gelten als **vertrauenswürdig** (nur interne Autoren). `node:vm` ist hier Komfort, keine Sicherheitsgrenze. Trotzdem: Code-Nodes und Expressions mit Timeout, kein `require`/`process` im Sandbox-Kontext, und das in `docs/SECURITY.md` klar so beschreiben.

## Texte
Doku und Kommentare auf Deutsch, Bezeichner auf Englisch. Keine Gedankenstriche (—) in Texten.
