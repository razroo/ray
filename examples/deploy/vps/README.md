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
id -u ray >/dev/null 2>&1 || sudo useradd --system --home /srv/ray --shell /usr/sbin/nologin ray
sudo install -d -m 0755 /srv/ray /etc/ray /var/lib/ray /var/lib/ray/models /var/lib/ray/async-queue
sudo chown "$(id -un):$(id -gn)" /srv/ray
sudo chown -R ray:ray /var/lib/ray
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
sudo chmod -R a+rX /srv/ray
sudo chown -R ray:ray /var/lib/ray
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
```

For portable deployments, keep model-specific values in `/etc/ray/ray.env` instead of forking JSON:

```dotenv
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
RAY_MODEL_ID=local-1b-q4
RAY_MODEL_REF=local-1b-q4
RAY_MODEL_FAMILY=llama-compatible
RAY_MODEL_QUANTIZATION=q4_k_m
RAY_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_LLAMA_CPP_BINARY_PATH=/usr/local/bin/llama-server
RAY_LLAMA_CPP_CTX_SIZE=2048
RAY_LLAMA_CPP_PARALLEL=1
RAY_LLAMA_CPP_THREADS=2
RAY_LLAMA_CPP_CACHE_RAM_MIB=384
RAY_SCHEDULER_CONCURRENCY=1
RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=2560
RAY_ASYNC_QUEUE_MAX_JOBS=1000
RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=86400000
```

### 5. Add the environment file

If you enable inference auth, populate the API keys env file before starting the gateway:

```bash
sudo tee /etc/ray/ray.env >/dev/null <<'EOF'
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
EOF
```

The deploy CLI reads `--ray-env-file` when rendering or checking a deployment, so
model overrides in `/etc/ray/ray.env` are applied to generated llama.cpp units.
The generated llama.cpp unit does not inherit the gateway env file at runtime,
so `RAY_API_KEYS` stays scoped to the Ray gateway service.

### 6. Install the systemd unit

Start from [ray-gateway.service](./ray-gateway.service) or generate one from the deploy package.
The example unit includes `StateDirectory=ray`, so systemd creates `/var/lib/ray`
for the gateway user before the async queue writes to `/var/lib/ray/async-queue`.
When the deploy renderer emits a llama.cpp unit, install it as
`/etc/systemd/system/ray-llama-cpp.service`; the generated gateway unit includes
`Wants=` and `After=` dependencies on that local backend service.

```bash
bun packages/deploy/dist/cli.js render \
  --cwd /srv/ray \
  --config /etc/ray/ray.json \
  --gateway-runtime-binary /usr/local/bin/bun \
  --ray-env-file /etc/ray/ray.env \
  --output-dir /tmp/ray-rendered
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
- `RAY_ENV_FILE_CONTENTS` — optional complete contents of `/etc/ray/ray.env`

Optional repository variables:

- `RAY_DEPLOY_SSH_USER` — defaults to `root`
- `RAY_DEPLOY_DOMAIN` — Caddy site address to render, defaults to `ray.local`
- `RAY_DEPLOY_INSTALL_CADDY` — set to `true` to install and reload the generated Caddyfile; requires `RAY_DEPLOY_DOMAIN`
- `RAY_CONFIG_PATH` — repo-relative config path to install, defaults to `./examples/config/ray.sub1b.public.json`
- `RAY_GATEWAY_RUNTIME_BINARY` — absolute JavaScript runtime path rendered into `ray-gateway.service`, defaults to `/usr/local/bin/bun`
- `RAY_AUTO_DEPLOY` — set to `true` if pushes to `main` should auto-deploy

Use `RAY_CONFIG_JSON` when the live deployment needs host-specific or private
settings that should not live in the public repository. If `RAY_CONFIG_JSON` is
present, it takes precedence over `RAY_CONFIG_PATH`; the workflow only stages it
long enough to resolve deployment settings, excludes `.ray-deploy-*` from repo
sync, and writes the live config directly to `/etc/ray/ray.json`.

`RAY_ENV_FILE_CONTENTS` is the right place for auth keys or env overrides. The
workflow also applies those overrides when choosing the post-restart health
check port. For example:

```dotenv
RAY_API_KEYS=replace-with-comma-separated-client-keys
RAY_LOG_LEVEL=info
```

The workflow runs `ray deploy doctor` on the VPS before restarting services, so
missing API keys, missing GGUF files, memory-fit errors, and exhausted async
queue storage reserves fail before systemd tries to start the generated units.
It also verifies the configured gateway runtime binary, which defaults to
`/usr/local/bin/bun`.

When `RAY_DEPLOY_INSTALL_CADDY=true`, the workflow installs Caddy if needed,
validates the rendered Caddyfile before installing it to `/etc/caddy/Caddyfile`,
and reloads Caddy after the local Ray health check passes.

Without `RAY_AUTO_DEPLOY=true`, the workflow is still available through
`workflow_dispatch` for manual deploys.

## Operational Notes

- Keep the model backend bound to localhost; generated llama.cpp services should keep `model.adapter.launchProfile.host` on `127.0.0.1` or `localhost`.
- Keep `model.adapter.baseUrl` on plain HTTP at the same loopback host, root, and port as `model.adapter.launchProfile` when Ray renders the llama.cpp service.
- Let Ray be the public inference surface.
- Keep the Ray gateway bound to localhost and expose it through Caddy or nginx.
- Enable `auth.enabled` before exposing Ray publicly; it also protects detailed `/health`, `/metrics`, and `/v1/config` responses.
- Keep `/etc/ray/ray.env` private, for example with `sudo chmod 600 /etc/ray/ray.env`; doctor warns when the env file is group/world-readable.
- Create the generated service user before manual render/restart steps; doctor verifies the configured `--user` exists before systemd uses it.
- Install Bun at `/usr/local/bin/bun` or pass the same `--gateway-runtime-binary` used at render time; doctor verifies the generated service user can execute the rendered gateway runtime before systemd uses it.
- Keep the Ray checkout at the generated `WorkingDirectory` such as `/srv/ray`, not under `/home`, `/root`, or `/run/user`; doctor verifies the directory exists, is not hidden by `ProtectHome=true`, and has read/execute mode bits for the generated service user before systemd uses it.
- Run `bun run build` before rendering or restarting services; doctor verifies the built gateway entrypoint exists under the generated `WorkingDirectory` and is readable by the generated service user.
- Use `/livez` for reverse-proxy liveness checks, and `/readyz` when a dependent app needs a minimal backend-aware readiness check.
- Let the generated Caddy upstream timeouts track `scheduler.requestTimeoutMs`; public proxy sockets should not outlive Ray's own request budget for long.
- The generated systemd units enable CPU, memory, and IO accounting, so `systemctl show ray-gateway -p CPUUsageNSec -p MemoryCurrent -p IOReadBytes -p IOWriteBytes` can confirm pressure without extra agents.
- The generated systemd units also set OOM policy and OOM score adjustments so the lightweight gateway is less kill-prone than the local model backend under last-resort memory pressure.
- The generated systemd units also drop Linux capabilities, restrict address families to local/IP sockets, deny realtime scheduling, and hide host devices and kernel controls. Keep custom service overrides equally narrow unless a backend explicitly needs broader access.
- Keep generated-service paths out of `/home`, `/root`, and `/run/user`; the units use `ProtectHome=true`, so put GGUF files under `/var/lib/ray/models` and `llama-server` under `/usr/local/bin`.
- Doctor verifies that `model.adapter.launchProfile.binaryPath` points at an executable `llama-server` and that the generated service user can execute it and read the GGUF model before the generated backend service is restarted.
- Keep `cacheRamMiB` pinned for `llama.cpp`. The upstream default is too large for a 4 GB VPS.
- Tune `scheduler.concurrency` conservatively. Tiny hardware collapses faster from overcommit than underutilization.
- Keep `scheduler.requestTimeoutMs` slightly above `model.adapter.timeoutMs` so provider timeouts remain visible.
- Use `RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB` when the gateway process needs to clamp output before RSS pressure becomes a swap or OOM problem.
- Keep a modest swap file on 4 GB llama.cpp VPS targets. Doctor reads `/proc/meminfo` and warns when the small-VPS profile has no swap cushion.
- Ray also samples Linux cgroup memory files when available and marks memory pressure when the service or container reaches 90% of its configured cgroup memory limit.
- Use `RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB` to preserve local disk headroom before accepting more durable async jobs. Doctor checks the nearest existing parent of `RAY_ASYNC_QUEUE_STORAGE_DIR`, so it catches a too-small VPS disk even before the queue directory exists, and verifies the generated service user can write there.
- Keep the cache bounded. Ray is designed to stay predictable under memory pressure.
- Prefer quantized models that fit comfortably rather than models that technically boot.
