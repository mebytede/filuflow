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

## Master und Worker (M9)
Benutzer des Masters sind das interne Team. Wer in einem Projekt bearbeiten darf, kann Code-Nodes schreiben und damit beliebigen
Code auf dem Worker des Projekts ausführen, also in der Umgebung des Mandanten. Das Recht "Bearbeiten" ist entsprechend zu vergeben.

Anmeldung und Sitzungen:
- Passwörter mit scrypt (N=32768, r=8, p=1, 16 Byte Salz), mindestens 12 Zeichen. Bei unbekannter E-Mail wird trotzdem ein Hash
  berechnet (gleiche Antwortzeit, gleiche Meldung).
- Nach 10 Fehlversuchen ist ein Konto 15 Minuten gesperrt; höchstens 20 Anmeldeversuche je IP und je E-Mail in 15 Minuten,
  5 TOTP-Versuche je Anmeldung in 5 Minuten. Hinter einem Reverse Proxy `FLOWLITE_TRUST_PROXY=true` setzen, damit die IP aus
  `X-Forwarded-For` zählt (sonst teilen sich alle die IP des Proxys). Ohne Proxy bleibt es aus, weil sonst jeder seine IP vorgeben
  könnte.
- TOTP nach RFC 6238 (SHA-1, 30 s, 6 Stellen, ±1 Zeitschritt), ein Code gilt nur einmal. Der Schlüssel liegt mit
  `FLOWLITE_ENCRYPTION_KEY` verschlüsselt (AES-256-GCM) in der Datenbank. Admins können TOTP für alle Benutzer mit Passwort
  vorschreiben; Notfall-Zugang über `flowlite master user reset-totp` auf dem Server.
- Sitzung als zufälliges Token im Cookie `flowlite_session` (HttpOnly, SameSite=Lax, Secure bei `https://` in
  `FLOWLITE_PUBLIC_URL`); in der Datenbank steht nur der SHA-256-Hash. Ablauf nach 12 Stunden ohne Aktivität
  (`FLOWLITE_SESSION_HOURS`), spätestens nach 7 Tagen. Abmelden, Sperren, Passwort- oder Rollenwechsel beenden Sitzungen sofort.
- CSRF: Jeder ändernde Request mit Sitzung (auch die Anmeldung) braucht den Header `X-Flowlite-Csrf: 1`. Fremde Seiten können
  ihn ohne CORS-Freigabe nicht setzen; der Master sendet keine CORS-Header.
- API-Tokens (`flt_…`, 32 Byte Zufall) werden nur beim Anlegen angezeigt und gehasht gespeichert, optional mit Ablaufdatum. Sie
  haben die Rechte ihres Benutzers; neue Tokens nur aus einer angemeldeten Sitzung.
- Der erste Admin entsteht über ein Einrichtungs-Token, das der Master beim Start ins Log schreibt (nur solange es keine Benutzer
  gibt), über `FLOWLITE_ADMIN_EMAIL`/`FLOWLITE_ADMIN_PASSWORD` oder `flowlite master user add --admin`.

Rechte:
- Projekte, in denen jemand kein Mitglied ist, sind für ihn unsichtbar (404 statt 403). Ausführungen und Credential-Namen eines
  Workers sieht nur, wer im zugehörigen Projekt lesen darf; Ausführungen werden auf die Workflows des Projekts gefiltert.
- Verwaltung (Benutzer, Mandanten, Worker, Credentials setzen, Audit-Log) nur für globale Admins. Der letzte aktive Admin kann
  nicht herabgestuft, gesperrt oder gelöscht werden.
- Audit-Log für Anmeldungen (auch fehlgeschlagene), Benutzer-, Projekt-, Workflow- und Worker-Änderungen, Ausführen über den Master
  und Credential-Änderungen, ohne Passwörter, Tokens oder Credential-Werte.

Verbindung zum Worker:
- Der Master meldet sich beim Worker mit dessen `FLOWLITE_API_KEY` (Header `X-API-Key`, mindestens 16 Zeichen) an. Die Tokens
  liegen mit `FLOWLITE_ENCRYPTION_KEY` verschlüsselt in der Datenbank des Masters und werden nie ausgegeben.
- Für Verbindungen über fremde Netze HTTPS verwenden; das TLS-Zertifikat wird geprüft (abschaltbar nur ausdrücklich je Worker,
  eigenes CA-Zertifikat möglich). Der Worker braucht keinen Zugang zum Master.
- Wer den Token eines Workers hat, kann dort Workflows verteilen und damit Code ausführen; er ist wie ein Root-Zugang zu behandeln.
- Credentials: Der Master überträgt neue Werte einmalig zum Worker, speichert sie nicht und kann sie nicht zurücklesen. Der Worker
  speichert sie in `credentials.managed.json` (Dateirechte 0600, mit `FLOWLITE_ENCRYPTION_KEY` des Workers verschlüsselt, wenn
  gesetzt). Einträge aus der von Hand gepflegten Credential-Datei des Workers kann der Master weder überschreiben noch löschen.
- Ausführungsdaten bleiben beim Worker und werden nur bei Bedarf über den Master angezeigt (maskiert wie im Execution-Log).
