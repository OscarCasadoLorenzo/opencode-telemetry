# Deployment Guide

This guide deploys OpenCode Telemetry on a NAS or Linux server with Docker Compose. The services use separate containers for the OpenTelemetry Collector, VictoriaMetrics, and Grafana. Nginx Proxy Manager (NPM) is optional.

## Requirements

- Docker Engine and the Docker Compose v2 plugin.
- A persistent directory on the server for the Compose files and configuration.
- A DNS name and HTTPS reverse proxy if the OpenCode computer will send metrics over the internet. The plugin requires HTTPS.
- An existing NPM Docker network only if using the optional NPM integration below.

Do not expose VictoriaMetrics or the Collector's storage network directly to the internet. The base Compose file binds the Collector and Grafana to loopback (`127.0.0.1`) only. A separate bridge network allows Docker to publish those loopback ports; only the Collector and Grafana join it, while VictoriaMetrics remains isolated on the internal telemetry network.

## 1. Get the Deployment Bundle

For a tagged GitHub release, download `opencode-telemetry-deploy.tar.gz` and its `.sha256` file from the same release's Assets. Transfer both files to the server without opening, extracting, or recompressing the archive. The commands below use `/volume1/docker/observability` as a generic persistent deployment directory; use a suitable persistent path on other NAS systems.

```sh
sha256sum -c opencode-telemetry-deploy.tar.gz.sha256
mkdir -p /volume1/docker/observability
tar -xzf opencode-telemetry-deploy.tar.gz -C /volume1/docker/observability
cd /volume1/docker/observability
```

On macOS, use `shasum -a 256 -c opencode-telemetry-deploy.tar.gz.sha256` to verify the checksum before transferring the files. On the server, `file opencode-telemetry-deploy.tar.gz` should report gzip-compressed data. If it reports a plain POSIX tar archive, the file may have been automatically decompressed or renamed; that plain archive will not match the checksum for the original `.tar.gz`. Re-download the original release asset and checksum together. Do not rename a plain `.tar` to `.tar.gz`, and do not deploy an archive when checksum verification fails. If you intentionally use a separately verified uncompressed tar archive, extract it with `tar -xf`; the published `.tar.gz` checksum does not validate that different file.

The release workflow attaches this deployment-only archive to published GitHub Releases. To build the same archive from a development checkout instead, run `npm run package:deploy` and transfer `dist/opencode-telemetry-deploy.tar.gz` to the server. A Git clone is not required on the deployment host.

## 2. Configure the Stack

Create the local environment file. If `.env` already exists, keep it rather than replacing it:

```sh
if [ ! -e .env ]; then cp .env.example .env; fi
```

Edit `.env` on the server:

- Keep the pinned image versions unless intentionally upgrading.
- Set `GF_SECURITY_ADMIN_PASSWORD` to a unique, strong password; do not leave the example placeholder value.
- Keep `GF_SECURITY_COOKIE_SECURE=true` when accessing Grafana over HTTPS.
- Set `VM_RETENTION_PERIOD` to fit the available storage.
- Leave `NPM_PROXY_NETWORK` as the example value unless using the NPM overlay.
- Change `OTEL_HTTP_PORT` or `GRAFANA_PORT` only if those loopback ports are already in use.

Protect the environment file because it contains the Grafana password:

```sh
chmod 600 .env
```

The Grafana password is passed to the container as an environment variable and can be seen by users with access to Docker administration. Restrict access to the Docker daemon and this deployment directory.

Grafana and the Collector run as non-root users and must be able to read their mounted configuration files. On NAS systems where extracted files are not readable by container users, grant read/traverse access to these non-secret configuration directories before starting the services:

```sh
sudo chmod -R a+rX grafana/provisioning grafana/dashboards otel
```

This command intentionally does not change permissions on `.env` or `secrets/`.

Create the ingestion credential. The same token will be configured in the OpenCode plugin later:

```sh
umask 077
openssl rand -hex 32 > secrets/ingest-token.txt
sudo chown 10001:10001 secrets/ingest-token.txt
sudo chmod 0400 secrets/ingest-token.txt
```

The Collector image runs as UID 10001 and must be able to read this file. If your NAS does not provide `openssl`, generate at least 32 random characters using a trusted password manager. Keep the token out of Git, support tickets, and shell history.

## 3. Start the Services

Some NAS accounts cannot access the Docker socket without administrator privileges. If Docker reports `permission denied` for `/var/run/docker.sock`, prefix Docker and Compose commands with `sudo`; do not make the Docker socket world-writable.

From the deployment directory, validate the rendered configuration, download the images, and start the stack. The example uses `sudo`, which can be omitted when the current account already has Docker access:

```sh
sudo docker compose config
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

The rendered output from `docker compose config` includes values from `.env`, including the Grafana password. Do not share unredacted output.

Check startup logs if a service is not running:

```sh
sudo docker compose logs --tail=100 otel-collector grafana victoria-metrics
```

If `docker compose ps` shows only `3000/tcp` and `4318/tcp` with no `127.0.0.1:...->...` mappings after changing the Compose network or port settings, recreate the affected services:

```sh
sudo docker compose up -d --force-recreate grafana otel-collector
```

The Grafana and Collector upstreams bind to `127.0.0.1:3000` and `127.0.0.1:4318`. These ports are bound to loopback, not to the NAS's LAN or public interfaces. Grafana's secure-cookie setting is enabled, so access its UI through the HTTPS reverse proxy rather than opening the HTTP upstream directly in a browser.

For a local-only test over `http://localhost:3000`, set `GF_SECURITY_COOKIE_SECURE=false` in `.env` and recreate Grafana. Do not use this setting for a remotely accessible deployment:

```sh
sudo docker compose up -d --force-recreate grafana
```

## 4. Configure HTTPS Ingress

The OpenCode plugin sends metrics to an HTTPS endpoint ending in `/v1/metrics`. Choose one of the following ingress patterns.

### Existing Nginx Proxy Manager

Use a user-defined Docker bridge network shared by NPM, Grafana, and the Collector. The built-in Docker `bridge` network is not suitable for service-name DNS. If NPM does not already use a shared user-defined network, create one and attach the running NPM container (replace `nginx` with its actual container name):

```sh
sudo docker network create npm_proxy
sudo docker network connect npm_proxy nginx
sudo docker restart nginx
```

If `npm_proxy` already exists, skip the create command. Set `NPM_PROXY_NETWORK=npm_proxy` in `.env`. Restarting NPM after attaching the network refreshes its Docker DNS; it briefly interrupts the proxy hosts. For a durable setup, also add this external network to the NPM Compose/project configuration so it remains attached if that container is recreated. Start the telemetry stack with the optional overlay:

```sh
sudo docker compose -f compose.yaml -f compose.npm.yaml config
sudo docker compose -f compose.yaml -f compose.npm.yaml pull
sudo docker compose -f compose.yaml -f compose.npm.yaml up -d
sudo docker compose -f compose.yaml -f compose.npm.yaml ps
```

In NPM, create proxy hosts with TLS certificates whose subject alternative names cover the corresponding hostnames. Use these upstream settings:

- Metrics hostname: scheme `http`, forward hostname `otel-collector`, port `4318`.
- Grafana hostname: scheme `http`, forward hostname `grafana`, port `3000`; enable Websockets Support.

Use the Compose service names as upstream hosts, not the NAS LAN address. The host ports are bound to loopback, so forwarding NPM to `192.168.x.x:3000` or `:4318` will fail. The metrics host must pass `/v1/metrics` through unchanged and preserve the `Authorization: Bearer ...` header. Do not add public access controls that prevent the plugin from sending this header. Grafana should require authentication; do not publish it as an unauthenticated public dashboard.

Only the Collector and Grafana join the NPM network. VictoriaMetrics remains on the private telemetry network.

For Cloudflare or another public DNS proxy, the DNS record's origin must be the router's public IP, not the NAS's private `192.168.x.x` address. A proxied Cloudflare lookup returns Cloudflare edge addresses; that is expected and does not by itself confirm that the origin is reachable. Forward external TCP ports `443` and, if needed for certificate validation, `80` from the router to the host ports published by NPM. Find the actual host-port mappings with `sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'`; NAS installations may map NPM's container ports 443/80 to non-standard host ports. Do not expose NPM's administration port publicly. Set Cloudflare SSL/TLS mode to Full (strict) when NPM presents a valid certificate for the hostname.

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

On macOS, use `shasum -a 256 -c opencode-telemetry-plugin.tar.gz.sha256` instead of `sha256sum`.

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
sudo docker compose logs --since=5m otel-collector
```

Sign into Grafana using the configured admin credentials. The provisioned dashboard is in **Dashboards > Browse > OpenCode**, named **OpenCode model consumption**. The dashboard appears even before metrics arrive; its panels remain empty until the plugin is installed and sends data. If no data arrives, confirm DNS and TLS, the exact `/v1/metrics` path, matching tokens, and that the proxy forwards the authorization header.

## NAS Troubleshooting

### Docker permission denied

Prefix `docker` and `docker compose` commands with `sudo` when the NAS account cannot access `/var/run/docker.sock`. Do not change the socket to mode `666`.

The `otel-wal-init` container is a one-shot volume-permissions initializer. Its `Exited` status after a successful run is expected; check that `otel-collector`, `victoria-metrics`, and `grafana` are running.

### Grafana dashboard missing

Check the Grafana or Collector logs for `permission denied` while reading a mounted configuration file. The bind-mounted files must be readable by the container user. From the deployment directory, run:

```sh
sudo chmod -R a+rX grafana/provisioning grafana/dashboards otel
sudo docker compose -f compose.yaml -f compose.npm.yaml restart grafana
sudo docker compose -f compose.yaml -f compose.npm.yaml restart otel-collector
```

If NAS ACLs override Unix mode bits, grant read/traverse permissions to these non-secret configuration directories using the NAS permission manager. Do not loosen permissions on `.env` or `secrets/`.

### NPM returns 502 or cannot resolve an upstream

Check that the NPM container and the relevant telemetry container are both attached to the same user-defined `npm_proxy` network. Verify that the NPM upstream is `grafana:3000` or `otel-collector:4318`, not the NAS IP. A log such as `grafana could not be resolved` means NPM's Docker DNS cannot resolve the service name; after connecting NPM to the shared network, restart the NPM container to refresh its DNS. A temporary network test for Grafana is:

```sh
sudo docker run --rm --network npm_proxy busybox:1.37.0 wget -qO- http://grafana:3000/api/health
```

Grafana should return JSON with `"database":"ok"`. If this test succeeds but NPM still returns 502, check NPM's proxy-host error log and confirm NPM itself has been restarted since it joined `npm_proxy`.

### DNS resolves but the hostname does not load

Use `nslookup <hostname> 1.1.1.1` to check public DNS. If it resolves but HTTPS fails, test the origin route, router port forwarding, NPM host-port mappings, and the NPM proxy-host log. A direct NAS address such as `http://192.168.1.41:3000` is not a valid Grafana URL for this stack because that port is intentionally bound to loopback. Browse through the configured HTTPS hostname instead.

## Updates and Backups

- Back up the deployment directory, including `.env` and `secrets/`, using storage protected as carefully as the credentials themselves.
- Back up the `victoria-metrics-data` and `grafana-data` Docker volumes. The Collector WAL volume is a temporary delivery buffer, but may also be included in a complete backup.
- Keep the deployment bundle version with your backup so the configuration and images can be restored together.
- To upgrade, review release notes and image versions, update the deployment files as needed, then pull and recreate using the same Compose files used for deployment. For an NPM deployment, use `sudo docker compose -f compose.yaml -f compose.npm.yaml pull` followed by `sudo docker compose -f compose.yaml -f compose.npm.yaml up -d`.
- `sudo docker compose down` preserves named volumes. Do not add `-v` when stopping the stack unless you intend to delete stored metrics and Grafana state.
- The deployment is a single node and has no high availability. Recovery depends on tested backups.
