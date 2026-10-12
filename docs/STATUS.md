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
| M3c | offen |
| M4 | offen |
| M5 | offen |
| M6 | offen |
| M7 | offen |
