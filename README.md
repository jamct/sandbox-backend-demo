# backend

JavaScript-Backend auf Basis von [Bun](https://bun.com).

## Voraussetzungen

Bun installieren (falls noch nicht vorhanden):

```bash
curl -fsSL https://bun.sh/install | bash
```

## Einrichtung

```bash
bun install
cp .env.example .env
```

## Scripts

| Befehl         | Beschreibung                                    |
| -------------- | ----------------------------------------------- |
| `bun run dev`  | Server mit Hot-Reload starten (`--hot`)         |
| `bun run start`| Server ohne Hot-Reload starten                  |
| `bun test`     | Tests ausführen (`*.test.js`)                   |

Der Server läuft standardmäßig auf http://localhost:3000 (`PORT` in `.env` anpassbar).

## Endpunkte

| Methode | Pfad      | Antwort                                                      |
| ------- | --------- | ------------------------------------------------------------ |
| `GET`   | `/`       | `{ "message": "Hello via Bun!" }`                            |
| `GET`   | `/health` | `{ "status": "ok" }`                                         |
| `GET`   | `/time`   | Aktuelle UTC-Zeit, per NTP von einem Zeitserver ermittelt    |

### `GET /time`

Die Zeit kommt nicht aus der ungeprüften Systemuhr, sondern per SNTP
(RFC 5905/4330) von einem Zeitserver:

```json
{
  "iso": "2026-10-14T17:29:37.831Z",
  "unixMs": 1791998977831,
  "source": "ntp",
  "server": "pool.ntp.org",
  "stratum": 2,
  "offsetMs": 3.701,
  "roundtripMs": 14.926,
  "syncedAt": "2026-10-14T17:29:37.827Z"
}
```

`offsetMs` ist die gemessene Abweichung der lokalen Uhr zum Zeitserver,
`syncedAt` der Zeitpunkt des letzten Syncs. Ein Sync versorgt alle Requests
innerhalb von `NTP_CACHE_MS`; dazwischen wird die Zeit aus der lokalen Uhr plus
Offset abgeleitet. Ist kein Zeitserver erreichbar, antwortet der Endpunkt mit
`503` und `{ "error": "ntp_unavailable", "detail": "..." }` statt mit einer
möglicherweise falschen Zeit.

## Umgebungsvariablen

| Variable          | Default         | Beschreibung                                                        |
| ----------------- | --------------- | ------------------------------------------------------------------- |
| `PORT`            | `3000`          | Port des HTTP-Servers                                               |
| `NTP_SERVER`      | `pool.ntp.org`  | Hostname des Zeitservers für `/time`                                |
| `NTP_TIMEOUT_MS`  | `3000`          | Wartezeit auf die NTP-Antwort, danach `503`                         |
| `NTP_CACHE_MS`    | `60000`         | Mindestabstand zweier NTP-Syncs; `0` synchronisiert bei jedem Request |

## Struktur

```
src/
  index.js       Einstiegspunkt (Bun.serve)
  index.test.js  Beispieltest (bun:test)
  ntp.js         SNTP-Client (Paketaufbau, Parsing, UDP-Abfrage)
  ntp.test.js    Tests für den SNTP-Client
  time.js        Handler für GET /time samt Offset-Cache
  time.test.js   Tests für Handler und Cache
jsconfig.json    Editor-Autovervollständigung für Bun-APIs
.env.example     Vorlage für Umgebungsvariablen
```
