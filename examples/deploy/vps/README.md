# Cheap VPS Deployment

This example assumes the deployment target is a small Linux VPS with:

- 2 vCPU
- 4 GB RAM for the conservative 1B path, or 8 GB for a roomier two-slot 1B path
- Ubuntu 24.04
- one quantized model served locally

The intended phase-1 shape is:

1. a lightweight local model backend such as `llama.cpp` listening on `127.0.0.1:8081`
2. the Ray gateway listening on `127.0.0.1:3000`
3. Caddy or nginx reverse proxying public traffic to Ray

## Why This Layout

Ray stays lean by separating serving control from model execution:

- the backend owns token generation
- Ray owns scheduling, cache policy, request shaping, observability, and deploy ergonomics

That keeps the gateway process small while still making self-hosted inference operationally usable.

## Deployment Flow

### 1. Install base tools

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential caddy
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.9"
sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
SERVICE_USER="${RAY_DEPLOY_SERVICE_USER:-ray}"
id -u "$SERVICE_USER" >/dev/null 2>&1 || sudo useradd --system --home /srv/ray --shell /usr/sbin/nologin "$SERVICE_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
sudo install -d -m 0755 /srv/ray /etc/ray /var/lib/ray /var/lib/ray/models /var/lib/ray/async-queue
sudo chown "$(id -un):$(id -gn)" /srv/ray
sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" /var/lib/ray
```

### 2. Prepare a local model backend

Use any lightweight OpenAI-compatible backend you trust. The generic 1B examples assume `llama.cpp` serving a local GGUF over HTTP on `127.0.0.1:8081`. The exact model family is not hardcoded; the key requirement is that the model fits the target memory class after model weights, KV cache, prompt cache, Ray, and OS reserve are counted.

Install or build `llama.cpp` so `RAY_LLAMA_CPP_BINARY_PATH` points at a real `llama-server` binary. Use this command as the generated service's launch shape or as a one-off smoke test; if you follow the systemd render path in step 6, stop any foreground `llama-server` before enabling the generated `ray-llama-cpp.service`.

For a conservative 4 GB / 2 vCPU 1B-class box, start close to:

```bash
./llama-server \
  --host 127.0.0.1 \
  --port 8081 \
  --model /var/lib/ray/models/local-1b-q4.gguf \
  --alias local-1b-q4 \
  --ctx-size 2048 \
  --parallel 1 \
  --threads 2 \
  --threads-http 2 \
  --batch-size 192 \
  --ubatch-size 96 \
  --cache-prompt \
  --cache-reuse 192 \
  --cache-ram 384 \
  --metrics \
  --slots \
  --warmup \
  --kv-unified \
  --cache-idle-slots \
  --context-shift
```

Put the GGUF at the configured `model.adapter.launchProfile.modelPath`, usually
under `/var/lib/ray/models`, before starting the generated llama.cpp service.

On an 8 GB node, [ray.1b.8gb.generic.public.json](../../config/ray.1b.8gb.generic.public.json) raises context to `4096`, cache RAM to `768` MiB, and uses two parallel slots. The Qwen-specific [ray.1b.public.json](../../config/ray.1b.public.json) and [ray.1b.8gb.public.json](../../config/ray.1b.8gb.public.json) profiles are reference baselines for benchmark reproducibility.

### 3. Build Ray

```bash
git clone https://github.com/razroo/ray.git /srv/ray
cd /srv/ray
bun install
bun run build
SERVICE_USER="${RAY_DEPLOY_SERVICE_USER:-ray}"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
sudo chmod -R a+rX /srv/ray
sudo chown -R "$SERVICE_USER:$SERVICE_GROUP" /var/lib/ray
```

### 4. Place the config

Start from [ray.1b.generic.public.json](../../config/ray.1b.generic.public.json) for a public generic 4 GB 1B deployment, or [ray.1b.8gb.generic.public.json](../../config/ray.1b.8gb.generic.public.json) for a generic 8 GB deployment. Use [ray.1b.generic.json](../../config/ray.1b.generic.json) and [ray.1b.8gb.generic.json](../../config/ray.1b.8gb.generic.json) for local/private loopback use.

The sub-1B configs remain useful when the model is smaller than 1B: [ray.sub1b.public.json](../../config/ray.sub1b.public.json), [ray.sub1b.cax11.public.json](../../config/ray.sub1b.cax11.public.json), [ray.sub1b.classifier.json](../../config/ray.sub1b.classifier.json), and [ray.sub1b.drafter.json](../../config/ray.sub1b.drafter.json). The Qwen/Hetzner 1B configs are checked-in baselines for repeatable benchmarks, not required for other models.

Adjust:

- `model.id`
- `model.family`
- `model.quantization`
- `model.adapter.modelRef`
- `model.adapter.baseUrl`
- `model.adapter.launchProfile.modelPath`
- `model.adapter.launchProfile.alias`
- `auth.enabled`
- `rateLimit.maxRequests`

Put the final file somewhere stable, for example:

```bash
sudo mkdir -p /etc/ray
sudo cp examples/config/ray.1b.generic.public.json /etc/ray/ray.json
SERVICE_USER="${RAY_DEPLOY_SERVICE_USER:-ray}"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
sudo chown "root:$SERVICE_GROUP" /etc/ray/ray.json
sudo chmod 0640 /etc/ray/ray.json
```

For portable deployments, keep model-specific values in `/etc/ray/ray.env` instead of forking JSON:

```dotenv
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
RAY_DEPLOY_SERVICE_USER=ray
RAY_DEPLOY_MEMORY_MIB=4096
RAY_GATEWAY_RUNTIME_BINARY=/usr/local/bin/bun
RAY_MODEL_ID=local-1b-q4
RAY_MODEL_REF=local-1b-q4
RAY_MODEL_FAMILY=llama-compatible
RAY_MODEL_QUANTIZATION=q4_k_m
RAY_MODEL_WARM_ON_BOOT=true
RAY_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_LLAMA_CPP_BINARY_PATH=/usr/local/bin/llama-server
RAY_LLAMA_CPP_CTX_SIZE=2048
RAY_LLAMA_CPP_PARALLEL=1
RAY_LLAMA_CPP_THREADS=2
RAY_LLAMA_CPP_CACHE_RAM_MIB=384
RAY_LLAMA_CPP_CACHE_PROMPT=true
RAY_LLAMA_CPP_SLOT_STATE_TTL_MS=250
RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS=300
RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES=384
RAY_LLAMA_CPP_CONTINUOUS_BATCHING=true
RAY_LLAMA_CPP_ENABLE_METRICS=true
RAY_LLAMA_CPP_EXPOSE_SLOTS=true
RAY_LLAMA_CPP_WARMUP=true
RAY_LLAMA_CPP_ENABLE_UNIFIED_KV=true
RAY_LLAMA_CPP_CACHE_IDLE_SLOTS=true
RAY_LLAMA_CPP_CONTEXT_SHIFT=true
RAY_LOG_LEVEL=info
RAY_TELEMETRY_SERVICE_NAME=ray-gateway
RAY_TELEMETRY_INCLUDE_DEBUG_METRICS=true
RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS=2200
RAY_REQUEST_BODY_LIMIT_BYTES=48000
RAY_SCHEDULER_CONCURRENCY=1
RAY_SCHEDULER_MAX_QUEUE=40
RAY_SCHEDULER_MAX_QUEUED_TOKENS=18000
RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=2560
RAY_SCHEDULER_DEDUPE_INFLIGHT=true
RAY_SCHEDULER_BATCH_WINDOW_MS=5
RAY_SCHEDULER_AFFINITY_LOOKAHEAD=12
RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS=96
RAY_CACHE_ENABLED=true
RAY_CACHE_MAX_ENTRIES=256
RAY_CACHE_TTL_MS=120000
RAY_CACHE_KEY_STRATEGY=input+params
RAY_PROMPT_COMPILER_ENABLED=true
RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE=true
RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES=true
RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS=promptFamily,taskTemplate,template,useCase
RAY_ASYNC_QUEUE_ENABLED=true
RAY_ADAPTIVE_TUNING_ENABLED=true
RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS=600
RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND=8
RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO=0.5
RAY_ADAPTIVE_MIN_OUTPUT_TOKENS=64
RAY_ASYNC_QUEUE_MAX_JOBS=1000
RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=256
RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=86400000
RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback.example,*.trusted.example
RAY_AUTH_ENABLED=true
RAY_RATE_LIMIT_ENABLED=true
RAY_RATE_LIMIT_WINDOW_MS=60000
RAY_RATE_LIMIT_MAX_REQUESTS=75
RAY_RATE_LIMIT_MAX_KEYS=4096
RAY_RATE_LIMIT_KEY_STRATEGY=ip+api-key
```

### 5. Add the environment file

If you enable inference auth, populate the API keys env file before starting the gateway:

```bash
sudo tee /etc/ray/ray.env >/dev/null <<'EOF'
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
EOF
```

The deploy CLI reads `--ray-env-file` when rendering or checking a deployment, so
model overrides in `/etc/ray/ray.env` are applied to generated llama.cpp units.
The generated llama.cpp unit does not inherit the gateway env file at runtime,
so `RAY_API_KEYS` stays scoped to the Ray gateway service. Use
`RAY_AUTH_API_KEY_ENV` when your secret manager provides the Bearer keys under a
different environment variable name.

### 6. Install the systemd unit

Start from [ray-gateway.service](./ray-gateway.service) or generate one from the deploy package.
The example unit includes `StateDirectory=ray`, so systemd creates `/var/lib/ray`
for the gateway user before the async queue writes to `/var/lib/ray/async-queue`.
When the deploy renderer emits a llama.cpp unit, install it as
`/etc/systemd/system/ray-llama-cpp.service`; the generated gateway unit includes
`Wants=` and `After=` dependencies on that local backend service.
The render output also includes `summary.json` with doctor diagnostics,
preflight facts, and generated systemd resource controls; inspect it before
copying units into place. Render refuses to print or write units while error
diagnostics are present; run validate or doctor to inspect those failures first.
Pass `--strict-filesystem` on the VPS to make render check the same service-user,
runtime, build-output, model-file, and storage paths that doctor checks. Adapter
headers are redacted in this summary. Relative `--output-dir` values are resolved
from the rendered `--cwd`. For dry rendering before `/etc/ray/ray.env` exists,
use `--systemd-env-file` to control only the `EnvironmentFile=` path that is
written into the unit; keep `--ray-env-file` for render or doctor runs that
should load and validate a real env file.

```bash
bun packages/deploy/dist/cli.js render \
  --cwd /srv/ray \
  --config /etc/ray/ray.json \
  --gateway-runtime-binary /usr/local/bin/bun \
  --ray-env-file /etc/ray/ray.env \
  --strict-filesystem \
  --output-dir /tmp/ray-rendered
cat /tmp/ray-rendered/summary.json
sudo cp /tmp/ray-rendered/ray-gateway.service /etc/systemd/system/ray-gateway.service
if [ -f /tmp/ray-rendered/ray-llama-cpp.service ]; then
  sudo cp /tmp/ray-rendered/ray-llama-cpp.service /etc/systemd/system/ray-llama-cpp.service
else
  if [ -f /etc/systemd/system/ray-llama-cpp.service ]; then
    sudo systemctl disable --now ray-llama-cpp || true
  fi
  sudo rm -f /etc/systemd/system/ray-llama-cpp.service
fi
sudo systemctl daemon-reload
if [ -f /etc/systemd/system/ray-llama-cpp.service ]; then
  sudo systemctl enable --now ray-llama-cpp
fi
sudo systemctl enable --now ray-gateway
```

### 7. Install the reverse proxy

Use the generated Caddyfile from the render output so the public domain, request
body cap, gateway port, and upstream response timeouts match the checked config.

```bash
caddy_tmp="$(mktemp)"
caddy_status=0
cp /tmp/ray-rendered/Caddyfile "$caddy_tmp"
sudo caddy validate --config "$caddy_tmp" &&
  sudo install -m 0644 "$caddy_tmp" /etc/caddy/Caddyfile &&
  sudo systemctl enable --now caddy &&
  sudo systemctl reload caddy || caddy_status=$?
rm -f "$caddy_tmp"
test "$caddy_status" -eq 0
```

### 8. Run the deployment checks

```bash
RAY_API_KEYS=replace-with-real-key bun run validate:config:public
RAY_API_KEYS=replace-with-real-key bun run validate:config:1b:generic:public
RAY_API_KEYS=replace-with-real-key bun run validate:config:1b:public
bun run doctor:1b:generic
bun run doctor
bun run benchmark:assert:cx23
bun run benchmark:assert:cx23:1b
```

### 9. Optional GitHub Actions deploy

The repo includes a generic VPS deploy workflow at
[.github/workflows/deploy-vps.yml](../../../.github/workflows/deploy-vps.yml).
It deploys the Ray gateway itself, not any app that happens to call Ray.

Set these GitHub secrets in your own repo or fork:

- `RAY_DEPLOY_HOST` — VPS hostname or IP
- `RAY_DEPLOY_SSH_KEY` — private SSH key for the deploy user
- `RAY_DEPLOY_KNOWN_HOSTS` — `known_hosts` entry for the VPS
- `RAY_CONFIG_JSON` — optional full Ray config JSON to write to `/etc/ray/ray.json`
- `RAY_ENV_FILE_CONTENTS` — complete contents of `/etc/ray/ray.env`; required when the deployed config has auth enabled

Optional repository variables:

- `RAY_DEPLOY_SSH_USER` — defaults to `root`
- `RAY_DEPLOY_SERVICE_USER` — generated systemd service account, defaults to `ray`; local deploy CLI runs also honor this value from the process env or `--ray-env-file` when `--user` is omitted
- `RAY_DEPLOY_DOMAIN` — Caddy site address to render, defaults to `ray.local`; local deploy CLI runs also honor this value from the process env or `--ray-env-file` when `--domain` is omitted
- `RAY_DEPLOY_MEMORY_MIB` — optional VPS memory class used by workflow doctor/render when `/etc/ray/ray.env` does not already set it; local deploy CLI runs also honor this value from the process env or `--ray-env-file` when `--memory-mib` is omitted
- `RAY_DEPLOY_INSTALL_CADDY` — set to `true` to install and reload the generated Caddyfile; requires `RAY_DEPLOY_DOMAIN`
- `RAY_CONFIG_PATH` — repo-relative config path to install, defaults to `./examples/config/ray.sub1b.public.json`; the workflow rejects absolute paths, path traversal, and paths excluded from repo sync before opening SSH
- `RAY_GATEWAY_RUNTIME_BINARY` — absolute JavaScript runtime path rendered into `ray-gateway.service`, defaults to `/usr/local/bin/bun`; local deploy CLI runs also honor this value from the process env or `--ray-env-file` when `--gateway-runtime-binary` is omitted
- `RAY_DEPLOY_READY_TIMEOUT_SECONDS` — bounded wait for `/readyz` after service restart before reloading Caddy, defaults to `120`
- `RAY_AUTO_DEPLOY` — set to `true` if pushes to `main` should auto-deploy

Use `RAY_CONFIG_JSON` when the live deployment needs host-specific or private
settings that should not live in the public repository. If `RAY_CONFIG_JSON` is
present, it takes precedence over `RAY_CONFIG_PATH`; the workflow only stages it
long enough to resolve deployment settings, excludes `.ray-deploy-*` from repo
sync, and writes the live config directly to `/etc/ray/ray.json`.

`RAY_ENV_FILE_CONTENTS` is the right place for auth keys or env overrides. The
workflow validates auth API keys before opening SSH, then applies those
overrides when choosing the post-restart health check port. For example:

```dotenv
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_API_KEYS=replace-with-comma-separated-client-keys
RAY_LOG_LEVEL=info
RAY_MODEL_WARM_ON_BOOT=false
RAY_ASYNC_QUEUE_ENABLED=true
RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback.example
RAY_DEPLOY_SERVICE_USER=ray
RAY_DEPLOY_MEMORY_MIB=4096
RAY_AUTH_ENABLED=true
RAY_RATE_LIMIT_MAX_REQUESTS=75
```

The workflow refreshes `/usr/local/bin/bun` when it is missing or older than the
repo's supported Bun runtime, then runs `ray deploy doctor` on the VPS before
restarting services. Missing API keys, missing GGUF files, memory-fit errors,
exhausted async queue storage reserves, and unsupported gateway runtimes fail
before systemd tries to start the generated units. The configured gateway
runtime binary defaults to `/usr/local/bin/bun`.

When `RAY_DEPLOY_INSTALL_CADDY=true`, the workflow installs Caddy if needed,
validates the rendered Caddyfile before installing it to `/etc/caddy/Caddyfile`,
and reloads Caddy after both local Ray liveness and backend-aware readiness
checks pass. If service enablement, restart, health checks, or Caddy reload fail,
the workflow prints bounded `systemctl status`, `systemctl show`, and recent
`journalctl` output for the affected unit before exiting.

Without `RAY_AUTO_DEPLOY=true`, the workflow is still available through
`workflow_dispatch` for manual deploys.

## Operational Notes

- Keep the model backend bound to localhost; generated llama.cpp services should keep `model.adapter.launchProfile.host` on `127.0.0.1` or `localhost`.
- Keep `model.adapter.baseUrl` on plain HTTP at the same loopback host, root, and port as `model.adapter.launchProfile` when Ray renders the llama.cpp service.
- Let Ray be the public inference surface.
- Keep the Ray gateway bound to localhost and expose it through Caddy or nginx.
- Enable `auth.enabled` before exposing Ray publicly; it also protects detailed `/health`, `/metrics`, and `/v1/config` responses.
- Keep `/etc/ray/ray.env` private, for example with `sudo chmod 600 /etc/ray/ray.env`; doctor warns when the env file is group/world-readable.
- Create the generated service user before manual render/restart steps, or set `RAY_DEPLOY_SERVICE_USER` in the deploy env file when not using the default `ray` account; doctor verifies the configured user exists before systemd uses it.
- Install Bun 1.3+ at `/usr/local/bin/bun`, set `RAY_GATEWAY_RUNTIME_BINARY`, or pass the same `--gateway-runtime-binary` used at render time; doctor verifies the generated service user can execute the rendered gateway runtime and, for identifiable Bun/Node binaries, that its version satisfies Ray's engine requirements before systemd uses it.
- Keep `/etc/ray/ray.json` readable by the generated service user, for example with `root:<service-user-primary-group>` ownership and mode `0640`; doctor verifies this before systemd uses it.
- Keep the Ray checkout at the generated `WorkingDirectory` such as `/srv/ray`, not under `/home`, `/root`, or `/run/user`; doctor verifies the directory exists, is not hidden by `ProtectHome=true`, and has read/execute mode bits for the generated service user before systemd uses it.
- Run `bun run build` before rendering or restarting services; doctor verifies the built gateway entrypoint exists under the generated `WorkingDirectory` and is readable by the generated service user.
- Use `/livez` for reverse-proxy liveness checks, and `/readyz` when a dependent app needs a minimal backend-aware readiness check; the gateway binds before provider warmup finishes, so a slow local model backend should not make systemd treat the gateway process itself as dead.
- Let the generated Caddy upstream timeouts track `scheduler.requestTimeoutMs`; public proxy sockets should not outlive Ray's own request budget for long.
- The generated systemd units enable CPU, memory, and IO accounting, so `systemctl show ray-gateway -p CPUUsageNSec -p MemoryCurrent -p IOReadBytes -p IOWriteBytes` can confirm pressure without extra agents.
- The generated systemd units set `CPUWeight` so the lightweight gateway gets a larger CPU share than the local model backend when both contend on a small node.
- The generated systemd units also set `MemoryHigh` and `MemoryMax` cgroup ceilings from the gateway profile and llama.cpp memory budget so backend and gateway memory pressure stays bounded on one-node VPS hosts.
- Use `RAY_DEPLOY_MEMORY_MIB` in the deploy env file, or pass `--memory-mib`, when render or doctor should size llama.cpp against an explicit VPS memory class instead of the detected host or launch-profile preset. The explicit flag wins when both are present.
- The generated systemd units also set OOM policy and OOM score adjustments so the lightweight gateway is less kill-prone than the local model backend under last-resort memory pressure.
- The generated systemd units also drop Linux capabilities, restrict address families to local/IP sockets, deny realtime scheduling, and hide host devices and kernel controls. Keep custom service overrides equally narrow unless a backend explicitly needs broader access.
- The generated gateway unit intentionally does not set `MemoryDenyWriteExecute=true`; Bun and Node can need executable memory for their JavaScript runtimes. Keep that directive limited to native backend units such as the generated `ray-llama-cpp.service`.
- Keep generated-service paths out of `/home`, `/root`, and `/run/user`; the units use `ProtectHome=true`, so put GGUF files under `/var/lib/ray/models` and `llama-server` under `/usr/local/bin`.
- Doctor verifies that `model.adapter.launchProfile.binaryPath` points at an executable `llama-server` and that the generated service user can execute it and read the GGUF model before the generated backend service is restarted.
- Keep `cacheRamMiB` pinned for `llama.cpp`. The upstream default is too large for a 4 GB VPS.
- Tune `scheduler.concurrency` conservatively. Tiny hardware collapses faster from overcommit than underutilization.
- Keep `RAY_LLAMA_CPP_THREADS` and `RAY_LLAMA_CPP_THREADS_BATCH` at or below the VPS vCPU count. Doctor records detected host CPU count and warns when the launch profile overcommits compute threads.
- Keep `scheduler.requestTimeoutMs` slightly above `model.adapter.timeoutMs` so provider timeouts remain visible.
- Use `RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB` when the gateway process needs to clamp output before RSS pressure becomes a swap or OOM problem.
- Use `RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD` when a VPS provider's CPU quota needs a more or less aggressive output clamp under cgroup throttling.
- Use explicit env switches such as `RAY_MODEL_WARM_ON_BOOT`, `RAY_MODEL_API_KEY_ENV`, `RAY_LLAMA_CPP_CACHE_PROMPT`, `RAY_LLAMA_CPP_ENABLE_METRICS`, `RAY_LLAMA_CPP_EXPOSE_SLOTS`, `RAY_ASYNC_QUEUE_ENABLED`, `RAY_CACHE_ENABLED`, `RAY_GRACEFUL_DEGRADATION_ENABLED`, `RAY_PROMPT_COMPILER_ENABLED`, `RAY_ADAPTIVE_TUNING_ENABLED`, `RAY_AUTH_ENABLED`, `RAY_AUTH_API_KEY_ENV`, `RAY_RATE_LIMIT_ENABLED`, and `RAY_RATE_LIMIT_TRUST_PROXY_HEADERS` when a VPS needs operational behavior changed without forking JSON. Use `RAY_LOG_LEVEL`, `RAY_TELEMETRY_SERVICE_NAME`, `RAY_TELEMETRY_INCLUDE_DEBUG_METRICS`, and `RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS` to match the VPS monitoring and log-routing setup. Use `RAY_LLAMA_CPP_SLOT_STATE_TTL_MS`, `RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS`, and `RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES` to tune llama.cpp slot reuse and prompt-scaffold cache behavior for the actual backend. Use `RAY_SCHEDULER_BATCH_WINDOW_MS`, `RAY_SCHEDULER_AFFINITY_LOOKAHEAD`, and `RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS` to tune batching, prompt-affinity reuse, and short-job priority from `/etc/ray/ray.env`. Use `RAY_CACHE_KEY_STRATEGY`, `RAY_CACHE_MAX_ENTRIES`, and `RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS` to trade cache reuse, memory use, and learned prompt-family grouping for the actual workload. Use `RAY_RATE_LIMIT_WINDOW_MS`, `RAY_RATE_LIMIT_MAX_REQUESTS`, `RAY_RATE_LIMIT_MAX_KEYS`, and `RAY_RATE_LIMIT_KEY_STRATEGY` to tune public request budgets from `/etc/ray/ray.env`. Use `RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS`, `RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND`, and `RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO` when a model or VPS class needs more or less aggressive learned output clamps. Keep public deployments authenticated.
- Keep a modest swap file on 4 GB llama.cpp VPS targets. Doctor reads `/proc/meminfo` and warns when the small-VPS profile has no swap cushion.
- Ray samples cgroup CPU quota and throttling counters when available, exposes effective quota cores, throttled periods, throttled time, and throttled ratio in health and metrics, and clamps output under sustained throttling when graceful degradation is enabled.
- Ray also samples Linux cgroup memory files when available, marks memory pressure when the service or container reaches 90% of its configured cgroup memory limit, and exposes process RSS pressure ratio plus cgroup v2 `memory.events` counters in health and metrics so operators can see when `MemoryHigh` or OOM boundaries were crossed.
- Detailed `/health` exposes provider-preparation, durable async-queue, queue depth, in-flight work, queued-token, and in-flight-token saturation ratios so operators can see admission pressure without a separate metrics scrape.
- The `/metrics` endpoint refreshes live provider-preparation, queue, cache, async-job saturation, async storage headroom, and cgroup resource gauges before responding, so a scraper can observe current pressure without a separate health probe.
- Use `RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB` to preserve local disk headroom before accepting more durable async jobs. Use `RAY_ASYNC_QUEUE_POLL_INTERVAL_MS`, `RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY`, `RAY_ASYNC_QUEUE_MAX_ATTEMPTS`, `RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS`, and `RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS` to tune durable-job dispatch from `/etc/ray/ray.env`. Doctor checks the nearest existing parent of `RAY_ASYNC_QUEUE_STORAGE_DIR`, so it catches a too-small VPS disk even before the queue directory exists, and verifies the generated service user can write there.
- Keep async callback URLs on global public addresses by default. Doctor warns when `asyncQueue.callbackAllowPrivateNetwork` or `asyncQueue.callbackAllowedHosts` bypass the normal callback DNS/network guardrails; prefer `RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS` with a small comma-separated allowlist of operator-owned callback hosts over `RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK=true`. Allowlist entries must be exact host/IP literals such as `callback.example.com` or wildcard DNS suffix patterns such as `*.example.com`, not full URLs or `host:port` values.
- Keep the cache bounded. Ray is designed to stay predictable under memory pressure.
- Prefer quantized models that fit comfortably rather than models that technically boot.
