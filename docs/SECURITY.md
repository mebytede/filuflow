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
- Im Sandbox-Kontext gibt es kein `process` und kein `import()`. `require` lädt wie in n8n nur freigegebene Module
  (`NODE_FUNCTION_ALLOW_BUILTIN`, `NODE_FUNCTION_ALLOW_EXTERNAL` bzw. `FILUFLOW_FUNCTION_ALLOW_*`, Default: keine); jede
  andere Anfrage endet mit "Module 'x' is disallowed". Mit freigegebenen Modulen wie `fs` oder `child_process` hat der Code
  die Rechte des Servers; das ist eine bewusste Entscheidung des Betreibers.
- Execute Workflow liest mit der Quelle "Lokale Datei" beliebige Dateien des Servers, wie in n8n. Mit
  `FILUFLOW_RESTRICT_FILE_ACCESS_TO` (Verzeichnisse mit ";" getrennt) lässt sich das begrenzen; Symlinks werden dabei
  aufgelöst. Die Quelle "URL" lädt über den HTTP-Client des Servers.
- Merge per SQL (alasql) kann keine Dateien lesen oder schreiben: die Datei-Funktionen und -Quellen von alasql sind gesperrt
  (wie n8n).
- `$env` liefert nur freigegebene Umgebungsvariablen (`FILUFLOW_ENV_ALLOW`, Default: Präfix `FL_`).
- Chat mit Antwortknoten: Kanal (`/chat/<id>/events`) und Antworten (`POST /chat/<id>`) sind wie die Chat-Seite ohne
  Anmeldung erreichbar, aber nur mit der sessionId, mit der die Ausführung gestartet wurde. Wer Ausführungs-ID und
  sessionId kennt, kann mitlesen und antworten; die sessionId erzeugt die Chat-Seite zufällig im Browser.
- Variablen (`$vars`) sind keine Geheimnisse: Die Oberfläche zeigt ihre Werte im Klartext, sie liegen unverschlüsselt in
  SQLite. Logs nennen nur die Schlüssel. Geheimnisse gehören in Credentials.
- "Auf Test-Aufruf warten" führt beim nächsten Aufruf der Test-URL einen Stand aus dem Editor aus. Das darf nur, wer den
  API-Key hat (bzw. im Master Bearbeiten-Rechte im Projekt); die Test-URLs selbst sind wie in n8n ohne Anmeldung erreichbar.
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
- OAuth2 "Authorization Code"/"PKCE": Die Autorisierung beginnt nur mit API-Key (bzw. als Admin im Master). Der Callback
  `/rest/oauth2-credential/callback` ist ohne Anmeldung erreichbar (der Browser kommt vom Anbieter zurück) und nimmt nur
  einen einmaligen, zufälligen `state` an, der 10 Minuten gilt; bei PKCE bleibt der `code_verifier` auf dem Server. Tokens
  liegen verschlüsselt in der Datenbank (beim Worker), nicht in der Oberfläche und nicht im Master.
- OAuth1: gleiches Verfahren mit `/rest/oauth1-credential/callback`; der einmalige `state` steht in der Rückleitungs-URL,
  die filuflow als `oauth_callback` beim Anbieter hinterlegt. Access-Token und Token-Secret liegen wie OAuth2-Tokens
  verschlüsselt in der Datenbank des Workers.
- Import aus n8n: Der n8n-Schlüssel wird nur zum Entschlüsseln genutzt, nie gespeichert oder protokolliert. Die Antwort
  des Imports nennt nur Namen. Einträge aus `credentials.json` werden nie überschrieben.
- Freigabe für Projekte (Master): Ein Credential mit Freigabe lässt sich nur in den genannten Projekten verwenden; der
  Master weist Workflows anderer Projekte beim Anlegen, Speichern und Ausführen ab. Die Freigabe schützt vor
  versehentlicher Nutzung; wer im Projekt Code-Nodes schreiben darf, erreicht auf dem Worker weiterhin dessen Dateien
  und Umgebung (siehe unten).
- Formulare: Die Seiten unter `/form/` und `/form-waiting/` laufen ohne Skript (CSP `script-src 'none'`). Beschreibungen
  und eigenes HTML werden auf erlaubte Tags reduziert (wie n8n: Text, Listen, Tabellen, Links, Bilder, Videos, iframes in
  einer Sandbox), Links und Quellen nur per http(s). Wer die Adresse einer Folgeseite kennt, kann sie ausfüllen; für
  vertrauliche Abläufe Basic Auth am Form Trigger nutzen.
- Chat Trigger: Ein öffentlicher Chat ist ohne Anmeldung erreichbar, außer der Knoten verlangt Basic Auth. Jede Nachricht
  startet eine Ausführung; für das Internet gehört eine Begrenzung (Reverse Proxy) davor. Die Chat-Seite lädt nur eigene
  Skripte (CSP `script-src 'self'`), Einstellungen stehen als JSON-Daten in der Seite; eigenes CSS (`customCss`) ist erlaubt.
- Ergebnisse von Ausführungen sind wie im Execution-Log maskiert.
- Wartende Ausführungen: Zum Fortsetzen speichert filuflow den Zustand unmaskiert (die Daten fließen in spätere Knoten), in
  einer eigenen Tabelle, mit `FILUFLOW_ENCRYPTION_KEY` verschlüsselt, und löscht ihn beim Fortsetzen oder Abbrechen. OAuth2-Tokens
  liegen ebenso verschlüsselt in der Datenbank. Wer `$execution.resumeUrl` kennt, kann die Ausführung fortsetzen; für Freigaben
  sollte der Wait-Knoten eine Authentifizierung nutzen (`incomingAuthentication`), die URL enthält nur die Ausführungs-ID.
- Die Seiten senden eine Content-Security-Policy (`script-src 'self'`, kein `eval`, keine fremden Quellen), `X-Content-Type-Options`
  und `frame-ancestors 'none'`. Statische Pfade außerhalb von `dist/ui` werden abgewiesen.

## Aufseher (M35)
Der Aufseher schickt Daten an das eingestellte Modell, also an den Anbieter dieses Modells. Was hinausgeht:
- immer: Aufbau des Workflows (Knoten, Parameter, Verbindungen, Einstellungen), Fehlermeldungen, Status und Laufzeiten
  der Ausführungen, Texte der Hinweise;
- nur mit dem Datenumfang "Mit Beispieldaten": gekürzte Daten (höchstens zwei Items, etwa 1500 Zeichen) des Knotens, an dem
  eine Ausführung scheiterte, und seines Vorgängers sowie gekürzte Testdaten (pinData).

Was nie hinausgeht: Credential-Werte. Credentials erscheinen nur mit Namen; alle bekannten geheimen Werte werden in jedem
Text ersetzt (wie im Execution-Log); Parameter, deren Name auf ein Geheimnis deutet (password, token, apiKey,
authorization, secret …) oder deren Wert wie ein Schlüssel aussieht (sk-…, ghp_…, Bearer …), werden als `***` gesendet.
Statische Daten des Workflows werden nicht gesendet. Workflows auf der Liste "Ausgenommene Workflows" sieht das Modell nie.
Wer keine Daten an einen externen Anbieter geben will, nutzt Ollama auf einem eigenen Server oder kein Modell (nur feste
Regeln).

Der Aufseher ändert nichts selbst. Seine Werkzeuge lesen nur; Änderungen entstehen als Vorschlag, den ein Mensch annimmt
(M36). Vorschläge können maskierte Werte nicht zurückschreiben, Annehmen ändert die Aktivierung nicht, und ein Probelauf,
der Knoten wirklich ausführt, startet nur nach einer Rückfrage. Wer die REST-API des Servers nutzen darf, darf auch
Vorschläge annehmen; im Master regeln das die Rollen (M38).
Antworten des Modells werden als Text angezeigt, nicht als HTML. Das Tagesbudget begrenzt die Kosten auch dann, wenn ein
Fehler sehr oft auftritt.

## Simple Vector Store (M27)
Der Simple Vector Store speichert Dokumente und Embeddings im Speicher des Prozesses, geteilt über alle Workflows dieses
Prozesses mit demselben Schlüssel (ab v1.2 ohne Workflow-ID, wie n8n). Workflows eines Workers können also die Daten anderer
Workflows desselben Workers lesen und überschreiben. Vertrauliche Inhalte gehören deshalb in eigene Schlüssel oder auf
eigene Worker; dauerhaft gespeichert wird nichts.

## Plugins (M24)
Plugins (eigene Module und Knoten im n8n-Format) laufen ohne Sandbox im Prozess von filuflow, mit allen Rechten des Prozesses
(Dateien, Netz, Umgebung, Credentials anderer Workflows). Sie gelten wie Workflows als vertrauenswürdig: nur Pakete aus
bekannter Quelle in die Plugin-Ordner legen und diese Ordner nur für Betreiber beschreibbar halten. Credential-Werte gelangen
an Plugins nur über `getCredentials` des jeweiligen Knotens; in Logs und Ausführungen werden sie wie sonst maskiert.

Community-Pakete aus der Oberfläche (M30) sind dasselbe: Wer installieren darf (im Einzelbetrieb jeder mit dem API-Key, im
Master nur globale Admins, beim Worker der Master), kann damit beliebigen Code mit den Rechten von filuflow ausführen.
filuflow installiert ohne npm-Installationsskripte (`--ignore-scripts`), prüft den Paketnamen streng (nur `n8n-nodes-…`,
keine Sonderzeichen) und ruft npm ohne Shell auf; der Code des Pakets läuft beim Laden trotzdem. Wo das nicht gewollt ist,
schaltet `FILUFLOW_COMMUNITY_PACKAGES_ENABLED=false` die Installation ab (bereits installierte Pakete werden weiter geladen).

## Master und Worker (M9)
Gemeinsame Credentials (M33) liegen im Master verschlüsselt mit `FILUFLOW_ENCRYPTION_KEY` und gehen im Klartext nur über
die Verbindung zum Worker (TLS empfohlen) an die gewählten Worker; die Oberfläche bekommt nie geheime Werte zurück. Wer
den Master-Schlüssel und die Datenbank hat, kann sie entschlüsseln; beim Worker gelten die Regeln für dort verwaltete
Credentials.

Benutzer des Masters sind das interne Team. Wer in einem Projekt bearbeiten darf, kann Code-Nodes schreiben und damit beliebigen
Code auf dem Worker des Projekts ausführen, also in der Umgebung des Mandanten. Das Recht "Bearbeiten" ist entsprechend zu vergeben.
Das gilt auch für Bearbeiten-Rechte an einem einzelnen Workflow (M23): Wer einen Workflow bearbeiten darf, erreicht über seine
Code-Nodes den ganzen Worker, also auch Credentials und Daten anderer Workflows dort. "Kein Zugriff" für einen Workflow schützt
vor Einsicht im Master (Workflow, Ausführungen und deren Daten), nicht vor Projektmitgliedern, die auf demselben Worker Code
ausführen dürfen.

Rollen je Workflow und Ausführungssuche:
- Die effektive Rolle für einen Workflow ist bei Projekt-Admins immer admin, sonst die eigene Rolle für den Workflow (falls gesetzt)
  oder die Projektrolle. Gesperrte Workflows antworten mit 404 (nicht 403), damit ihre Existenz nicht sichtbar wird.
- Entfernen aus einem Projekt löscht auch die Rollen der Person für dessen Workflows.
- Die zentrale Suche fragt jeden Worker nur nach den Workflow-IDs, die die Person lesen darf, und verwirft Treffer anderer
  Workflows im Master noch einmal. Ausführungsdaten lädt erst die Detailansicht, mit derselben Prüfung.

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
