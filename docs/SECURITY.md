# Sicherheitsmodell

Workflows, Expressions und Code-Nodes gelten als **vertrauenswürdig**: Sie stammen ausschließlich von internen Autoren.

`node:vm` dient hier dem Komfort (eigener globaler Kontext, Timeout), **nicht** als Sicherheitsgrenze.
Ein böswilliger Workflow kann aus dem vm-Kontext ausbrechen. Wer fremde Workflows ausführen will, braucht eine echte Isolation (eigener Prozess, Container, gVisor o. ä.).

Trotzdem gilt:
- Expressions laufen mit Timeout (Default 1000 ms), Code-Nodes mit Timeout (Default 60 s, `FILUFLOW_CODE_TIMEOUT_MS`).
- Python (Pyodide) läuft als WebAssembly im Serverprozess. Wie in n8n sind das Python-Modul `js` (Zugriff auf JavaScript) und
  `os.system` gesperrt, zusätzlich `pyodide_js`; das Dateisystem ist ein eigenes im Speicher, nicht das des Servers. Wer es
  darauf anlegt, kann die Sperren umgehen (z. B. über interne Module von Pyodide); sie verhindern Versehen, keine Angriffe. Das
  Zeitlimit setzt ein eigener Thread über den Interrupt-Buffer von Pyodide durch, auch bei Endlosschleifen. Läufe sind
  nacheinander, solange Python rechnet, wartet der Server mit anderen Aufgaben (wie bei JavaScript im Code-Node).
- Python (Native) startet einen eigenen Prozess mit den Rechten des Servers. Vor dem Start prüft filuflow den Code wie der
  Task-Runner von n8n: Imports nur aus den Freigabelisten (Default: keine), keine relativen oder dynamischen Imports, keine
  Attribute wie `__class__` oder `__globals__`; Builtins wie `eval`, `exec`, `open`, `getattr` fehlen. Der Prozess bekommt eine
  leere Umgebung (keine Schlüssel des Servers), außer `FILUFLOW_PYTHON_ENV_ACCESS=true`. Mit freigegebenen Modulen wie `os`
  oder `subprocess` hat der Code vollen Zugriff auf das System; das ist eine bewusste Entscheidung des Betreibers.
- Im Sandbox-Kontext gibt es kein `require`, kein `process`, kein `import()`.
- `$env` liefert nur freigegebene Umgebungsvariablen (`FILUFLOW_ENV_ALLOW`, Default: Präfix `FL_`).
- Credential-Werte werden nie geloggt und im Execution-Log nicht gespeichert.
- Die REST-API ist mit `FILUFLOW_API_KEY` geschützt. Ohne gesetzten Schlüssel ist die API gesperrt (außer `/healthz` und Webhooks).
- Der Vergleich des API-Keys ist zeitkonstant. Webhooks sind ohne API-Key erreichbar; ihre Authentifizierung kommt aus dem Webhook-Node
  (Basic, Header, Bearer, JWT) mit Credentials aus `credentials.json`.
- Der Docker-Container läuft als Benutzer `node` (nicht root).
- Request-Bodys sind auf `FILUFLOW_PAYLOAD_SIZE_MAX` MB begrenzt (Default 16, wie n8n).
- KI-Agents lassen das Modell Tools aufrufen: Das HTTP Request Tool sendet Requests mit Werten vom Modell (bei
  Authentifizierung ist ein Platzhalter in der Domain verboten, wie in n8n), das Workflow-Tool startet Unter-Workflows, das
  Code-Tool führt seinen Code in derselben Sandbox wie der Code-Node aus (gleicher Timeout). Antworten von LLMs sind
  nicht vertrauenswürdig; Tools sollten nur mit den Rechten angeschlossen werden, die der Agent wirklich braucht.
- API-Keys der Modelle kommen aus Credentials und werden wie alle geheimen Felder maskiert.
- Weboberfläche: Die statischen Dateien sind ohne Anmeldung abrufbar und enthalten keine Daten; alle Daten kommen über die REST-API
  mit `X-API-Key`. Der Schlüssel liegt im localStorage des Browsers (Abmelden löscht ihn). Wer den API-Key hat, kann Workflows
  anlegen, ändern, löschen und ausführen, also auch Code-Nodes mit beliebigem Code; der Schlüssel ist entsprechend zu schützen.
  Für Zugriffe aus dem Netz einen Reverse Proxy mit HTTPS davorsetzen. Mit `FILUFLOW_UI=false` ist die Oberfläche abgeschaltet.
- Credentials in der Oberfläche: Lesen liefert Name, ID, Typ, die öffentlichen Felder (z. B. Header-Name, Client-ID, URL) und die
  Namen der gesetzten geheimen Felder, nie deren Werte. Geheim sind die Felder mit `typeOptions.password` der n8n-Credential-Typen,
  das JSON von Custom Auth und bei unbekannten Typen Felder, deren Name nach Passwort, Secret, Token, Key oder Wert aussieht.
  Beim Bearbeiten nennt die Oberfläche in `keep` die geheimen Felder, die unverändert bleiben sollen; der Server übernimmt sie nur
  bei gleichem Typ. Gespeichert wird in `credentials.managed.json` (Dateirechte 0600, atomar ersetzt, mit
  `FILUFLOW_ENCRYPTION_KEY` je Eintrag AES-256-GCM-verschlüsselt). Ohne Schlüssel liegen die Werte im Klartext in der Datei; die
  Oberfläche weist darauf hin. Einträge aus der von Hand gepflegten `credentials.json` sind über die API nicht änderbar. Das
  Protokoll nennt Name und Typ geänderter Credentials, nie Werte. Wer den API-Key hat, kann Credentials anlegen und ändern und
  über Workflows (Code-Node, HTTP Request an eigene Server) auch die Werte bestehender Credentials verwenden; die Trennung
  schützt vor versehentlicher Anzeige, nicht vor einem Angreifer mit API-Key.
- Ergebnisse von Ausführungen sind wie im Execution-Log maskiert.
- Wartende Ausführungen: Zum Fortsetzen speichert filuflow den Zustand unmaskiert (die Daten fließen in spätere Knoten), in
  einer eigenen Tabelle, mit `FILUFLOW_ENCRYPTION_KEY` verschlüsselt, und löscht ihn beim Fortsetzen oder Abbrechen. OAuth2-Tokens
  liegen ebenso verschlüsselt in der Datenbank. Wer `$execution.resumeUrl` kennt, kann die Ausführung fortsetzen; für Freigaben
  sollte der Wait-Knoten eine Authentifizierung nutzen (`incomingAuthentication`), die URL enthält nur die Ausführungs-ID.
- Die Seiten senden eine Content-Security-Policy (`script-src 'self'`, kein `eval`, keine fremden Quellen), `X-Content-Type-Options`
  und `frame-ancestors 'none'`. Statische Pfade außerhalb von `dist/ui` werden abgewiesen.

## Master und Worker (M9)
Benutzer des Masters sind das interne Team. Wer in einem Projekt bearbeiten darf, kann Code-Nodes schreiben und damit beliebigen
Code auf dem Worker des Projekts ausführen, also in der Umgebung des Mandanten. Das Recht "Bearbeiten" ist entsprechend zu vergeben.

Anmeldung und Sitzungen:
- Passwörter mit scrypt (N=32768, r=8, p=1, 16 Byte Salz), mindestens 12 Zeichen. Bei unbekannter E-Mail wird trotzdem ein Hash
  berechnet (gleiche Antwortzeit, gleiche Meldung).
- Nach 10 Fehlversuchen ist ein Konto 15 Minuten gesperrt; höchstens 20 Anmeldeversuche je IP und je E-Mail in 15 Minuten,
  5 TOTP-Versuche je Anmeldung in 5 Minuten. Hinter einem Reverse Proxy `FILUFLOW_TRUST_PROXY=true` setzen, damit die IP aus
  `X-Forwarded-For` zählt (sonst teilen sich alle die IP des Proxys). Ohne Proxy bleibt es aus, weil sonst jeder seine IP vorgeben
  könnte.
- TOTP nach RFC 6238 (SHA-1, 30 s, 6 Stellen, ±1 Zeitschritt), ein Code gilt nur einmal. Der Schlüssel liegt mit
  `FILUFLOW_ENCRYPTION_KEY` verschlüsselt (AES-256-GCM) in der Datenbank. Admins können TOTP für alle Benutzer mit Passwort
  vorschreiben; Notfall-Zugang über `filuflow master user reset-totp` auf dem Server.
- Sitzung als zufälliges Token im Cookie `filuflow_session` (HttpOnly, SameSite=Lax, Secure bei `https://` in
  `FILUFLOW_PUBLIC_URL`); in der Datenbank steht nur der SHA-256-Hash. Ablauf nach 12 Stunden ohne Aktivität
  (`FILUFLOW_SESSION_HOURS`), spätestens nach 7 Tagen. Abmelden, Sperren, Passwort- oder Rollenwechsel beenden Sitzungen sofort.
- CSRF: Jeder ändernde Request mit Sitzung (auch die Anmeldung) braucht den Header `X-Filuflow-Csrf: 1`. Fremde Seiten können
  ihn ohne CORS-Freigabe nicht setzen; der Master sendet keine CORS-Header.
- API-Tokens (`ffl_…`, vor der Umbenennung `flt_…`, beide gültig; 32 Byte Zufall) werden nur beim Anlegen angezeigt und gehasht gespeichert, optional mit Ablaufdatum. Sie
  haben die Rechte ihres Benutzers; neue Tokens nur aus einer angemeldeten Sitzung.
- Der erste Admin entsteht über ein Einrichtungs-Token, das der Master beim Start ins Log schreibt (nur solange es keine Benutzer
  gibt), über `FILUFLOW_ADMIN_EMAIL`/`FILUFLOW_ADMIN_PASSWORD` oder `filuflow master user add --admin`.

SSO (OpenID Connect):
- Authorization Code Flow mit PKCE (S256); `state`, `nonce` und Verifier liegen verschlüsselt in einem Cookie (10 Minuten, nur
  `/api/auth/oidc`). Das ID-Token wird vollständig geprüft: Signatur über die JWKS des Ausstellers (RS256/384/512, PS256/384/512,
  ES256/384/512; unbekannte Verfahren und `none` werden abgelehnt), Aussteller, Empfänger (`aud`), Ablauf und Ausstellungszeit
  (60 s Toleranz), `nonce`. Der Aussteller im Discovery-Dokument muss zur Konfiguration passen.
- Zuordnung über `iss` + `sub`, beim ersten Mal über die E-Mail. Eine E-Mail gilt als bestätigt, solange der Identity Provider nicht
  ausdrücklich `email_verified: false` meldet (Entra ID sendet den Claim nicht). Das setzt voraus, dass Benutzer ihre E-Mail beim
  Identity Provider nicht frei wählen können; sonst `FILUFLOW_OIDC_ALLOWED_DOMAINS` setzen und Benutzer vorab anlegen statt
  `FILUFLOW_OIDC_AUTO_CREATE`.
- Gesperrte Benutzer können sich auch über SSO nicht anmelden. Fehlgeschlagene SSO-Anmeldungen stehen im Audit-Log.

Rechte:
- Projekte, in denen jemand kein Mitglied ist, sind für ihn unsichtbar (404 statt 403). Ausführungen und Credential-Namen eines
  Workers sieht nur, wer im zugehörigen Projekt lesen darf; Ausführungen werden auf die Workflows des Projekts gefiltert.
- Verwaltung (Benutzer, Mandanten, Worker, Credentials setzen, Audit-Log) nur für globale Admins. Der letzte aktive Admin kann
  nicht herabgestuft, gesperrt oder gelöscht werden.
- Audit-Log für Anmeldungen (auch fehlgeschlagene), Benutzer-, Projekt-, Workflow- und Worker-Änderungen, Ausführen über den Master
  und Credential-Änderungen, ohne Passwörter, Tokens oder Credential-Werte.

Verbindung zum Worker:
- Der Master meldet sich beim Worker mit dessen `FILUFLOW_API_KEY` (Header `X-API-Key`, mindestens 16 Zeichen) an. Die Tokens
  liegen mit `FILUFLOW_ENCRYPTION_KEY` verschlüsselt in der Datenbank des Masters und werden nie ausgegeben.
- Für Verbindungen über fremde Netze HTTPS verwenden; das TLS-Zertifikat wird geprüft (abschaltbar nur ausdrücklich je Worker,
  eigenes CA-Zertifikat möglich). Der Worker braucht keinen Zugang zum Master.
- Wer den Token eines Workers hat, kann dort Workflows verteilen und damit Code ausführen; er ist wie ein Root-Zugang zu behandeln.
- Credentials: Der Master überträgt neue Werte einmalig zum Worker, speichert sie nicht und kann geheime Werte nicht zurücklesen
  (nur öffentliche Felder für das Bearbeiten-Formular). Im Editor eines Projekts können nur globale Admins neue Credentials beim
  Worker anlegen. Der Worker
  speichert sie in `credentials.managed.json` (Dateirechte 0600, mit `FILUFLOW_ENCRYPTION_KEY` des Workers verschlüsselt, wenn
  gesetzt). Einträge aus der von Hand gepflegten Credential-Datei des Workers kann der Master weder überschreiben noch löschen.
- Ausführungsdaten bleiben beim Worker und werden nur bei Bedarf über den Master angezeigt (maskiert wie im Execution-Log).
