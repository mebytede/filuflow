# Status

Referenzversion: n8n **1.123.0** (Docker-Image `n8nio/n8n:1.123.0`, Quellcode-Tag `n8n@1.123.0`).

## Meilensteine
| # | Stand |
|---|---|
| M0 | fertig: Gerüst, Lint, Tests |
| M1 | fertig: Loader, Validator (alle Fehlerklassen aus SPEC 6), `flowlite validate`, `flowlite nodes` |
| M2 | fertig: Engine (v1-Stack, Positionssortierung, Merge-Warten, pinData, disabled, alwaysOutputData, executeOnce, onError, retry, Abbruch), Expression-Engine (vm, Timeout, Daten-Proxy, Paired Items) |
| M3a | fertig: manualTrigger, noOp, stickyNote, set (v1, v2, v3 bis 3.4), if (v2 bis 2.3), filter (v2 bis 2.3), switch (v3 bis 3.4), code (v1, v2, JS). Fixtures 1, 3, 6, 6b, 7, 10 grün gegen echtes n8n; Filter-Operatoren: 28.380 Fälle gegen n8n-Orakel |
| M3b | fertig: httpRequest (v3, v4 bis 4.3; ohne Pagination), merge (v3 bis 3.2, ohne combineBySql), splitOut, aggregate, splitInBatches v3, removeDuplicates (v1, 1.1, 2), sort, limit, summarize, dateTime v2, crypto, html (v1 bis 1.2), xml, wait (timeInterval/specificTime), executeWorkflow (v1 bis 1.3), executeWorkflowTrigger (v1, 1.1), stopAndError. Fixtures 2, 4, 5, 11 bis 15 grün gegen n8n |
| M3c | fertig: Expression-Erweiterungsfunktionen (String, Number, Boolean, Object, Array, Date), Extended Functions (`$min`, `$max`, `$ifEmpty`, `$if`, ...), optionale Ketten mit Erweiterungen. 1.012 Expression-Fälle gegen das n8n-Orakel (`Workflow.expression.getParameterValue`) identisch |
| M4 | fertig: `flowlite run` mit `--input`, `--trigger`, `--json`, `--only-last`, `--no-pin`, `--credentials`, `--vars`, `--workflows`; Übersicht pro Node, Maskierung von Credential-Werten, Validierung vor dem Start. Alle 14 Fixtures laufen auch über die CLI (eigener Prozess) identisch zu n8n |
| M5 | fertig: `flowlite serve` (fastify, Hot Reload), Webhook v1 bis 2.1 (alle Antwortmodi außer Streaming, Body-Formate JSON/Text/Formular/XML/multipart/binär, dynamische Pfade, mehrere Methoden, Basic/Header/Bearer/JWT-Auth, CORS), Respond to Webhook v1 bis 1.5, Schedule Trigger v1 bis 1.3, Error Trigger und `settings.errorWorkflow`, REST-API mit API-Key, SQLite-Log mit Aufbewahrung, Warteschlange mit Limit, Abbruch, `flowlite executions list/show`, Dockerfile und docker-compose. Fixtures 8 und 8b (16 Requests, Antworten und Executions) grün gegen echtes n8n |
| M6 | fertig: Credentials aus Datei/Verzeichnis/n8n-Export, Name mit ID-Fallback, `{{ env.NAME }}`, AES-256-GCM (`flowlite credentials encrypt/decrypt/check`), Validierung inkl. Env-Referenzen, Maskierung geheimer Felder. HTTP Request mit Header-, Basic-, Query-, Bearer-, Custom-Auth und OAuth2 client_credentials (Token-Anfrage, Signatur, erneuter Versuch nach 401): Fixture 16 grün gegen echtes n8n mit importierten Credentials. Webhook-Authentifizierung (Basic, Header, JWT): Fixture 8c grün |
| M7 | fertig: Basic LLM Chain (v1 bis 1.7), Structured Output Parser (v1 bis 1.3), Information Extractor, Text Classifier, Sentiment Analysis, AI Agent (Tools Agent v2 bis 3; v3 führt Tools über die Engine aus wie n8n), Modelle Gemini, OpenAI (Chat Completions), Anthropic, Tools Calculator, Code (JS), HTTP Request (v1, 1.1) und Workflow (v1 bis 2.2, mit `$fromAI`), Simple Memory. Fixtures 17 bis 22 grün gegen echtes n8n inklusive der gesendeten Requests (Grenzfälle: unbekanntes Tool, maximale Iterationen, Tool ohne execute bei Agent v3); Orakel für Schema und Parser (über 1.100 Fälle), Calculator und `$fromAI` (77 Fälle) |

## Hinweise
- Docker-Image: `docker build` konnte in der Build-Umgebung nicht geprüft werden (Docker Hub antwortet mit 429 Too Many Requests für `node:22-slim`).
- `fixtures/real/` fehlt noch: Es liegen keine echten Workflow-Exporte vor. Sobald welche vorhanden sind, mit `scripts/record-expected.sh` aufnehmen.
- Orakel neu aufnehmen: `scripts/record-filter-table.sh`, `scripts/record-expression-table.sh`, `scripts/record-ai-oracle.sh`, `scripts/record-ai-tools-oracle.sh` (brauchen Docker).
- Chat Trigger und Chat (Human in the Loop) sind laut SPEC 4.5 zurückgestellt, bis es eine Oberfläche gibt.
