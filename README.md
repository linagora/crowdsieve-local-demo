# CrowdSieve local demo

Run [CrowdSieve](https://github.com/linagora/crowdsieve) locally with Docker
Compose on top of an existing CrowdSieve SQLite database, to explore its
dashboard and API on real data.

## Files

| File                 | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `docker-compose.yml` | Runs CrowdSieve on the given SQLite database             |
| `crowdsieve.yaml`    | CrowdSieve settings for a frozen dataset                 |
| `build-geoip.sh`     | Downloads the GeoIP database into `./geoip/`             |
| `.env.example`       | Template for the docker compose variables                |

## Requirements

- Docker with the Compose plugin (`docker compose`)
- A CrowdSieve SQLite database file (e.g. `crowdsieve.db`)
- `curl` and `gunzip`, to build the GeoIP database

## Quick start

```bash
./build-geoip.sh
CROWDSIEVE_DB=./crowdsieve.db docker compose up -d
```

Or copy `.env.example` to `.env`, adapt it, then run `docker compose up -d`.

- Dashboard: <http://localhost:3000> (no authentication)
- API: <http://localhost:8080>, with the header `X-API-Key: crowdsieve-demo`

```bash
curl -H 'X-API-Key: crowdsieve-demo' http://localhost:8080/api/stats
curl -H 'X-API-Key: crowdsieve-demo' 'http://localhost:8080/api/alerts?limit=10'
```

Stop and remove the working copy of the data:

```bash
CROWDSIEVE_DB=./crowdsieve.db docker compose down -v
```

## How it works

- The database file is mounted **read-only** and copied into a working volume
  each time the container starts. The original file is never modified, and a
  restart brings back the original data.
- The file must be readable by the container user (uid 1001):
  `chmod 644 crowdsieve.db`.
- The dataset is treated as frozen: retention is set to 100 years, so old
  alerts and bouncer metrics are never purged.
- Nothing leaves the machine: forwarding to the CrowdSec CAPI is disabled, and
  no analyzer or LAPI server is configured.

## GeoIP database

CrowdSieve enriches every incoming alert with its geographic location
(country, region, city, coordinates). `build-geoip.sh` downloads the
[DB-IP City Lite](https://db-ip.com/db/download/ip-to-city-lite) database
(MMDB format, IPv4 and IPv6, no account required) into
`./geoip/geoip-city.mmdb`.

- The container **refuses to start** without this database.
- DB-IP publishes a new edition every month: run `./build-geoip.sh` again to
  update it (it does nothing if the database is already from the current
  month; `--force` downloads it again), then restart the container.
- Alternatively, copy an existing `geoip-city.mmdb` into `./geoip/` (or set
  `GEOIP_DIR`). Any city-level MMDB database works, e.g. MaxMind
  GeoLite2 City renamed to `geoip-city.mmdb`.

Alerts already stored in the database keep the location computed when they
were received; the GeoIP database is used for alerts sent to this instance.

## Sending alerts

The proxy accepts alerts on the CrowdSec CAPI endpoints (`/v2/signals`,
`/v3/signals`), exactly as a CrowdSec LAPI sends them. They are filtered,
enriched with GeoIP and stored, but never forwarded to CrowdSec:

```bash
curl -X POST http://localhost:8080/v2/signals \
  -H 'Content-Type: application/json' \
  -d '[{
    "uuid": "demo-0001",
    "machine_id": "demo-machine",
    "scenario": "demo/test",
    "scenario_hash": "",
    "scenario_version": "1",
    "message": "Test alert",
    "events_count": 1,
    "start_at": "2026-10-01T06:50:00Z",
    "stop_at": "2026-10-01T06:50:00Z",
    "created_at": "2026-10-01T06:50:00Z",
    "source": { "scope": "Ip", "value": "8.8.8.8", "ip": "8.8.8.8" },
    "decisions": []
  }]'
```

The alert then appears in the dashboard, located in Mountain View (US).
Restarting the container (`docker compose restart`) removes the alerts sent
this way, since the working copy is recreated from the original file.

## Configuration

Variables can be set in the shell or in a `.env` file:

| Variable             | Default           | Description                                         |
| -------------------- | ----------------- | --------------------------------------------------- |
| `CROWDSIEVE_DB`      | (required)        | SQLite database file to serve                       |
| `CROWDSIEVE_VERSION` | `0.6.6`           | Tag of the `yadd/crowdsieve` image                  |
| `BIND_ADDRESS`       | `127.0.0.1`       | Address the ports are published on (`0.0.0.0` to expose them on the network) |
| `DASHBOARD_PORT`     | `3000`            | Dashboard port                                      |
| `PROXY_PORT`         | `8080`            | API port                                            |
| `DASHBOARD_API_KEY`  | `crowdsieve-demo` | API key shared by the dashboard and the API         |
| `GEOIP_DIR`          | `./geoip`         | Directory holding `geoip-city.mmdb`                 |
| `LOG_LEVEL`          | `info`            | `debug`, `info`, `warn` or `error`                  |

CrowdSieve settings themselves are in `crowdsieve.yaml`.

Use a `CROWDSIEVE_VERSION` matching the CrowdSieve version that produced the
database: on startup, CrowdSieve applies its schema migrations to the working
copy.

## Limitations

- Banning or unbanning from the dashboard is not possible (no LAPI server).
- DB-IP City Lite does not provide time zones: the time zone of new alerts
  stays empty.
- Views restricted to the last hours or days may be empty, since the data no
  longer evolves.
- The dashboard has no authentication: keep `BIND_ADDRESS=127.0.0.1` unless
  the network is trusted.

## License

The GeoIP data comes from [IP Geolocation by DB-IP](https://db-ip.com),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
