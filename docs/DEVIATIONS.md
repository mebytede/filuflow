# Bewusste Abweichungen von n8n

Jede Abweichung ist hier mit Grund aufgeführt. Alles, was hier nicht steht und sich anders verhält als n8n 1.123.0, ist ein Fehler.

## Code-Node
- **Kein `require`.** n8n erlaubt eingebaute/externe Module über `NODE_FUNCTION_ALLOW_BUILTIN`/`_EXTERNAL`. flowlite stellt laut
  CLAUDE.md kein `require` im Sandbox-Kontext bereit. Häufig gebrauchte Globals (`Buffer`, `URL`, `setTimeout`, `TextEncoder`, …) sind vorhanden.
- **Timeout** (Default 60 s, `FLOWLITE_CODE_TIMEOUT_MS`). n8n hat im In-Process-Modus kein Timeout.
- **Python** wird abgelehnt (`validate` meldet es, `run` bricht ab).
- **`console.log`** landet im Execution-Log (n8n verwirft die Ausgabe außerhalb des Editors).
- `helpers` enthält nur eine Teilmenge (`getBinaryDataBuffer`, `prepareBinaryData`, `httpRequest`, `returnJsonArray`, `normalizeItems`).

## pinData
n8n nutzt `pinData` nur bei manuellen Ausführungen aus dem Editor. flowlite nutzt sie laut SPEC auch bei `flowlite run`
(abschaltbar mit `--no-pin`); im Server (Webhook/Schedule) werden sie wie in n8n ignoriert.
