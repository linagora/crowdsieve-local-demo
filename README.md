# CrowdSieve local demo

Run [CrowdSieve](https://github.com/linagora/crowdsieve) locally with Docker
Compose on top of an existing CrowdSieve SQLite database, to explore its
dashboard and API on real data.

## Project context

CrowdSieve sits between local CrowdSec instances and the CrowdSec Central API
and keeps every alert it receives. Today, decisions come from deterministic
rules: CrowdSec parsers and scenarios on each server, and CrowdSieve's
threshold-based [log analyzers](https://github.com/linagora/crowdsieve#log-analyzers).

The goal of the project is to add a **local AI** (Qwen or equivalent) that
produces smarter, complementary decisions by cross-correlating the data
collected by CrowdSieve across all agents and servers. Parsers can then report
lower-level, unconfirmed alerts, and the local AI takes the complementary
decisions. Decisions produced by the agents remain automatically validated and
sent to CrowdSec.net.

This repository provides a local CrowdSieve instance with real data to work on.

## Files

| File                    | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `docker-compose.yml`    | Runs CrowdSieve on the given SQLite database        |
| `crowdsieve.yaml`       | CrowdSieve settings for a frozen dataset            |
| `build-geoip.sh`        | Downloads the GeoIP database into `./geoip/`        |
| `.env.example`          | Template for the docker compose variables           |
| `examples/qwen-chat.ts` | Minimal TypeScript example talking to a Qwen3 model |

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

## Talking to the AI model

[`examples/qwen-chat.ts`](examples/qwen-chat.ts) is a minimal TypeScript
example (Node >= 18, no dependency) that sends a conversation to a Qwen3 model
through an OpenAI-compatible API (`POST /chat/completions`), as exposed by
Ollama, vLLM, llama.cpp or LiteLLM. It shows a free-text answer and a
structured one (JSON following a schema), the latter being the way to turn
the model's opinion into a decision.

```bash
export AI_API_URL=http://localhost:11434/v1 # e.g. a local Ollama
export AI_MODEL=qwen3:8b
export AI_API_KEY=...                       # if the server requires one
npx tsx examples/qwen-chat.ts
```

Qwen3 reasons before answering: OpenAI-compatible servers usually return this
reasoning separately (`reasoning_content`), the answer itself being in
`content`.

## Understanding the data

Each alert has a `scenario` whose prefix tells where it comes from:

| Prefix            | Origin                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `crowdsecurity/*` | CrowdSec security engines: parsers and scenarios from the CrowdSec Hub, applied to server logs (SSH, web servers…) |
| `llng/*`          | LemonLDAP::NG portal: its CrowdSec agent pushes alerts directly, without log parsing                               |
| `crowdsieve/*`    | Manual bans and their audit trail, recorded by CrowdSieve itself                                                   |
| other `author/*`  | Community scenarios from the CrowdSec Hub                                                                          |

The database schema is described in CrowdSieve's
[`src/db/schema.ts`](https://github.com/linagora/crowdsieve/blob/master/src/db/schema.ts).

### CrowdSec

- [Introduction](https://docs.crowdsec.net/docs/intro) and
  [concepts](https://docs.crowdsec.net/docs/concepts)
- [Parsers](https://docs.crowdsec.net/docs/parsers/intro): turn log lines into
  structured events
- [Scenarios](https://docs.crowdsec.net/docs/scenarios/intro): detect
  behaviors (leaky buckets, thresholds) and raise alerts
- [Local API (LAPI)](https://docs.crowdsec.net/docs/local_api/intro) and
  [Central API (CAPI)](https://docs.crowdsec.net/docs/central_api/intro):
  CrowdSieve sits between them
- [CrowdSec Hub](https://app.crowdsec.net/hub) and its sources:
  [parsers](https://github.com/crowdsecurity/hub/tree/master/parsers),
  [scenarios](https://github.com/crowdsecurity/hub/tree/master/scenarios)
- Examples behind the most frequent alerts:
  - SSH: parser [`sshd-logs`](https://github.com/crowdsecurity/hub/blob/master/parsers/s01-parse/crowdsecurity/sshd-logs.yaml),
    scenarios [`ssh-time-based-bf`](https://github.com/crowdsecurity/hub/blob/master/scenarios/crowdsecurity/ssh-time-based-bf.yaml)
    and [`ssh-bf`](https://github.com/crowdsecurity/hub/blob/master/scenarios/crowdsecurity/ssh-bf.yaml)
  - HTTP: parsers [`nginx-logs`](https://github.com/crowdsecurity/hub/blob/master/parsers/s01-parse/crowdsecurity/nginx-logs.yaml)
    and [`http-logs`](https://github.com/crowdsecurity/hub/blob/master/parsers/s02-enrich/crowdsecurity/http-logs.yaml),
    scenarios [`http-probing`](https://github.com/crowdsecurity/hub/blob/master/scenarios/crowdsecurity/http-probing.yaml)
    and [`http-sensitive-files`](https://github.com/crowdsecurity/hub/blob/master/scenarios/crowdsecurity/http-sensitive-files.yaml)

### LemonLDAP::NG

The LemonLDAP::NG portal embeds its own CrowdSec agent: it pushes alerts to
the local CrowdSec API (and ban decisions once its thresholds are reached) for
authentication failures (`llng/badcredentials`) and for requests matching its
URL filters (`llng/urlscan`, or named scenarios such as
`llng/http-sensitive-files`).
`llng/badcredentials` alerts are not included in the provided dataset.

The `llng/http-*` scenarios found in the data come from Linagora's
[CrowdSec filters for LemonLDAP::NG](https://github.com/linagora/lemonldap-ng-plugins/tree/main/crowdsec-filters)
(package `linagora-llng-crowdsec-filters`). Their patterns are imported from
the CrowdSec Hub, so `llng/http-sensitive-files` mirrors
`crowdsecurity/http-sensitive-files`, but the detection happens inside the
portal, on each request, instead of in a CrowdSec engine reading web server
logs. Each filter directory holds:

- `patterns.re` / `patterns.txt`: the request URIs to match;
- `.scenario`: the scenario name reported to CrowdSec (e.g. `llng/http-wordpress-scan`);
- `.maxfailures` and `.timewindow`: how many matches within the window
  trigger a ban decision.

The `url_*` filters report the legacy `llng/urlscan` scenario, and the
`urlskip_*` ones are allowlists that never raise alerts. See the
[filters README](https://github.com/linagora/lemonldap-ng-plugins/blob/main/crowdsec-filters/README.md)
for the full list.

- [CrowdSec documentation](https://lemonldap-ng.org/documentation/latest/crowdsec.html):
  agent, bouncer, filters and named scenarios
- Source code on the [OW2 forge](https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng):
  - agent: [`CrowdSecAgent.pm`](https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/master/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Plugins/CrowdSecAgent.pm)
  - URL filters: [`CrowdSecFilter.pm`](https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/master/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/CrowdSecFilter.pm)
  - bouncer: [`CrowdSec.pm`](https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/master/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Plugins/CrowdSec.pm)
- Filters producing the `llng/http-*` scenarios:
  [`crowdsec-filters`](https://github.com/linagora/lemonldap-ng-plugins/tree/main/crowdsec-filters)
  in [linagora/lemonldap-ng-plugins](https://github.com/linagora/lemonldap-ng-plugins)
- Alternative, log-based approach on the CrowdSec Hub (community collection
  [`firewallservices/lemonldap-ng`](https://github.com/crowdsecurity/hub/blob/master/collections/firewallservices/lemonldap-ng.yaml)):
  [parser](https://github.com/crowdsecurity/hub/blob/master/parsers/s01-parse/firewallservices/lemonldap-ng.yaml)
  and [brute-force scenarios](https://github.com/crowdsecurity/hub/blob/master/scenarios/firewallservices/lemonldap-ng-bf.yaml)

### CrowdSieve

- [Repository](https://github.com/linagora/crowdsieve) and
  [REST API documentation](https://linagora.github.io/crowdsieve/api/)
- [Log analyzers](https://github.com/linagora/crowdsieve#log-analyzers): the
  existing threshold-based detection, e.g.
  [`smtp-credential-stuffing.yaml`](https://github.com/linagora/crowdsieve/blob/master/config/analyzers.d/smtp-credential-stuffing.yaml)
- [`src/analyzers`](https://github.com/linagora/crowdsieve/tree/master/src/analyzers),
  including [`pusher.ts`](https://github.com/linagora/crowdsieve/blob/master/src/analyzers/pusher.ts),
  which pushes the analyzers' decisions to the CrowdSec LAPI servers

## Configuration

Variables can be set in the shell or in a `.env` file:

| Variable             | Default           | Description                                                                  |
| -------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `CROWDSIEVE_DB`      | (required)        | SQLite database file to serve                                                |
| `CROWDSIEVE_VERSION` | `0.6.6`           | Tag of the `yadd/crowdsieve` image                                           |
| `BIND_ADDRESS`       | `127.0.0.1`       | Address the ports are published on (`0.0.0.0` to expose them on the network) |
| `DASHBOARD_PORT`     | `3000`            | Dashboard port                                                               |
| `PROXY_PORT`         | `8080`            | API port                                                                     |
| `DASHBOARD_API_KEY`  | `crowdsieve-demo` | API key shared by the dashboard and the API                                  |
| `GEOIP_DIR`          | `./geoip`         | Directory holding `geoip-city.mmdb`                                          |
| `LOG_LEVEL`          | `info`            | `debug`, `info`, `warn` or `error`                                           |

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

This project is licensed under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`), like
CrowdSieve.

The GeoIP data comes from [IP Geolocation by DB-IP](https://db-ip.com),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
