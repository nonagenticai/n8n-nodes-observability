# n8n-nodes-observability

[![npm version](https://img.shields.io/npm/v/@nonagenticai/n8n-nodes-observability.svg)](https://www.npmjs.com/package/@nonagenticai/n8n-nodes-observability)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/nonagenticai/n8n-nodes-observability/actions/workflows/ci.yml/badge.svg)](https://github.com/nonagenticai/n8n-nodes-observability/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nonagenticai/n8n-nodes-observability)](https://github.com/nonagenticai/n8n-nodes-observability/releases)

An n8n community node for querying and writing metrics and logs across
[Prometheus](https://prometheus.io), [Loki](https://grafana.com/oss/loki/),
[Grafana](https://grafana.com/oss/grafana/), a Prometheus Pushgateway and any OTLP/HTTP receiver.

## Features

- **Prometheus** — instant and range queries, targets, alerts, rules, metric names, series,
  metadata, plus OTLP metric push.
- **Loki** — log queries (instant and range), labels, label values, series, plus log push.
- **Grafana** — dashboard search and fetch, annotations (read and create), alert rules.
- **Pushgateway** — push one metric in Prometheus text-exposition format.
- **Metering** — read a `/metrics` endpoint and return one gauge family as a Prometheus
  instant-query vector, so dashboards can consume it unchanged.

Each backend is addressed by its own URL, because one base URL cannot name Prometheus, Loki and
Grafana at once.

## Installation

### n8n GUI (recommended)

**Settings → Community Nodes → Install** → `@nonagenticai/n8n-nodes-observability`.

### Manual

```bash
npm install @nonagenticai/n8n-nodes-observability
```

Restart n8n afterwards.

## Credentials

Create an **Observability Node APIs API** credential. Every field is optional; fill in the ones
your backends need:

| Field | Notes |
|---|---|
| **Prometheus URL** | e.g. `http://localhost:9090`. Falls back to **Base URL**. |
| **Loki URL** | Required for the Loki read operations. Deliberately no fallback to Base URL. |
| **Grafana URL** | Required for the Grafana operations. No fallback. |
| **Grafana API Key** | Service-account token, or `user:password` for basic auth. Sent instead of the API token — Grafana does not accept it. |
| **Base URL** | Legacy single URL; now the Prometheus fallback only. |
| **API Token** | Optional bearer token sent to the backend that owns the resource (for a gateway in front of it). Leave empty for an unauthenticated Prometheus/Loki/Pushgateway. |
| **Tenant ID** | Optional `X-Tenant-ID` header for a multi-tenant gateway. |

The credential test probes each configured backend and reports which are reachable.

## Examples

**Query a metric**

```
Resource: Prometheus
Operation: Instant Query
Query: up{job="prometheus"}
```

**Push a metric**

```
Resource: Pushgateway
Operation: Push Metric
Pushgateway URL: http://localhost:9091
Metric Name: batch_job_last_success
Value: 1
```

**Search dashboards**

```
Resource: Grafana
Operation: Search Dashboards
Query: node
```

## Development

```bash
npm install
npm run build     # tsc + icons + generated reference docs
npm run lint
npm test
```

`npm run build` writes `dist/`, which is what the `n8n` block in `package.json` points at, and
regenerates `docs/GENERATED_REFERENCE.md` and `docs/node-reference.json` from
[`docs/openapi.json`](./docs/openapi.json).

## Notes on behaviour

- A resource whose URL is not configured **throws** rather than falling back to another backend.
  Silently sending a Loki query to Prometheus is the failure mode these separate fields exist to
  prevent.
- Operations that take their own endpoint as a parameter (`pushMetricsOTLP`, `pushLogs`,
  `pushMetric`, `meteringInstantQuery`) never read the credential URL and are not gated by it.
- The node is replay-safe: read operations are marked as such, and writes are not retried after a
  response was received.

## Security

Report vulnerabilities privately through the repository's Security tab — see
[`SECURITY.md`](SECURITY.md). Do not open a public issue for a security problem.

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
development commands and the commit conventions. Commits carry DCO sign-off.

## Licensing

The code in this repository is Apache-2.0 and needs no licence key to build, test or run.
It contains no licence-enforcement code: the Apache-2.0 licence in [`LICENSE`](LICENSE) is the
only licence that applies, and no licence server is involved.

## License

[Apache-2.0](./LICENSE)
