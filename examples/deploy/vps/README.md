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
sudo env DEBIAN_FRONTEND=noninteractive timeout 300s apt-get -o Acquire::Retries=3 -o Dpkg::Lock::Timeout=60 update
sudo env DEBIAN_FRONTEND=noninteractive timeout 300s apt-get -o Acquire::Retries=3 -o Dpkg::Lock::Timeout=60 install -y --no-install-recommends ca-certificates curl unzip git build-essential caddy
curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 120 https://bun.sh/install | timeout 300s bash -s "bun-v1.3.9"
timeout 60s sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
SERVICE_USER="${RAY_DEPLOY_SERVICE_USER:-ray}"
case "$SERVICE_USER" in
  *[!0-9]*)
    id -u "$SERVICE_USER" >/dev/null 2>&1 || timeout 60s sudo useradd --system --home /srv/ray --shell /usr/sbin/nologin "$SERVICE_USER"
    ;;
  *)
    id -u "$SERVICE_USER" >/dev/null 2>&1 || { echo "RAY_DEPLOY_SERVICE_USER numeric UID must already exist on the VPS."; exit 1; }
    ;;
esac
SERVICE_GROUP="$(id -g "$SERVICE_USER")"
timeout 60s sudo install -d -m 0755 /srv/ray /etc/ray
timeout 60s sudo install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" /var/lib/ray /var/lib/ray/models /var/lib/ray/async-queue
timeout 60s sudo chown "$(id -un):$(id -gn)" /srv/ray
timeout 60s sudo chown "$SERVICE_USER:$SERVICE_GROUP" /var/lib/ray /var/lib/ray/models /var/lib/ray/async-queue
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
  --threads-batch 2 \
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
After `/etc/ray/ray.env` contains the final model overrides, print the exact
staging commands from the same resolved config:

```bash
timeout 300s bun run model:stage:1b:generic -- --ray-env-file /etc/ray/ray.env --binary-source ./llama-server --source ./local-1b-q4.gguf
```

Add `--sha256 <expected-hex-digest>` when the model publisher provides one, and
`--binary-sha256 <expected-hex-digest>` when the compiled `llama-server` source
has a checksum. The helper does not download models or binaries; it keeps the
operator's chosen sources explicit and prints the install, ownership, checksum,
apparent-size memory and disk-headroom, GGUF header, service-user
read/execute-test, and generated launch-flag support commands needed before
doctor or systemd restart. Printed install commands copy through same-directory
`.ray-stage-*` temp files and only move them into place after the temp artifact
passes service-user checks, so an interrupted copy does not replace the last
working binary or GGUF.
The same values may live in `/etc/ray/ray.env` as
`RAY_LLAMA_CPP_BINARY_SOURCE_PATH`, `RAY_LLAMA_CPP_BINARY_SHA256`,
`RAY_MODEL_SOURCE_PATH`, and `RAY_MODEL_SHA256`; source/checksum CLI flags
override env-file values when both are present.
Add `--commands-only` when you want reviewed shell commands without the
explanatory staging summary.
Add `--check-sources` when the source artifacts are already on the VPS and you
want the helper to verify file access, binary startup, generated launch-flag
support, GGUF header, and any provided checksums before printing the staging
plan.
Add `--apply` on the VPS after reviewing those source paths to verify and stage
the configured `llama-server` and GGUF into their resolved target locations,
then run the staged `llama-server --help` launch-flag probe and installed GGUF
read check as the service identity.

On an 8 GB node, [ray.1b.8gb.generic.public.json](../../config/ray.1b.8gb.generic.public.json) raises context to `4096`, batch threads to `4`, cache RAM to `768` MiB, async queue storage headroom to `512` MiB, and gateway RSS degradation headroom to `768` MiB, and uses two parallel slots. Set `RAY_PROFILE=1b-8gb` when selecting those defaults without a JSON config file. The Qwen-specific [ray.1b.public.json](../../config/ray.1b.public.json) and [ray.1b.8gb.public.json](../../config/ray.1b.8gb.public.json) profiles are reference baselines for benchmark reproducibility.

### 3. Build Ray

```bash
umask 022
timeout 300s git clone --depth 1 https://github.com/razroo/ray.git /srv/ray
cd /srv/ray
timeout 60s bun run deploy:storage
timeout 300s bun install --frozen-lockfile
timeout 300s bun run build
SERVICE_USER="${RAY_DEPLOY_SERVICE_USER:-ray}"
SERVICE_GROUP="$(id -g "$SERVICE_USER")"
timeout 60s sudo chown "$SERVICE_USER:$SERVICE_GROUP" /var/lib/ray /var/lib/ray/models /var/lib/ray/async-queue
```

The `umask 022` keeps the checkout, built files, and Bun-installed dependencies
readable by the generated service user without a recursive permission walk over
`node_modules`.
The storage preflight checks `/srv/ray`, `/var/lib/ray`, `/tmp`, `/var/tmp`, and
the repo-scoped Bun install cache at `/srv/ray/.ray/bun-install-cache` before the
Bun install expands dependencies; set `RAY_DEPLOY_MIN_FREE_STORAGE_MIB` in the
process env or pass `--ray-env-file /etc/ray/ray.env` to raise or lower the
default 1024 MiB threshold without shell-sourcing the rest of the env file.

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
timeout 60s sudo mkdir -p /etc/ray
SERVICE_USER="${RAY_DEPLOY_SERVICE_USER:-ray}"
SERVICE_GROUP="$(id -g "$SERVICE_USER")"
timeout 60s sudo install -m 0640 -o root -g "$SERVICE_GROUP" examples/config/ray.1b.generic.public.json /etc/ray/ray.json
```

For portable deployments, keep model-specific and cheap-node sizing values in
`/etc/ray/ray.env` instead of forking JSON:

```dotenv
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
RAY_DEPLOY_SERVICE_USER=ray
RAY_DEPLOY_MEMORY_MIB=4096
RAY_DEPLOY_MIN_FREE_STORAGE_MIB=1024
RAY_DEPLOY_READY_TIMEOUT_SECONDS=120
RAY_GATEWAY_RUNTIME_BINARY=/usr/local/bin/bun
RAY_DEPLOY_CADDY_BINARY=/usr/bin/caddy
RAY_PROFILE=1b
RAY_HOST=127.0.0.1
RAY_PORT=3000
RAY_MODEL_ID=local-1b-q4
RAY_MODEL_BASE_URL=http://127.0.0.1:8081
RAY_MODEL_REF=local-1b-q4
RAY_MODEL_FAMILY=llama-compatible
RAY_MODEL_QUANTIZATION=q4_k_m
RAY_MODEL_WARM_ON_BOOT=true
RAY_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_MODEL_TIMEOUT_MS=28000
RAY_MODEL_CONTEXT_WINDOW=8192
RAY_MODEL_MAX_OUTPUT_TOKENS=192
RAY_MODEL_TOKENS_PER_SECOND_TARGET=10
RAY_MODEL_MEMORY_CLASS_MIB=4096
RAY_MODEL_PREFERRED_CTX_SIZE=2048
RAY_LLAMA_CPP_BASE_URL=http://127.0.0.1:8081
RAY_LLAMA_CPP_MODEL_REF=local-1b-q4
RAY_LLAMA_CPP_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_LLAMA_CPP_BINARY_PATH=/usr/local/bin/llama-server
RAY_LLAMA_CPP_ALIAS=local-1b-q4
RAY_LLAMA_CPP_HOST=127.0.0.1
RAY_LLAMA_CPP_PORT=8081
RAY_LLAMA_CPP_CTX_SIZE=2048
RAY_LLAMA_CPP_PARALLEL=1
RAY_LLAMA_CPP_THREADS=2
RAY_LLAMA_CPP_THREADS_BATCH=2
RAY_LLAMA_CPP_THREADS_HTTP=2
RAY_LLAMA_CPP_BATCH_SIZE=192
RAY_LLAMA_CPP_UBATCH_SIZE=96
RAY_LLAMA_CPP_CACHE_REUSE=192
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
RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=2048
RAY_SCHEDULER_REQUEST_TIMEOUT_MS=32000
RAY_SCHEDULER_DEDUPE_INFLIGHT=true
RAY_SCHEDULER_BATCH_WINDOW_MS=5
RAY_SCHEDULER_AFFINITY_LOOKAHEAD=12
RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS=96
RAY_CACHE_ENABLED=true
RAY_CACHE_MAX_ENTRIES=256
RAY_CACHE_MAX_BYTES=2097152
RAY_CACHE_TTL_MS=120000
RAY_CACHE_KEY_STRATEGY=input+params
RAY_PROMPT_COMPILER_ENABLED=true
RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE=true
RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES=true
RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS=promptFamily,taskTemplate,template,useCase
RAY_GRACEFUL_DEGRADATION_ENABLED=true
RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD=10
RAY_DEGRADATION_MAX_PROMPT_CHARS=5000
RAY_DEGRADATION_MAX_TOKENS=128
RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=512
RAY_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO_THRESHOLD=0.9
RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD=0.2
RAY_DEGRADATION_MEMORY_PSI_SOME_AVG10_THRESHOLD=10
RAY_DEGRADATION_MEMORY_PSI_FULL_AVG10_THRESHOLD=1
RAY_DEGRADATION_CPU_PSI_SOME_AVG10_THRESHOLD=50
RAY_DEGRADATION_CPU_PSI_FULL_AVG10_THRESHOLD=5
RAY_ASYNC_QUEUE_ENABLED=true
RAY_ADAPTIVE_TUNING_ENABLED=true
RAY_ADAPTIVE_SAMPLE_SIZE=32
RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS=600
RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND=8
RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO=0.5
RAY_ADAPTIVE_MIN_OUTPUT_TOKENS=64
RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED=true
RAY_ADAPTIVE_FAMILY_HISTORY_SIZE=64
RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES=8
RAY_ADAPTIVE_DRAFT_PERCENTILE=0.95
RAY_ADAPTIVE_SHORT_PERCENTILE=0.9
RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS=24
RAY_ASYNC_QUEUE_STORAGE_DIR=/var/lib/ray/async-queue
RAY_ASYNC_QUEUE_MAX_JOBS=128
RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=256
RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=86400000
RAY_ASYNC_QUEUE_POLL_INTERVAL_MS=1000
RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY=1
RAY_ASYNC_QUEUE_MAX_ATTEMPTS=3
RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS=5000
RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS=5
RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK=false
RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback.example,*.trusted.example
RAY_AUTH_ENABLED=true
RAY_RATE_LIMIT_ENABLED=true
RAY_RATE_LIMIT_WINDOW_MS=60000
RAY_RATE_LIMIT_MAX_REQUESTS=75
RAY_RATE_LIMIT_MAX_KEYS=4096
RAY_RATE_LIMIT_KEY_STRATEGY=ip+api-key
RAY_RATE_LIMIT_TRUST_PROXY_HEADERS=true
```

### 5. Add the environment file

If you enable inference auth, populate the API keys env file before starting the gateway:

```bash
timeout 60s sudo install -m 0600 -o root -g root /dev/stdin /etc/ray/ray.env <<'EOF'
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

Start from [ray-gateway.service](./ray-gateway.service) and [ray-llama-cpp.service](./ray-llama-cpp.service), or generate both from the deploy package.
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
timeout 120s bun packages/deploy/dist/cli.js render \
  --cwd /srv/ray \
  --config /etc/ray/ray.json \
  --gateway-runtime-binary /usr/local/bin/bun \
  --ray-env-file /etc/ray/ray.env \
  --strict-filesystem \
  --output-dir /tmp/ray-rendered
cat /tmp/ray-rendered/summary.json
timeout 60s sudo cp /tmp/ray-rendered/ray-gateway.service /etc/systemd/system/ray-gateway.service
if [ -f /tmp/ray-rendered/ray-llama-cpp.service ]; then
  timeout 60s sudo cp /tmp/ray-rendered/ray-llama-cpp.service /etc/systemd/system/ray-llama-cpp.service
else
  if [ -f /etc/systemd/system/ray-llama-cpp.service ]; then
    timeout 120s sudo systemctl disable --now ray-llama-cpp.service || true
  fi
  timeout 60s sudo rm -f /etc/systemd/system/ray-llama-cpp.service
fi
timeout 60s sudo systemctl daemon-reload
if [ -f /etc/systemd/system/ray-llama-cpp.service ]; then
  timeout 120s sudo systemctl enable --now ray-llama-cpp.service
fi
timeout 120s sudo systemctl enable --now ray-gateway.service
```

### 7. Install the reverse proxy

Use the generated Caddyfile from the render output so the public domain, request
body cap, gateway port, and upstream response timeouts match the checked config.

```bash
caddy_tmp="$(mktemp)"
caddy_status=0
cp /tmp/ray-rendered/Caddyfile "$caddy_tmp"
timeout 30s sudo caddy validate --config "$caddy_tmp" &&
  timeout 60s sudo install -m 0644 "$caddy_tmp" /etc/caddy/Caddyfile &&
  timeout 120s sudo systemctl enable --now caddy &&
  timeout 60s sudo systemctl reload caddy || caddy_status=$?
rm -f "$caddy_tmp"
test "$caddy_status" -eq 0
```

### 8. Run the deployment checks

```bash
RAY_API_KEYS=replace-with-real-key timeout 300s bun run validate:config:all
timeout 300s bun run deploy:smoke
timeout 300s bun run deploy:scripts
timeout 300s bun run model:stage:smoke
timeout 300s bun run model:stage:1b
timeout 300s bun run model:stage:1b:8gb
timeout 300s bun run model:stage:hetzner-email-ai
RAY_API_KEYS=replace-with-real-key timeout 300s bun run validate:config:public
RAY_API_KEYS=replace-with-real-key timeout 300s bun run validate:config:cax11:public
RAY_API_KEYS=replace-with-real-key timeout 300s bun run validate:config:1b:generic:public
RAY_API_KEYS=replace-with-real-key timeout 300s bun run validate:config:1b:public
RAY_API_KEYS=replace-with-real-key timeout 300s bun run validate:config:hetzner:public
timeout 300s bun run doctor:1b:generic
timeout 300s bun run doctor:cax11
timeout 300s bun run doctor:hetzner-email-ai
timeout 300s bun run doctor
timeout 1800s bun run benchmark:assert:cx23
timeout 1800s bun run benchmark:assert:cax11
timeout 1800s bun run benchmark:assert:cx23:1b
```

### 9. Optional GitHub Actions deploy

The repo includes a generic VPS deploy workflow at
[.github/workflows/deploy-vps.yml](../../../.github/workflows/deploy-vps.yml).
It deploys the Ray gateway itself, not any app that happens to call Ray.

Set these GitHub secrets in your own repo or fork:

- `RAY_DEPLOY_HOST` — VPS hostname or IP
- `RAY_DEPLOY_SSH_KEY` — unencrypted private SSH key for the deploy user; the workflow verifies OpenSSH can read it before opening SSH
- `RAY_DEPLOY_KNOWN_HOSTS` — `known_hosts` entry for the VPS; the workflow validates it before opening SSH, and when `RAY_DEPLOY_SSH_PORT` is not `22`, use the OpenSSH bracket form such as `[ray.example.com]:2222 ssh-ed25519 ...`
- `RAY_CONFIG_JSON` — optional full Ray config JSON to write to `/etc/ray/ray.json`
- `RAY_ENV_FILE_CONTENTS` — complete contents of `/etc/ray/ray.env`; required when the deployed config has auth enabled

Optional repository variables:

- `RAY_DEPLOY_SSH_USER` — SSH login user, defaults to `root`; the workflow validates it as a simple system account name or numeric UID before opening SSH, and non-root users must have passwordless sudo
- `RAY_DEPLOY_SSH_PORT` — SSH port for deploy, defaults to `22`
- `RAY_DEPLOY_SERVICE_USER` — generated non-root systemd service account name or numeric UID, defaults to `ray`; workflow deploys create missing named users, numeric UIDs must already resolve to an account on the VPS, and local deploy CLI runs also honor this value from the process env or `--ray-env-file` when `--user` is omitted
- `RAY_DEPLOY_DOMAIN` — Caddy site address to render, defaults to `ray.local`; set it to the real public DNS name before installing Caddy because render/doctor warn on local placeholder addresses; local deploy CLI runs honor this value from the process env or `--ray-env-file` when `--domain` is omitted, and workflow deploys honor it from `RAY_ENV_FILE_CONTENTS` before repository variables
- `RAY_DEPLOY_MEMORY_MIB` — optional VPS memory class used by workflow doctor/render and model staging when `/etc/ray/ray.env` does not already set it; local deploy CLI runs honor this value from the process env or `--ray-env-file` when `--memory-mib` is omitted, and workflow deploys validate and honor it from `RAY_ENV_FILE_CONTENTS` before repository variables. Render, doctor, and model staging reject targets too small to fit the generated systemd memory floors.
- `RAY_DEPLOY_MIN_FREE_STORAGE_MIB` — minimum free storage the workflow requires before remote package bootstrap, checkout sync follow-up, Bun install-cache use, and Bun production install, defaults to `1024`; set to `0` only when intentionally skipping the deploy storage preflight
- `RAY_DEPLOY_INSTALL_CADDY` — set to `true` to install and reload the generated Caddyfile; requires `RAY_DEPLOY_DOMAIN` to be a real public DNS name, not `ray.local`, `localhost`, loopback, or another `.local` placeholder; workflow deploys honor this value from `RAY_ENV_FILE_CONTENTS` before repository variables
- `RAY_CONFIG_PATH` — repo-relative config path to install, defaults to `./examples/config/ray.sub1b.public.json`; the workflow rejects absolute paths, path traversal, and paths excluded from repo sync before opening SSH
- `RAY_GATEWAY_RUNTIME_BINARY` — absolute JavaScript runtime path rendered into `ray-gateway.service`, defaults to `/usr/local/bin/bun`; the deploy CLI and workflow reject relative paths, paths under `/home`, `/root`, or `/run/user` because generated units use `ProtectHome=true`, and paths under `/tmp` or `/var/tmp` because generated units use `PrivateTmp=true`
- `RAY_DEPLOY_CADDY_BINARY` — absolute Caddy runtime path for local render/doctor checks and GitHub Actions deploys when `caddy` is not on the deploy user's `PATH`; pass `--caddy-binary` to override it for one command
- `RAY_DEPLOY_READY_TIMEOUT_SECONDS` — bounded wait for `/readyz` after service restart before reloading Caddy, defaults to `120`; workflow deploys validate and honor it from `RAY_ENV_FILE_CONTENTS` before repository variables
- `RAY_AUTO_DEPLOY` — set to `true` if pushes to `main` should auto-deploy

Use `RAY_CONFIG_JSON` when the live deployment needs host-specific or private
settings that should not live in the public repository. If `RAY_CONFIG_JSON` is
present, it takes precedence over `RAY_CONFIG_PATH`; the workflow only stages it
long enough to resolve deployment settings, excludes `.ray-deploy-*` from repo
sync, and writes the live config directly to `/etc/ray/ray.json`.

`RAY_ENV_FILE_CONTENTS` is the right place for auth keys or env overrides. The
workflow applies `RAY_DEPLOY_DOMAIN`, `RAY_DEPLOY_INSTALL_CADDY`,
`RAY_DEPLOY_MEMORY_MIB`, `RAY_DEPLOY_MIN_FREE_STORAGE_MIB`,
`RAY_DEPLOY_READY_TIMEOUT_SECONDS`, `RAY_GATEWAY_RUNTIME_BINARY`,
`RAY_DEPLOY_CADDY_BINARY`, and
`RAY_DEPLOY_SERVICE_USER` from this env file before repository variables when it
wires remote prerequisites, storage preflight, doctor, render, model staging,
readiness waits, and generated service commands. It validates auth API keys
before opening SSH,
refuses
`RAY_DEPLOY_INSTALL_CADDY=true` when the resolved config still has
`auth.enabled=false`, then applies those overrides when choosing the post-restart
health check port. For example:

```dotenv
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_API_KEYS=replace-with-comma-separated-client-keys
RAY_LOG_LEVEL=info
RAY_MODEL_WARM_ON_BOOT=false
RAY_ASYNC_QUEUE_ENABLED=true
RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback.example
RAY_DEPLOY_SERVICE_USER=ray
RAY_DEPLOY_DOMAIN=ray.example.com
RAY_DEPLOY_INSTALL_CADDY=true
RAY_DEPLOY_MEMORY_MIB=4096
RAY_DEPLOY_MIN_FREE_STORAGE_MIB=1024
RAY_DEPLOY_READY_TIMEOUT_SECONDS=180
RAY_GATEWAY_RUNTIME_BINARY=/usr/local/bin/bun
RAY_DEPLOY_CADDY_BINARY=/usr/bin/caddy
RAY_AUTH_ENABLED=true
RAY_RATE_LIMIT_MAX_REQUESTS=75
```

When `RAY_DEPLOY_SERVICE_USER`, `RAY_DEPLOY_DOMAIN`,
`RAY_DEPLOY_MEMORY_MIB`, `RAY_DEPLOY_MIN_FREE_STORAGE_MIB`,
`RAY_DEPLOY_READY_TIMEOUT_SECONDS`, `RAY_GATEWAY_RUNTIME_BINARY`, or
`RAY_DEPLOY_CADDY_BINARY` are supplied as repository variables instead of
env-file lines, the workflow appends the resolved non-secret values to
`/etc/ray/ray.env` when they are absent. That keeps follow-up manual
`doctor`, `render`, and `model:stage` commands aligned with the deployed
service user, domain, memory target, storage cushion, readiness timeout, and
runtime paths.

The workflow validates the deploy SSH user and configured gateway runtime path
after applying env-file overrides and before opening SSH, checks that
`RAY_DEPLOY_KNOWN_HOSTS` contains an entry for the configured host and SSH port,
requires the resolved `RAY_DEPLOY_MIN_FREE_STORAGE_MIB` headroom on the remote
root, `/srv/ray`, `/var/lib/ray`, `/tmp`, `/var/tmp`, and repo-scoped Bun
install-cache paths before bootstrap follow-up or Bun production install can consume more disk,
installs missing remote deploy prerequisites such as `curl`, `ca-certificates`,
`unzip`, and `rsync`, refreshes `/usr/local/bin/bun` when it is missing or older
than the repo's supported Bun runtime, copies that refreshed Bun to custom
`RAY_GATEWAY_RUNTIME_BINARY` paths whose filename is `bun`, prints the resolved
llama.cpp binary and GGUF staging plan for llama.cpp deploy configs, verifies
and stages source artifacts when both `RAY_LLAMA_CPP_BINARY_SOURCE_PATH` and
`RAY_MODEL_SOURCE_PATH` are set in `/etc/ray/ray.env`, then runs
`ray deploy doctor` on the VPS before restarting services. It validates and
passes `RAY_DEPLOY_CADDY_BINARY` through remote doctor, render, and generated
Caddyfile validation when a custom Caddy path is configured. Missing API keys,
missing or corrupt GGUF files,
memory-fit errors, exhausted async queue storage reserves, unsupported gateway
runtimes, broken gateway imports from a missing Bun production install or
workspace build, unsupported generated llama.cpp launch flags, low checkout free space
for the Bun production install, generated systemd unit verification, and
generated Caddyfile validation fail before systemd tries to start the generated units. The
configured gateway runtime binary defaults to `/usr/local/bin/bun`. The workflow
only changes ownership on the checkout root, sets service-readable checkout
modes during rsync, removes stale `node_modules` under a timeout, pins
`BUN_INSTALL_CACHE_DIR` under `/srv/ray/.ray/bun-install-cache`, and runs the
remote Bun production install with `umask 022` so old dev dependencies and
home-directory cache growth do not accumulate even when ownership changed, and
deploys do not recursively chown or chmod the synced repository. Remote Bun
helper commands for config inspection,
staging-plan rendering, doctor, and service rendering run under explicit
timeouts; deploy-time GGUF staging gets a
longer bounded copy window, and each remote SSH session has its own wall-clock
timeout. All workflow SSH and rsync calls run in batch mode
with `StrictHostKeyChecking=yes`,
`IdentitiesOnly=yes`, the validated `RAY_DEPLOY_KNOWN_HOSTS` file, a short
connect timeout, OpenSSH keepalives, an rsync wall-clock timeout, and an rsync
I/O timeout so stalled sessions or repository transfers fail instead of holding
the deploy job indefinitely. State ownership is repaired on the service directories without
recursively walking staged GGUF files on every deploy. Remote sudo calls use
`sudo -n` so a deploy user without passwordless sudo fails immediately instead
of hanging in CI.

When `RAY_DEPLOY_INSTALL_CADDY=true`, the workflow installs Caddy if needed,
validates the rendered Caddyfile before installing it to `/etc/caddy/Caddyfile`,
and reloads Caddy after both local Ray liveness and backend-aware readiness
checks pass. If service enablement, restart, health checks, or Caddy reload fail,
the service-management commands fail under explicit timeouts, and the workflow
prints bounded `systemctl status`, `systemctl show`, and recent `journalctl`
output for the affected unit before exiting.

Without `RAY_AUTO_DEPLOY=true`, the workflow is still available through
`workflow_dispatch` for manual deploys.
Auto-deploy runs only for changes covered by the workflow path filter,
including gateway/packages code, public configs, VPS deploy docs, the workflow
file, package metadata, and the llama.cpp staging helper used during deploy.

## Operational Notes

- Keep the model backend bound to localhost; config loading and doctor reject generated llama.cpp services whose `model.adapter.launchProfile.host` is not `127.0.0.1`, `localhost`, or another loopback address.
- Keep `model.adapter.baseUrl` on plain HTTP at the same loopback host, root, and port as `model.adapter.launchProfile` when Ray renders the llama.cpp service; config loading and doctor reject base URLs that point away from the generated backend.
- For the `vps` and `balanced` OpenAI-compatible profiles, keep `model.adapter.baseUrl` on loopback unless you intentionally leave the one-box topology; doctor warns when those profiles point at a remote backend because Ray is no longer fronting a local self-hosted model.
- Point OpenAI-compatible `model.adapter.baseUrl` at the backend origin or reverse-proxy prefix before `/v1`; Ray appends `/v1/models` and `/v1/chat/completions` itself, and doctor warns when the base URL already ends in `/v1`.
- Let Ray be the public inference surface.
- Keep the Ray gateway bound to localhost and expose it through Caddy or nginx.
- Set `RAY_DEPLOY_DOMAIN` or pass `--domain` with the real public DNS name before installing the generated Caddyfile; render and doctor warn when the generated site address is still `ray.local`, `localhost`, loopback, or another `.local` placeholder.
- Enable `auth.enabled` before exposing Ray publicly; it also protects detailed `/health`, `/metrics`, and `/v1/config` responses.
- Keep `/etc/ray/ray.env` private, for example with `sudo chmod 600 /etc/ray/ray.env`; doctor warns when the env file is group/world-readable.
- Create the generated service user before manual render/restart steps, or set `RAY_DEPLOY_SERVICE_USER` in the deploy env file when not using the default `ray` account; named users are created by the workflow bootstrap when missing, while numeric UIDs must already resolve on the VPS. Use a dedicated non-root account because doctor warns when generated Ray services are configured to run as root.
- Install Bun 1.3+ at `/usr/local/bin/bun`, set `RAY_GATEWAY_RUNTIME_BINARY`, or pass the same `--gateway-runtime-binary` used at render time; keep that runtime outside `/home`, `/root`, `/run/user`, `/tmp`, and `/var/tmp`. Doctor verifies the generated service user can execute the rendered gateway runtime and, for identifiable Bun/Node binaries, that the service user can read a version satisfying Ray's engine requirements before systemd uses it. Node.js remains a compatibility fallback, and doctor warns when a generated VPS service is pointed at Node instead of Bun.
- Install Caddy on `PATH`, set `RAY_DEPLOY_CADDY_BINARY`, or pass `--caddy-binary`; doctor runs that binary for `version` and `validate --config` before you install or reload the generated reverse proxy config.
- Keep `/etc/ray/ray.json` readable by the generated service user, for example with `root:<service-user-primary-group>` ownership and mode `0640`; doctor verifies this before systemd uses it.
- Keep the Ray checkout at the generated `WorkingDirectory` such as `/srv/ray`, not under `/home`, `/root`, or `/run/user`; doctor verifies the directory exists, is not hidden by `ProtectHome=true`, and has read/execute mode bits for the generated service user before systemd uses it.
- Run `timeout 300s bun install --frozen-lockfile` before `timeout 300s bun run build`, then run `timeout 300s bun install --production --frozen-lockfile --ignore-scripts` before rendering or restarting services; doctor verifies the built gateway entrypoint exists under the generated `WorkingDirectory`, is readable by the generated service user, and can be imported by the configured gateway runtime with the installed workspace packages.
- Use `/livez` for reverse-proxy liveness checks, and `/readyz` when a dependent app needs a minimal backend-aware readiness check; `/readyz` returns 503 while the provider is unavailable or still warming, then reports provider status, queue depth, in-flight requests, pressure booleans, and non-secret reason codes for provider, queue, provider-preparation, memory, CPU, async-queue, or gateway HTTP socket degradation. `/health` and `/metrics` include cgroup memory and swap gauges so the recommended swap cushion is visible before a small VPS starts thrashing. The deploy workflow prints the final readiness snapshot before Caddy reloads or when readiness times out. The gateway binds before provider warmup finishes and retries failed warmups in the background, so a slow local model backend should not make systemd treat the gateway process itself as dead.
- Gateway HTTP resource use is bounded for unattended VPS operation: accepted sockets, total header bytes, header count, keep-alive reuse, header read time, request time, and shutdown drain time all have fixed ceilings. Parser-level bad request and header-overflow rejects are warning-logged without stacks. SIGTERM stops new HTTP sockets, closes idle keep-alives, and force-closes active connections after 30 seconds so the generated `TimeoutStopSec=35` unit does not hang on a stuck client.
- Let the generated Caddy upstream timeouts track `scheduler.requestTimeoutMs`; public proxy sockets should not outlive Ray's own request budget for long.
- Keep the gateway `server.port` distinct from `model.adapter.launchProfile.port`; config loading and doctor reject overlapping generated gateway and llama.cpp listen sockets before systemd restarts the services.
- Keep `model.adapter.baseUrl` pointed at the model backend, not the gateway's own host and port; config loading and doctor reject self-targeting adapter URLs that would recursively call Ray instead of the backend.
- The generated llama.cpp unit mirrors first-class launch profile settings into both `Environment=` defaults and explicit `ExecStart` flags so current and older `llama-server` builds receive the same bind, model, context, batching, thread, cache, slot, metrics, and warmup settings. Use `model.adapter.launchProfile.extraArgs` only for non-profile llama.cpp flags such as template or mmap tuning. Config loading and the systemd renderer reject extra args that override those generated settings; command-line args take priority over llama.cpp environment defaults, so those settings must stay in first-class config or `RAY_LLAMA_CPP_*` env overrides.
- The generated systemd units enable CPU, memory, and IO accounting, so `systemctl show ray-gateway.service -p CPUUsageNSec -p MemoryCurrent -p IOReadBytes -p IOWriteBytes` can confirm pressure without extra agents.
- `/metrics` exposes gateway HTTP sockets, active requests, connection-ceiling ratio, HTTP parser limits, warmup attempts, failures, retry scheduling, and recovery state, so socket saturation and repeated backend startup races are visible without scraping logs.
- The generated systemd units rate-limit journal output so crash loops or verbose local backends cannot quickly fill a small VPS disk.
- The generated systemd units set `CPUWeight` so the lightweight gateway gets a larger CPU share than the local model backend when both contend on a small node.
- The generated systemd units also set `MemoryHigh`, `MemoryMax`, and `MemorySwapMax` cgroup ceilings from the gateway profile and llama.cpp memory budget, reserving the gateway ceiling before sizing the backend so one-node VPS hosts keep an OS cushion instead of letting both services consume the whole memory budget.
- Use `RAY_DEPLOY_MEMORY_MIB` in the deploy env file, or pass `--memory-mib`, when render or doctor should size llama.cpp against an explicit VPS memory class instead of the config `model.operational.memoryClassMiB`, detected host, or launch-profile preset. The explicit flag wins when both are present; render/doctor reject targets too small to fit the system reserve, generated gateway `MemoryMax`, and the minimum backend `MemoryMax`, and doctor errors when the override is larger than the detected VPS RAM.
- The generated systemd units also set OOM policy and OOM score adjustments so the lightweight gateway is less kill-prone than the local model backend under last-resort memory pressure.
- The generated systemd units also drop Linux capabilities, restrict address families to local/IP sockets, deny namespace creation and realtime scheduling, and hide host identity, host devices, and kernel controls. Keep custom service overrides equally narrow unless a backend explicitly needs broader access.
- The generated gateway unit intentionally does not set `MemoryDenyWriteExecute=true`; Bun and Node can need executable memory for their JavaScript runtimes. Keep that directive limited to native backend units such as the generated `ray-llama-cpp.service`.
- Keep generated-service paths out of `/home`, `/root`, `/run/user`, `/tmp`, and `/var/tmp`; the units use `ProtectHome=true` and `PrivateTmp=true`, so put the checkout under `/srv/ray`, config under `/etc/ray`, GGUF files under `/var/lib/ray/models`, and `llama-server` plus Bun under `/usr/local/bin`.
- Use `bun run model:stage*` after writing `/etc/ray/ray.env` to stage `llama-server` and the GGUF at the resolved paths before restarting the generated backend unit. Printed staging commands are timeout-bounded, check generated launch-flag support, check the apparent GGUF size against the generated backend `MemoryMax` budget and target disk headroom before replacing either target, stage through same-directory `.ray-stage-*` temp files before replacement, and the env file can also carry optional staging source paths and checksums for concrete deploy-workflow plans.
- Config loading rejects unresolved relative `model.adapter.launchProfile.binaryPath` values before render; doctor then verifies that the resolved path points at an executable `llama-server`, that the generated service user can start its `--help` probe, that its help output lists the generated launch flags, and that the generated service user can read the GGUF model before the generated backend service is restarted.
- Keep `RAY_LLAMA_CPP_CONTINUOUS_BATCHING=true`, `RAY_LLAMA_CPP_WARMUP=true`, and `RAY_LLAMA_CPP_CONTEXT_SHIFT=true` unless the backend build cannot support them. Doctor warns when these first-class llama.cpp launch controls are disabled because batching, warmup, and context shifting keep small backends more predictable.
- Keep `cacheRamMiB` pinned for `llama.cpp`. The upstream default is too large for a 4 GB VPS.
- Tune `scheduler.concurrency` conservatively. Tiny hardware collapses faster from overcommit than underutilization, and doctor warns when scheduler concurrency is above the detected VPS vCPU count.
- Keep `RAY_LLAMA_CPP_THREADS` and `RAY_LLAMA_CPP_THREADS_BATCH` at or below the VPS vCPU count. Doctor records detected host CPU count and warns when the launch profile overcommits compute threads.
- Keep `scheduler.requestTimeoutMs` slightly above `model.adapter.timeoutMs` so provider timeouts remain visible.
- Keep `RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS` below both `scheduler.requestTimeoutMs` and `model.adapter.timeoutMs`; doctor warns when the threshold is too high to log slow inference before timeout handling takes over.
- Keep `RAY_LOG_LEVEL=info` or `warn` on VPS deployments unless external monitoring already covers client rejections, timeout backpressure, parser rejects, and slow inference; doctor warns when `error` would hide those warning-level signals.
- Keep `RAY_SCHEDULER_DEDUPE_INFLIGHT=true` so duplicate requests share in-flight work instead of occupying scarce backend slots. Doctor warns when in-flight deduplication is disabled.
- Keep `scheduler.maxQueuedTokens` and `scheduler.maxInflightTokens` sized for the gateway memory limit. Doctor warns when their estimated token buffer can consume too much of the generated gateway `MemoryMax`.
- Keep `RAY_GRACEFUL_DEGRADATION_ENABLED=true` on cheap single-node VPS deployments. Doctor warns when it is disabled because queue, prompt, memory, CPU, and PSI clamps are part of the overload-shedding contract.
- Keep `RAY_PROMPT_COMPILER_ENABLED=true`, `RAY_ADAPTIVE_TUNING_ENABLED=true`, and `RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED=true` for VPS profiles. Doctor warns when these are disabled because prompt normalization, pressure-based caps, and learned prompt-family caps keep repeated work from crowding out the backend.
- Keep `RAY_DEGRADATION_MAX_TOKENS` and `RAY_ADAPTIVE_MIN_OUTPUT_TOKENS` below `RAY_MODEL_MAX_OUTPUT_TOKENS`, and keep `RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO` above zero. Doctor warns when output clamps validate but cannot actually reduce completion length.
- Keep `RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD` below `RAY_SCHEDULER_MAX_QUEUE` when graceful degradation is enabled. Config loading rejects thresholds at or above the queue cap because accepted requests would hit admission backpressure before the queue-pressure output clamp can apply.
- Use `RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB` when the gateway process needs to clamp output before RSS pressure becomes a swap or OOM problem.
- Use `RAY_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO_THRESHOLD` when generated cgroup memory ceilings need a more or less aggressive clamp before the gateway reaches `MemoryHigh` or `MemoryMax`.
- Use `RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD` when a VPS provider's CPU quota needs a more or less aggressive output clamp under cgroup throttling.
- Use the `RAY_DEGRADATION_*_PSI_*_AVG10_THRESHOLD` values when a VPS needs more or less aggressive clamps from Linux CPU or memory stall pressure.
- Keep `RAY_SCHEDULER_MAX_QUEUED_TOKENS` and `RAY_SCHEDULER_MAX_INFLIGHT_TOKENS` above `RAY_MODEL_MAX_OUTPUT_TOKENS`; config loading rejects budgets that cannot admit one default request plus a minimal prompt token before a VPS restart can ship a gateway that rejects ordinary inference.
- Use explicit env switches such as `RAY_MODEL_WARM_ON_BOOT`, `RAY_MODEL_API_KEY_ENV`, `RAY_LLAMA_CPP_CACHE_PROMPT`, `RAY_LLAMA_CPP_ENABLE_METRICS`, `RAY_LLAMA_CPP_EXPOSE_SLOTS`, `RAY_ASYNC_QUEUE_ENABLED`, `RAY_CACHE_ENABLED`, `RAY_GRACEFUL_DEGRADATION_ENABLED`, `RAY_PROMPT_COMPILER_ENABLED`, `RAY_ADAPTIVE_TUNING_ENABLED`, `RAY_AUTH_ENABLED`, `RAY_AUTH_API_KEY_ENV`, `RAY_RATE_LIMIT_ENABLED`, and `RAY_RATE_LIMIT_TRUST_PROXY_HEADERS` when a VPS needs operational behavior changed without forking JSON. Use `RAY_HOST`, `RAY_PORT`, `RAY_MODEL_BASE_URL`, `RAY_MODEL_REF`, `RAY_MODEL_CONTEXT_WINDOW`, and `RAY_MODEL_MAX_OUTPUT_TOKENS` only when the generated config must move ports, backends, or context/output budgets. Use `RAY_LOG_LEVEL`, `RAY_TELEMETRY_SERVICE_NAME`, `RAY_TELEMETRY_INCLUDE_DEBUG_METRICS`, and `RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS` to match the VPS monitoring and log-routing setup. Use `RAY_LLAMA_CPP_SLOT_STATE_TTL_MS`, `RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS`, and `RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES` to tune llama.cpp slot reuse and prompt-scaffold cache behavior for the actual backend. Use `RAY_SCHEDULER_BATCH_WINDOW_MS`, `RAY_SCHEDULER_AFFINITY_LOOKAHEAD`, and `RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS` to tune batching, prompt-affinity reuse, and short-job priority from `/etc/ray/ray.env`. Use `RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD`, `RAY_DEGRADATION_MAX_PROMPT_CHARS`, `RAY_DEGRADATION_MAX_TOKENS`, `RAY_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO_THRESHOLD`, `RAY_DEGRADATION_MEMORY_PSI_SOME_AVG10_THRESHOLD`, `RAY_DEGRADATION_MEMORY_PSI_FULL_AVG10_THRESHOLD`, `RAY_DEGRADATION_CPU_PSI_SOME_AVG10_THRESHOLD`, and `RAY_DEGRADATION_CPU_PSI_FULL_AVG10_THRESHOLD` to make queue, prompt, cgroup memory, and Linux PSI pressure clamps more or less aggressive for the actual box. Use `RAY_CACHE_KEY_STRATEGY`, `RAY_CACHE_MAX_ENTRIES`, `RAY_CACHE_MAX_BYTES`, and `RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS` to trade cache reuse, memory use, and learned prompt-family grouping for the actual workload. Use `RAY_RATE_LIMIT_WINDOW_MS`, `RAY_RATE_LIMIT_MAX_REQUESTS`, `RAY_RATE_LIMIT_MAX_KEYS`, and `RAY_RATE_LIMIT_KEY_STRATEGY` to tune public request budgets from `/etc/ray/ray.env`. Use `RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS`, `RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND`, and `RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO` when a model or VPS class needs more or less aggressive learned output clamps. Keep public deployments authenticated.
- Keep `RAY_REQUEST_BODY_LIMIT_BYTES` close to the largest prompt payload the workload actually needs. Doctor warns when the body cap can retain too much admitted upload data against the generated gateway `MemoryMax`.
- Keep `RAY_RATE_LIMIT_TRUST_PROXY_HEADERS=true` for the generated loopback-only Caddy deployment so IP-based rate limits see the real client address, but disable it if Ray is ever exposed directly; doctor warns when this proxy-header posture does not match the gateway bind mode. If auth is disabled, use `RAY_RATE_LIMIT_KEY_STRATEGY=ip`; doctor warns because API-key strategies ignore unverified bearer tokens and fall back to IP-only limiting.
- Keep `RAY_RATE_LIMIT_MAX_KEYS` near the expected active client/key cardinality. Doctor warns when the in-process rate-limit key table can consume too much of the generated gateway `MemoryMax`, and `/health`, `/readyz`, and `/metrics` expose active key-table pressure before public key churn starts evicting older callers.
- Keep a modest swap file on 4 GB llama.cpp VPS targets. Doctor reads `/proc/meminfo` and warns when the small-VPS profile has no swap cushion or the configured swap is almost exhausted; `bun run swap:plan` prints guarded, timeout-bounded commands for creating the default 1 GiB swap file after confirming the swap parent filesystem can still keep the configured free-space cushion, `bun run swap:plan -- --min-free-after-mib 1024` preserves more post-swap disk headroom, and `bun run swap:plan -- --sysctl-only --swappiness 10` corrects eager host swapping without touching existing swap files.
- Ray samples cgroup CPU quota and throttling counters when available, exposes effective quota cores, throttled periods, throttled time, and throttled ratio in health and metrics, and clamps output under sustained throttling when graceful degradation is enabled.
- Ray also samples Linux pressure stall information and cgroup memory files when available, marks memory pressure when the service or container reaches the configured cgroup memory or swap pressure ratio or PSI reports sustained stalls, and exposes process RSS pressure ratio, PSI CPU/memory stall gauges, cgroup swap usage from v2 `memory.swap.*` or legacy v1 `memory.memsw.*` files, plus cgroup v2 `memory.events` counters in health and metrics so operators can see when CPU contention, swap, `MemoryHigh`, or OOM boundaries were crossed.
- Detailed `/health` exposes provider-preparation, cache entry/byte occupancy and churn counters, durable async-queue, retained async job and callback outcome counts, scheduled async retry counts, rate-limit key-table pressure, gateway HTTP socket pressure, request-body cap, HTTP limits, queue depth, in-flight work, queued-token, and in-flight-token saturation ratios so operators can see admission pressure without a separate metrics scrape.
- The `/metrics` endpoint refreshes live provider-preparation, queue, cache saturation and eviction/drop counters, async-job saturation, async storage headroom, retained async job and callback outcome counts, scheduled async retry counts, rate-limit key-table pressure, gateway HTTP socket saturation, request-body cap, threshold gauges, and cgroup resource gauges before responding, so a scraper can observe current pressure without a separate health probe.
- Use `RAY_ASYNC_QUEUE_MAX_JOBS` and `RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB` together so durable-job capacity does not consume the storage reserve a cheap VPS needs for deploys, logs, swap, and model files. Use `RAY_ASYNC_QUEUE_POLL_INTERVAL_MS`, `RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY`, `RAY_ASYNC_QUEUE_MAX_ATTEMPTS`, `RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS`, and `RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS` to tune durable-job dispatch from `/etc/ray/ray.env`; retry counts are capped at 100 so a bad endpoint or backend cannot create unbounded retry loops. Doctor warns when `asyncQueue.pollIntervalMs` is too low for a small VPS because failed jobs and callbacks can churn CPU, disk writes, and logs while a backend or callback endpoint is unhealthy, when `asyncQueue.maxJobs` can retain more persisted job data than the configured storage reserve, and when `asyncQueue.dispatchConcurrency` is higher than `scheduler.concurrency`, because extra durable dispatchers cannot create more backend slots on a single VPS. Doctor checks the nearest existing parent of `RAY_ASYNC_QUEUE_STORAGE_DIR`, so it catches a too-small VPS disk even before the queue directory exists; for `/var/lib/ray/...`, the generated `StateDirectory=ray` creates `/var/lib/ray`, while custom storage paths must already be writable by the generated service user.
- Keep async callback URLs on global public addresses by default. Doctor warns when `asyncQueue.callbackAllowPrivateNetwork` or `asyncQueue.callbackAllowedHosts` bypass the normal callback DNS/network guardrails; prefer `RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS` with a small comma-separated allowlist of operator-owned callback hosts over `RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK=true`. Allowlist entries must be exact host/IP literals such as `callback.example.com` or wildcard DNS suffix patterns such as `*.example.com`, not full URLs or `host:port` values.
- Keep the gateway cache enabled and bounded. Ray is designed to stay predictable under memory pressure, and doctor warns when `RAY_CACHE_ENABLED=false`, when `RAY_CACHE_MAX_BYTES` can grow past the small-VPS threshold for the generated gateway `MemoryMax`, or when `RAY_CACHE_KEY_STRATEGY=input` would ignore generation controls such as `maxTokens`, `temperature`, and `topP`.
- Prefer quantized models that fit comfortably rather than models that technically boot.
