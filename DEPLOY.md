# Deployment Guide

This guide deploys OpenCode Telemetry on a NAS or Linux server with Docker Compose. The services use separate containers for the OpenTelemetry Collector, VictoriaMetrics, and Grafana. Nginx Proxy Manager (NPM) is optional.

## Requirements

- Docker Engine and the Docker Compose v2 plugin.
- A persistent directory on the server for the Compose files and configuration.
- A DNS name and HTTPS reverse proxy if the OpenCode computer will send metrics over the internet. The plugin requires HTTPS.
- An existing NPM Docker network only if using the optional NPM integration below.

Do not expose VictoriaMetrics or the Collector's storage network directly to the internet. The base Compose file binds the Collector and Grafana to loopback (`127.0.0.1`) only. A separate bridge network allows Docker to publish those loopback ports; only the Collector and Grafana join it, while VictoriaMetrics remains isolated on the internal telemetry network.

## 1. Get the Deployment Bundle

For a tagged GitHub release, download `opencode-telemetry-deploy.tar.gz` and its `.sha256` file from the release's Assets. Transfer them to the server, then verify and extract the archive:

```sh
sha256sum -c opencode-telemetry-deploy.tar.gz.sha256
mkdir -p opencode-telemetry
tar -xzf opencode-telemetry-deploy.tar.gz -C opencode-telemetry
cd opencode-telemetry
```

On macOS, use `shasum -a 256 -c opencode-telemetry-deploy.tar.gz.sha256` to verify the checksum before transferring the files.

The release workflow attaches this deployment-only archive to published GitHub Releases. To build the same archive from a development checkout instead, run `npm run package:deploy` and transfer `dist/opencode-telemetry-deploy.tar.gz` to the server. A Git clone is not required on the deployment host.

## 2. Configure the Stack

Create the local environment file:

```sh
cp .env.example .env
```

Edit `.env` on the server:

- Keep the pinned image versions unless intentionally upgrading.
- Set `GF_SECURITY_ADMIN_PASSWORD` to a unique, strong password.
- Keep `GF_SECURITY_COOKIE_SECURE=true` when accessing Grafana over HTTPS.
- Set `VM_RETENTION_PERIOD` to fit the available storage.
- Leave `NPM_PROXY_NETWORK` as the example value unless using the NPM overlay.
- Change `OTEL_HTTP_PORT` or `GRAFANA_PORT` only if those loopback ports are already in use.

Protect the environment file because it contains the Grafana password:

```sh
chmod 600 .env
```

The Grafana password is passed to the container as an environment variable and can be seen by users with access to Docker administration. Restrict access to the Docker daemon and this deployment directory.

Create the ingestion credential. The same token will be configured in the OpenCode plugin later:

```sh
umask 077
openssl rand -hex 32 > secrets/ingest-token.txt
sudo chown 10001:10001 secrets/ingest-token.txt
sudo chmod 0400 secrets/ingest-token.txt
```

The Collector image runs as UID 10001 and must be able to read this file. If your NAS does not provide `openssl`, generate at least 32 random characters using a trusted password manager. Keep the token out of Git, support tickets, and shell history.

## 3. Start the Services

From the deployment directory, validate the rendered configuration, download the images, and start the stack:

```sh
docker compose config
docker compose pull
docker compose up -d
docker compose ps
```

Check startup logs if a service is not running:

```sh
docker compose logs --tail=100 otel-collector grafana victoria-metrics
```

If `docker compose ps` shows only `3000/tcp` and `4318/tcp` with no `127.0.0.1:...->...` mappings after changing the Compose network or port settings, recreate the affected services:

```sh
docker compose up -d --force-recreate grafana otel-collector
```

The Grafana and Collector upstreams bind to `127.0.0.1:3000` and `127.0.0.1:4318`. These ports are bound to loopback, not to the NAS's LAN or public interfaces. Grafana's secure-cookie setting is enabled, so access its UI through the HTTPS reverse proxy rather than opening the HTTP upstream directly in a browser.

For a local-only test over `http://localhost:3000`, set `GF_SECURITY_COOKIE_SECURE=false` in `.env` and recreate Grafana. Do not use this setting for a remotely accessible deployment:

```sh
docker compose up -d --force-recreate grafana
```

## 4. Configure HTTPS Ingress

The OpenCode plugin sends metrics to an HTTPS endpoint ending in `/v1/metrics`. Choose one of the following ingress patterns.

### Existing Nginx Proxy Manager

Find the Docker network NPM uses (for example with `docker network ls`) and set its exact name in `.env` as `NPM_PROXY_NETWORK`. If NPM has no shared user-defined network yet, create one and attach NPM to it:

```sh
docker network create npm_proxy
```

Use the same network name for `NPM_PROXY_NETWORK`, then start the stack with the optional overlay:

```sh
docker compose -f compose.yaml -f compose.npm.yaml config
docker compose -f compose.yaml -f compose.npm.yaml up -d
```

In NPM, create proxy hosts with valid TLS certificates:

- Metrics hostname: forward to `otel-collector`, port `4318`.
- Grafana hostname: forward to `grafana`, port `3000`.

The metrics host must pass `/v1/metrics` through unchanged and preserve the `Authorization: Bearer ...` header. Do not add public access controls that prevent the plugin from sending this header. Grafana should require authentication; do not publish it as an unauthenticated public dashboard.

Only the Collector and Grafana join the NPM network. VictoriaMetrics remains on the private telemetry network.

### Another Reverse Proxy

For a reverse proxy running directly on the server, configure it to forward to `http://127.0.0.1:4318` for metrics and `http://127.0.0.1:3000` for Grafana. The proxy must terminate HTTPS for the metrics hostname and preserve the authorization header and `/v1/metrics` path.

For a reverse proxy in another Docker container, use an optional Compose override that attaches only `otel-collector` and `grafana` to the proxy's existing Docker network, as `compose.npm.yaml` does for NPM. Set the network name for that proxy; do not attach VictoriaMetrics to it.

## 5. Install and Configure the OpenCode Plugin

Install the plugin on the computer where OpenCode runs, not on the NAS. Download `opencode-telemetry-plugin.tar.gz` and its checksum from the same GitHub Release on that computer, verify it, and extract it:

```sh
sha256sum -c opencode-telemetry-plugin.tar.gz.sha256
mkdir -p opencode-telemetry-plugin
tar -xzf opencode-telemetry-plugin.tar.gz -C opencode-telemetry-plugin
node opencode-telemetry-plugin/scripts/install-plugin.mjs
```

For local development from this repository, run `npm run install:opencode-plugin -- --local` instead. This installs the plugin and creates a mode-0600 config using `secrets/ingest-token.txt` and the loopback endpoint `http://localhost:4318/v1/metrics`. HTTP is permitted only for `localhost` and `127.0.0.1`; remote endpoints still require HTTPS.

To update an existing plugin installation from a newer release bundle, run `node opencode-telemetry-plugin/scripts/install-plugin.mjs --update` from the extracted bundle. This replaces the plugin files but preserves the existing config and ingestion token. For local development, use `npm run install:opencode-plugin -- --local --update`.

The installer places the plugin in the OpenCode configuration directory and creates `opencode-telemetry.example.json` there. With the default config directory, copy and protect the file with:

```sh
cp ~/.config/opencode/opencode-telemetry.example.json ~/.config/opencode/opencode-telemetry.json
chmod 600 ~/.config/opencode/opencode-telemetry.json
```

Edit `opencode-telemetry.json` with the following settings:

```json
{
  "endpoint": "https://metrics.example.net/v1/metrics",
  "token": "the-same-token-created-on-the-server",
  "team_name": "personal",
  "user": "your-user-label",
  "source": "your-computer-label"
}
```

Use the real HTTPS metrics hostname. The endpoint path must be exactly `/v1/metrics`; `user` and `source` must be non-empty labels. `team_name` is optional and defaults to `personal`. The dashboard maps `user` to `user_name` and the assistant message mode (`plan`, `build`, or another configured mode) to `agent`. Do not commit this file or share its token. Restart OpenCode after configuring the plugin. The installer and plugin support `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` if your OpenCode config directory is nonstandard.

The dashboard includes per-session views, so the plugin sends raw `session_id` values as metric labels on request, token, cost, session, and error metrics. This enables session filtering but increases time-series cardinality and exposes activity-level identifiers to anyone with metrics or Grafana access. The plugin bounds its in-process attribute and deduplication caches at 10,000 entries per metric stream; higher session volumes can exceed its cardinality limit. Keep Grafana protected and review VictoriaMetrics retention and resource limits for your usage volume. The cost panel displays the `cost` value reported by OpenCode as USD; no independent currency conversion is performed.

The dashboard schema update uses new metric names and labels. Previously stored series remain in VictoriaMetrics under their old names; they are not renamed or backfilled. After updating the plugin and restarting OpenCode, the new dashboard panels populate as new requests are completed and exported.

## 6. Verify Ingestion

Use OpenCode to complete an assistant request, then check the Collector logs:

```sh
docker compose logs --since=5m otel-collector
```

Sign into Grafana using the configured admin credentials and inspect the provisioned OpenCode dashboard. Metrics may take a short interval to export and appear. If no data arrives, confirm DNS and TLS, the exact `/v1/metrics` path, matching tokens, and that the proxy forwards the authorization header.

## Updates and Backups

- Back up the deployment directory, including `.env` and `secrets/`, using storage protected as carefully as the credentials themselves.
- Back up the `victoria-metrics-data` and `grafana-data` Docker volumes. The Collector WAL volume is a temporary delivery buffer, but may also be included in a complete backup.
- Keep the deployment bundle version with your backup so the configuration and images can be restored together.
- To upgrade, review release notes and image versions, update the deployment files as needed, then run `docker compose pull` and `docker compose up -d`.
- `docker compose down` preserves named volumes. Do not add `-v` when stopping the stack unless you intend to delete stored metrics and Grafana state.
- The deployment is a single node and has no high availability. Recovery depends on tested backups.
