# Sicherheitsmodell

Workflows, Expressions und Code-Nodes gelten als **vertrauenswürdig**: Sie stammen ausschließlich von internen Autoren.

`node:vm` dient hier dem Komfort (eigener globaler Kontext, Timeout), **nicht** als Sicherheitsgrenze.
Ein böswilliger Workflow kann aus dem vm-Kontext ausbrechen. Wer fremde Workflows ausführen will, braucht eine echte Isolation (eigener Prozess, Container, gVisor o. ä.).

Trotzdem gilt:
- Expressions laufen mit Timeout (Default 1000 ms), Code-Nodes mit Timeout (Default 60 s, `FLOWLITE_CODE_TIMEOUT_MS`).
- Im Sandbox-Kontext gibt es kein `require`, kein `process`, kein `import()`.
- `$env` liefert nur freigegebene Umgebungsvariablen (`FLOWLITE_ENV_ALLOW`, Default: Präfix `FL_`).
- Credential-Werte werden nie geloggt und im Execution-Log nicht gespeichert.
- Die REST-API ist mit `FLOWLITE_API_KEY` geschützt. Ohne gesetzten Schlüssel ist die API gesperrt (außer `/healthz` und Webhooks).
- Der Vergleich des API-Keys ist zeitkonstant. Webhooks sind ohne API-Key erreichbar; ihre Authentifizierung kommt aus dem Webhook-Node
  (Basic, Header, Bearer, JWT) mit Credentials aus `credentials.json`.
- Der Docker-Container läuft als Benutzer `node` (nicht root).
- Request-Bodys sind auf `FLOWLITE_PAYLOAD_SIZE_MAX` MB begrenzt (Default 16, wie n8n).
- KI-Agents lassen das Modell Tools aufrufen: Das HTTP Request Tool sendet Requests mit Werten vom Modell (bei
  Authentifizierung ist ein Platzhalter in der Domain verboten, wie in n8n), das Workflow-Tool startet Unter-Workflows, das
  Code-Tool führt seinen Code in derselben Sandbox wie der Code-Node aus (gleicher Timeout). Antworten von LLMs sind
  nicht vertrauenswürdig; Tools sollten nur mit den Rechten angeschlossen werden, die der Agent wirklich braucht.
- API-Keys der Modelle kommen aus Credentials und werden wie alle geheimen Felder maskiert.
- Weboberfläche: Die statischen Dateien sind ohne Anmeldung abrufbar und enthalten keine Daten; alle Daten kommen über die REST-API
  mit `X-API-Key`. Der Schlüssel liegt im localStorage des Browsers (Abmelden löscht ihn). Wer den API-Key hat, kann Workflows
  anlegen, ändern, löschen und ausführen, also auch Code-Nodes mit beliebigem Code; der Schlüssel ist entsprechend zu schützen.
  Für Zugriffe aus dem Netz einen Reverse Proxy mit HTTPS davorsetzen. Mit `FLOWLITE_UI=false` ist die Oberfläche abgeschaltet.
- Credentials erscheinen in der Oberfläche nur mit Name, ID und Typ; Werte verlassen den Server nicht. Ergebnisse von Ausführungen
  sind wie im Execution-Log maskiert.
- Die Seiten senden eine Content-Security-Policy (`script-src 'self'`, kein `eval`, keine fremden Quellen), `X-Content-Type-Options`
  und `frame-ancestors 'none'`. Statische Pfade außerhalb von `dist/ui` werden abgewiesen.
