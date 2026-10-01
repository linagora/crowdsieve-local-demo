# CrowdSieve local demo

Run [CrowdSieve](https://github.com/linagora/crowdsieve) locally with Docker
Compose on top of an existing CrowdSieve SQLite database, to explore its
dashboard and API on real data.

## Requirements

- Docker with the Compose plugin (`docker compose`)
- A CrowdSieve SQLite database file (e.g. `crowdsieve.db`)

## Quick start

```bash
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
| `LOG_LEVEL`          | `info`            | `debug`, `info`, `warn` or `error`                  |

CrowdSieve settings themselves are in `crowdsieve.yaml`.

Use a `CROWDSIEVE_VERSION` matching the CrowdSieve version that produced the
database: on startup, CrowdSieve applies its schema migrations to the working
copy.

## Limitations

- Banning or unbanning from the dashboard is not possible (no LAPI server).
- No GeoIP database is shipped. Alerts already stored in the database keep
  their geographic enrichment.
- Views restricted to the last hours or days may be empty, since the data no
  longer evolves.
- The dashboard has no authentication: keep `BIND_ADDRESS=127.0.0.1` unless
  the network is trusted.
