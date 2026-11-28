# Troy Advanced — EC2 Production Operations Guide

This guide covers running `troy-advanced` reliably and securely on AWS EC2 (`x86_64` and Graviton `arm64`) in production: instance sizing, IAM & IMDSv2 hardening, systemd & Docker Compose deployments, SSH loopback tunneling, session hydration, memory governance, and Prometheus observability.

Related docs:
- System architecture and ASCII diagrams: [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- Wire protocol contracts (Agent Socket, SSE, WebSocket, MCP, Pipe): [`docs/PROTOCOL.md`](./PROTOCOL.md)

---

## 1. Production Topology

`troy-advanced` is designed for **zero-GUI, loopback-only** operation on EC2. The Agent Socket and Chromium CDP port **never bind to `0.0.0.0`**; remote operators and AI agents connect exclusively through an authenticated SSH loopback tunnel (or AWS SSM Session Manager port forward).

```text
+----------------------------------+               +-----------------------------------------------+
|  Operator Laptop / Agent Host    |               |  AWS EC2 Instance (t4g / t3, Private Subnet)  |
|                                  |  SSH -L / SSM |                                               |
|  Dexter / Claude / CLI / MCP     |  (TLS / SSH)  |  127.0.0.1:9333  Agent Socket (x-troy-agent)  |
|  http://127.0.0.1:9333  ========>|==============>|    |-- Policy + Readonly + Origin Guards      |
|  ~/.config/troy-advanced/        |               |    |-- SSRF Guard (--block-private-net)       |
|    agent-endpoint.json (0600)    |               |    |-- Memory Watchdog (--max-rss-mb)         |
|                                  |               |    +-- Engine: Chromium CDP or Lite (Node 22) |
+----------------------------------+               |                                               |
                                                   |  BLOCKED by SSRF Guard + IMDSv2 hop-limit=1:  |
                                                   |    X 169.254.169.254 (AWS IMDS)               |
                                                   |    X 169.254.170.2   (ECS task metadata)      |
                                                   |    X 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16|
                                                   +-----------------------+-----------------------+
                                                                           |
                                                                           v  HTTPS / Proxy Egress
                                                                  Target Web Applications
```

Security invariants enforced by this topology:
1. **Loopback-only binding**: `src/bridge/agent-socket.ts` binds strictly to `127.0.0.1`, validates the `Host` header against DNS rebinding (`src/bridge/host-guard.ts`), and authenticates requests with timing-safe token comparison (`src/bridge/auth.ts`).
2. **No public browser ports**: EC2 Security Groups never expose port `9333` (Agent Socket) or `9222` (CDP).
3. **Zero X11 / Electron overhead**: Pure Node 22+ TypeScript with native `WebSocket` and `zlib` — no native C++ addons to compile on Graviton ARM64.

---

## 2. EC2 Instance Sizing (`t3` vs `t4g` Graviton)

Choose **`t4g` (AWS Graviton2/3 ARM64)** by default for ~20% lower cost and better memory-bandwidth efficiency. `troy-advanced` has zero native Node addons and runs identically on `arm64` and `x86_64` (`t3` / `t3a`).

### Recommended Instance Matrix

| Instance Type | Arch | vCPU / RAM | Recommended Engine | Max Tabs | `--max-rss-mb` | `/dev/shm` | Best Workload |
|---|---|---|---|---:|---:|---:|---|
| `t4g.nano` | ARM64 | 2 / 0.5 GiB | `--engine lite` | 4–8 | `256` | N/A | Ultra-cheap HTTP/HTML/RSS/JSON scraping, zero Chrome |
| `t4g.micro` | ARM64 | 2 / 1 GiB | `--engine lite` | 8–16 | `512` | N/A | Multi-agent Lite workloads, API/form automation |
| `t3.small` / `t4g.small` | x64 / ARM64 | 2 / 2 GiB | `--engine auto` (Chromium) | 2–4 | `1024` | `512m` | Single-agent headless Chromium + ASCII screenshots |
| `t3.medium` / `t4g.medium` | x64 / ARM64 | 2 / 4 GiB | `--engine chromium` | 5–10 | `2400` | `1g` | **Recommended production baseline** for SPA/JS + CDP |
| `t3.large` / `t4g.large` | x64 / ARM64 | 2 / 8 GiB | `--engine chromium` | 10–20 | `5500` | `2g` | Multi-session AI agents, heavy dashboards & canvases |

### OS & Runtime Recommendations

- **AMI**: Ubuntu 24.04 LTS (`arm64` or `amd64`) or Amazon Linux 2023.
- **Node.js**: Node **22.x LTS** or newer (required for native `WebSocket` and `fetch`).
- **Disk**: `gp3` EBS root volume, 20–30 GiB (Chromium cache, persistent profiles, rotated logs, and download quarantine live under the profile/config directory).
- **Swap (for 1–2 GiB instances)**: Add a 2 GiB swapfile on `t3.small`/`t4g.small` to prevent sudden kernel OOM-kills during transient Chromium renderer spikes while the memory watchdog (`--max-rss-mb`) evicts idle tabs.
- **CPU Credits (`t3`/`t4g`)**: For sustained heavy Chromium rendering or continuous benchmarking, monitor `CPUCreditBalance` in CloudWatch or use `c7g.medium` / `m7g.medium` to avoid burstable throttling.

---

## 3. IAM & IMDSv2 Hardening

When an AI agent browses untrusted web pages on an EC2 host, **SSRF against the AWS Instance Metadata Service (`169.254.169.254`)** is the single highest-impact cloud risk. Always apply **both** AWS-layer controls and `troy-advanced` application-layer controls.

### 3.1 Enforce IMDSv2 & Hop Limit = 1 on the EC2 Instance

Require IMDSv2 session tokens (`HttpTokens=required`) and set `HttpPutResponseHopLimit=1` so containerized or proxied processes cannot fetch EC2 IAM credentials:

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id i-0123456789abcdef0 \
  --http-tokens required \
  --http-put-response-hop-limit 1 \
  --http-endpoint enabled
```

If the instance does not need AWS API access at all, disable IMDS completely (`--http-endpoint disabled`) and attach **no IAM Instance Profile**.

### 3.2 Least-Privilege IAM Instance Profile

- **Default recommendation**: Attach **no IAM role** to browser-worker EC2 instances unless SSM Session Manager or CloudWatch Logs is required.
- **If using SSM Session Manager**: Attach only `AmazonSSMManagedInstanceCore` — never grant `AdministratorAccess`, `s3:*`, or `secretsmanager:*` to a host running an autonomous browser.

### 3.3 Application-Layer SSRF & Policy Defense

Always launch the EC2 daemon with `--block-private-net` (implemented in `src/agent/ssrf.ts`), which blocks:
- AWS & cloud metadata IPs/hosts: `169.254.169.254`, `fd00:ec2::254`, `169.254.170.2`, `instance-data.ec2.internal`, `metadata.google.internal`, `metadata.azure.internal`
- RFC1918 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), IPv6 ULA (`fc00::/7`), and IPv4-mapped IPv6 bypasses
- DNS-rebinding hostnames that resolve to any private/metadata IP

Combine with additional production safety flags:

```bash
troy-advanced daemon run \
  --engine auto \
  --compat-troy \
  --block-private-net \
  --policy standard \
  --redact-secrets \
  --untrusted-markers \
  --allow-origin https://app.example.com \
  --allow-origin https://*.example.com \
  --deny-origin https://admin.example.com
```

| Flag | Module | Production Purpose |
|---|---|---|
| `--block-private-net` | `src/agent/ssrf.ts` | Blocks IMDS, RFC1918, loopback, and DNS-rebinding SSRF |
| `--ssrf-allow-host <host>` | `src/agent/ssrf.ts` | Explicit allowlist exception for a specific internal host (avoid on multi-tenant boxes) |
| `--policy strict\|standard\|permissive` | `src/agent/policy-profile.ts` | Controls eval, submit guards, and tool permissions (`policy.json` supported via `--policy-file`) |
| `--allow-origin` / `--deny-origin` | `src/cloud/daemon-config.ts` | Persisted origin allowlist/denylist enforced on every navigation & tool call |
| `--readonly` | `src/agent/readonly.ts` | Observer-only mode: deterministically refuses all mutating tools (`click`, `fill`, `eval`, `navigate`) |
| `--redact-secrets` | `src/agent/secret-redactor.ts` | Masks AWS keys (`AKIA...`), JWTs, bearer tokens, and card numbers in ASCII/text output |
| `--untrusted-markers` | `src/agent/untrusted-markers.ts` | Wraps page text in explicit untrusted delimiters (`banner` or `xml`) to mitigate prompt injection |

### 3.4 Safe IMDSv2 Diagnostics in `doctor`

`troy-advanced doctor` (`src/cloud/doctor.ts`, `src/cloud/imds.ts`) probes IMDSv2 strictly with `PUT /latest/api/token` (TTL 60s, 400ms timeout) to report instance type, region, and AZ without failing outside AWS. To skip IMDS probing altogether:

```bash
troy-advanced doctor --no-imds --json
```

### 3.5 Security Group Rules

- **Inbound**: Allow only TCP `22` from your corporate VPN/bastion CIDR — or **zero inbound ports** when using AWS SSM Session Manager.
- **Outbound**: Allow TCP `443` (and `80` if needed) to the internet or your VPC egress proxy. Never open `9333` or `9222` in Security Groups.

---

## 4. Bootstrapping & systemd Production Service

### 4.1 Bootstrap a Fresh EC2 Host

The repository includes `deploy/ec2-bootstrap.sh` for Ubuntu 22.04/24.04 and Amazon Linux 2023. It installs Node 22+, Chromium + liberation fonts, builds `troy-advanced`, and runs `doctor`:

```bash
git clone https://github.com/anishfyi/troy-advanced.git
cd troy-advanced
bash deploy/ec2-bootstrap.sh
```

### 4.2 Install & Harden the systemd Unit

Start from `deploy/troy-advanced.service` and install it under `/etc/systemd/system/troy-advanced.service`. For production hosts, apply systemd sandboxing directives and explicit resource limits:

```ini
[Unit]
Description=Troy Advanced — Terminal/EC2 Headless Agent Browser Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
Group=ec2-user
WorkingDirectory=/home/ec2-user/troy-advanced
Environment=NODE_ENV=production
Environment=TROY_ADVANCED_MAX_RSS_MB=2400
ExecStart=/usr/bin/env node --expose-gc /home/ec2-user/troy-advanced/bin/troy-advanced.mjs daemon run \
  --engine auto \
  --port 9333 \
  --compat-troy \
  --block-private-net \
  --policy standard \
  --redact-secrets \
  --max-rss-mb 2400 \
  --log-max-bytes 10485760 \
  --log-max-files 5
Restart=always
RestartSec=3
LimitNOFILE=65536
MemoryMax=3G
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ec2-user/.config/troy-advanced /home/ec2-user/.troy

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo cp deploy/troy-advanced.service /etc/systemd/system/troy-advanced.service
# (Edit User/WorkingDirectory/hardening directives above as needed)
sudo systemctl daemon-reload
sudo systemctl enable --now troy-advanced
sudo systemctl status troy-advanced
```

### 4.3 Log Inspection & Rotation

Daemon logs are written with `0o600` permissions and rotated automatically (`src/cloud/daemon-logs.ts`, defaults: 5 MiB per file, 5 rotated archives `.1`..`.5`):

```bash
# Tail last 100 lines and stream live updates
troy-advanced daemon logs --tail 100 --follow

# Force rotation or inspect all rotated archives
troy-advanced daemon logs --rotate
troy-advanced daemon logs --all --json

# Or inspect systemd journal
journalctl -u troy-advanced -f
```

---

## 5. Docker Compose Deployment on EC2

For immutable deployments on EC2, use the bundled `Dockerfile`, `docker-compose.yml`, and `deploy/.env.example`.

### 5.1 One-Command Deployment

```bash
cp deploy/.env.example .env
# Edit .env: set TROY_ENGINE, TROY_POLICY, TROY_SHM_SIZE, TROY_AGENT_PORT
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:9333/readyz
```

Key production defaults built into `docker-compose.yml`:
- `network_mode: host` keeps the Agent Socket bound to `127.0.0.1:9333` on the EC2 host (never `0.0.0.0`) so `troy-advanced ec2 tunnel` works immediately.
- `shm_size: ${TROY_SHM_SIZE:-1gb}` prevents Chromium `/dev/shm` renderer OOM crashes (Docker's default 64 MiB is too small for Chromium).
- `security_opt: [no-new-privileges:true]` and `init: true` (reaps zombie Chromium helper processes cleanly).
- Persistent named volume `troy_profile_data:/data` stores the browser profile, cookies, SQLite page memory, audit log (`audit.jsonl`), download quarantine, and `agent-endpoint.json`.
- Built-in Docker `HEALTHCHECK` probes `GET /readyz` every 15s.

### 5.2 Generating Custom Compose Files

Use `troy-advanced ec2 compose` (`src/cloud/docker-compose.ts`) to render or validate a tailored Compose file with memory/CPU limits or `--readonly` mode:

```bash
troy-advanced ec2 compose \
  --engine chromium \
  --port 9333 \
  --policy strict \
  --shm-size 1gb \
  --memory 3g \
  --cpus 2 \
  --write docker-compose.prod.yml

troy-advanced ec2 compose --validate docker-compose.prod.yml
```

---

## 6. SSH Loopback Tunneling & Remote Control

`troy-advanced ec2 tunnel` (`src/cloud/ec2-tunnel.ts`) generates and optionally establishes hardened OpenSSH loopback tunnels without exposing any remote ports.

### 6.1 Tunnel Architecture

```text
Local Machine (127.0.0.1)                     EC2 Host (127.0.0.1)
  :9333  ---- SSH -L 127.0.0.1:9333:127.0.0.1:9333 ---->  :9333 (Agent Socket)
  :19222 ---- SSH -L 127.0.0.1:19222:127.0.0.1:9222 --->  :9222 (Optional CDP)
```

Every tunnel generated by `troy-advanced ec2 tunnel` enforces:
- Loopback bind on both ends (`127.0.0.1:<local>:127.0.0.1:<remote>`)
- `-N -T` (no remote command, no pseudo-TTY)
- `-o ExitOnForwardFailure=yes` (fails fast if local port is occupied)
- `-o ServerAliveInterval=30 -o ServerAliveCountMax=3` (auto-detects dead SSH sessions)
- `-o StrictHostKeyChecking=accept-new` (configurable)

### 6.2 Common Tunnel Workflows

```bash
# 1. Print the hardened ssh command (dry-run, no connection yet)
troy-advanced ec2 tunnel ec2-user@203.0.113.10 -i ~/.ssh/prod.pem

# 2. Discover remote agent-endpoint.json over SSH and write local endpoint file
troy-advanced ec2 tunnel ec2-user@203.0.113.10 \
  -i ~/.ssh/prod.pem \
  --discover \
  --write-endpoint ~/.config/troy-advanced/agent-endpoint.json

# 3. Connect in background and verify local loopback port is listening
troy-advanced ec2 tunnel ec2-user@203.0.113.10 \
  -i ~/.ssh/prod.pem \
  --connect --background

# 4. Connect through a bastion / jump host
troy-advanced ec2 tunnel ec2-user@10.0.1.42 --jump ec2-user@bastion.example.com --connect

# 5. Forward Chromium CDP as well (for --cdp-url remote control)
troy-advanced ec2 tunnel ec2-user@203.0.113.10 --cdp --connect --background
troy-advanced ascii https://example.com --cdp-url http://127.0.0.1:19222
```

### 6.3 AWS SSM Session Manager Alternative (Zero Open SSH Ports)

If your EC2 instance is in a private subnet with no inbound SSH port:

```bash
aws ssm start-session \
  --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["9333"],"localPortNumber":["9333"]}'
```

Then copy `agent-endpoint.json` (`0o600`) to your local machine (or set `TROY_ADVANCED_ENDPOINT_FILE`) and point `troy-advanced` or Dexter's `troy` tool at `http://127.0.0.1:9333`.

---

## 7. Session Hydration, Profiles & Egress Proxies

### 7.1 Transferring Signed-In Sessions to EC2

Sign in interactively on your laptop, export encrypted cookies and web storage (`src/engine/cookies.ts`, `src/engine/storage.ts`), transfer over `scp`, and import on EC2:

```bash
# On local workstation (AES-256-GCM encrypted bundle, 0o600 permissions)
troy-advanced cookies export cookies.enc.json --domain app.example.com --encrypt --passphrase "$BUNDLE_PASS"
troy-advanced storage export storage.enc.json --origin https://app.example.com --encrypt --passphrase "$BUNDLE_PASS"

scp -i ~/.ssh/prod.pem cookies.enc.json storage.enc.json ec2-user@203.0.113.10:/tmp/

# On EC2 host
troy-advanced cookies import /tmp/cookies.enc.json --passphrase "$BUNDLE_PASS"
troy-advanced storage import /tmp/storage.enc.json --passphrase "$BUNDLE_PASS"
shred -u /tmp/cookies.enc.json /tmp/storage.enc.json
```

### 7.2 Multi-Profile Isolation

Isolate separate tenants, environments, or accounts with named profiles (`src/cloud/profiles.ts`):

```bash
troy-advanced profile create staging
troy-advanced profile list
troy-advanced profile export staging staging-backup.json
troy-advanced profile import prod-clone staging-backup.json
```

### 7.3 VPC / Corporate Egress Proxies

Both Chromium and Lite engines support HTTP, HTTPS, and SOCKS5 proxies (`src/engine/proxy.ts`):

```bash
troy-advanced daemon run \
  --engine auto \
  --proxy socks5://proxy.internal:1080 \
  --proxy-bypass "internal.corp,.example.internal" \
  --block-private-net
```

Standard environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are respected automatically unless `--no-env-proxy` is passed.

---

## 8. Memory Watchdog, Health Probes & Observability

### 8.1 Memory Watchdog (`--max-rss-mb`)

Long-running headless browsers accumulate memory across SPA navigations. Enable the built-in memory watchdog (`src/cloud/memory-watchdog.ts`):

```bash
node --expose-gc bin/troy-advanced.mjs daemon run \
  --engine chromium \
  --max-rss-mb 2400 \
  --watchdog-interval-ms 10000 \
  --watchdog-idle-ttl-ms 60000
```

When process RSS exceeds `--max-rss-mb` (or `TROY_ADVANCED_MAX_RSS_MB`), the watchdog performs graduated pressure relief:
1. Clears cached page snapshots on idle background tabs.
2. Evicts the oldest idle background tabs (never evicting the active tab; keeps at least 1 tab).
3. Invokes a GC hint (`globalThis.gc()` when Node is started with `--expose-gc`).

### 8.2 Health Probes

Unauthenticated loopback health endpoints (implemented in `src/bridge/agent-socket.ts` and `src/bridge/metrics.ts`; disable with `--no-health-probe`):

| Endpoint | HTTP 200 Meaning | Non-200 Meaning | Use Case |
|---|---|---|---|
| `GET /healthz` | Process alive + summary status | Daemon shutting down / degraded | General health check |
| `GET /livez` | Node event loop & HTTP server alive | Process hung / unreachable | Kubernetes/systemd liveness |
| `GET /readyz` | Engine initialized & ready to serve tabs | Engine crashed or initializing (`503`) | Docker `HEALTHCHECK` / ALB / readiness |

### 8.3 Prometheus Metrics (`GET /metrics`)

`GET /metrics` exposes Prometheus text format (`text/plain; version=0.0.4; charset=utf-8`). By default it requires the `x-troy-agent` token; pass `--public-metrics` only when scraping from a local Prometheus agent on `127.0.0.1`.

Key metrics to alert on in production:
- `troy_process_resident_memory_bytes` — alert at >80% of `--max-rss-mb` or instance RAM.
- `troy_memory_watchdog_evictions_total` — sustained growth indicates undersized instance or tab leak.
- `troy_crash_recoveries_total` — Chromium auto-relaunch count (`src/engine/crash-recovery.ts`); investigate `/dev/shm` or memory limits if rising.
- `troy_audit_refusals_total` & `troy_rate_limit_blocked_total` — detects runaway agent loops or policy/SSRF violations.
- `troy_tool_duration_seconds` — histogram buckets (`0.001`..`30s`) per tool and outcome (`ok`, `error`, `refused`).
- `troy_tabs_open` / `troy_sessions_active` / `troy_sse_clients_connected` / `troy_ws_clients_connected` — concurrency and active connections.

Example local Prometheus scrape job (running on the EC2 host):

```yaml
scrape_configs:
  - job_name: troy-advanced
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:9333']
    # If not using --public-metrics, supply x-troy-agent via bearer/header proxy or local collector
```

---

## 9. Pre-Flight Verification & Troubleshooting Runbook

### 9.1 Pre-Flight Checks on a New EC2 Instance

Run both `doctor` and `bench` (`src/cloud/doctor.ts`, `src/cloud/bench.ts`) before putting an EC2 node into production:

```bash
# 1. Verify Node, Chromium binary, profile permissions, and IMDSv2 metadata
troy-advanced doctor --json

# 2. Measure startup latency, ASCII render throughput, and CDP snapshot latency
troy-advanced bench --engine auto --json
```

### 9.2 Common EC2 Issues & Fixes

| Symptom | Root Cause | Fix |
|---|---|---|
| Chromium renderer crashes (`Target closed` / `Aw, Snap!`) in Docker | Default Docker `/dev/shm` is only 64 MiB | Set `shm_size: 1gb` in `docker-compose.yml` or `--shm-size=1g` in `docker run` |
| `troy-advanced doctor` shows `imds.status: "timeout"` inside Docker | EC2 `HttpPutResponseHopLimit=1` blocks container bridge hops | Expected when hardened! Pass `--no-imds` in `doctor`, or use `network_mode: host` if IMDSv2 detection is desired |
| `troy-advanced` refuses to read `agent-endpoint.json` or token rejected | Stale endpoint file or wrong permissions | Ensure file mode is `0o600` (`chmod 600`), restart daemon, or re-run `ec2 tunnel --discover --write-endpoint` |
| Agent receives `code: "ssrf"` when visiting internal staging host | `--block-private-net` is active (recommended default) | Add `--ssrf-allow-host staging.internal` only if intentionally accessing a trusted VPC host |
| High memory usage / OOM kills on `t3.small` or `t4g.small` | Too many concurrent Chromium tabs | Lower concurrent tabs, set `--max-rss-mb 1024`, add 2 GiB swap, or switch static workloads to `--engine lite` |
| `ec2 tunnel --connect` exits immediately with port-forward error | Local port `9333` already in use (`ExitOnForwardFailure=yes`) | Choose another local port (`--local-port 19333`) or stop the conflicting local daemon (`troy-advanced daemon stop`) |
