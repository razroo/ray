# Cheap VPS Deployment

This example assumes the deployment target is a small Linux VPS with:

- 2 vCPU
- 4 GB RAM
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

That keeps the Node process small while still making self-hosted inference operationally usable.

## Deployment Flow

### 1. Install base tools

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
```

### 2. Run a local model backend

Use any lightweight OpenAI-compatible backend you trust. The default Ray `sub1b` profile assumes a CX23-class x86 `llama.cpp` shape close to:

```bash
./llama-server \
  --host 127.0.0.1 \
  --port 8081 \
  --model /srv/models/qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --alias qwen2.5-0.5b-instruct-q4_k_m \
  --ctx-size 3072 \
  --parallel 2 \
  --threads 2 \
  --threads-http 2 \
  --batch-size 256 \
  --ubatch-size 128 \
  --cache-prompt \
  --cache-reuse 256 \
  --cache-ram 512 \
  --metrics \
  --slots \
  --warmup \
  --kv-unified \
  --cache-idle-slots \
  --context-shift
```

For the 1B profile on the same 4 GB class, keep `--parallel 1`, lower `--ctx-size` to `2048`, and use the 1.5B-class GGUF path from [ray.1b.public.json](../../config/ray.1b.public.json). On an 8 GB node, [ray.1b.8gb.public.json](../../config/ray.1b.8gb.public.json) raises context to `4096` and uses two parallel slots.

### 3. Build Ray

```bash
git clone https://github.com/razroo/ray.git
cd ray
pnpm install
pnpm build
```

### 4. Place the config

Start from [ray.sub1b.public.json](../../config/ray.sub1b.public.json) for a public CX23-class VPS, or [ray.sub1b.json](../../config/ray.sub1b.json) for local/private loopback use. For the ARM CAX11 variant, use [ray.sub1b.cax11.public.json](../../config/ray.sub1b.cax11.public.json) or [ray.sub1b.cax11.json](../../config/ray.sub1b.cax11.json). For better 1B-class email inference, use [ray.1b.public.json](../../config/ray.1b.public.json) on 4 GB or [ray.1b.8gb.public.json](../../config/ray.1b.8gb.public.json) on 8 GB. Adjust:

- `model.id`
- `model.adapter.modelRef`
- `model.adapter.baseUrl`
- `model.adapter.launchProfile.modelPath`
- `auth.enabled`
- `rateLimit.maxRequests`

Put the final file somewhere stable, for example:

```bash
sudo mkdir -p /etc/ray
sudo cp examples/config/ray.sub1b.public.json /etc/ray/ray.json
```

### 5. Add the environment file

If you enable inference auth, populate the API keys env file before starting the gateway:

```bash
sudo tee /etc/ray/ray.env >/dev/null <<'EOF'
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
EOF
```

### 6. Install the systemd unit

Start from [ray-gateway.service](./ray-gateway.service) or generate one from the deploy package.

```bash
sudo cp examples/deploy/vps/ray-gateway.service /etc/systemd/system/ray-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now ray-gateway
```

### 7. Install the reverse proxy

Start from the example [Caddyfile](./Caddyfile).

```bash
sudo cp examples/deploy/vps/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 8. Run the deployment checks

```bash
RAY_API_KEYS=replace-with-real-key pnpm validate:config:public
RAY_API_KEYS=replace-with-real-key pnpm validate:config:1b:public
pnpm doctor
pnpm benchmark:assert:cx23
pnpm benchmark:assert:cx23:1b
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
- `RAY_CONFIG_PATH` — repo-relative config path to install, defaults to `./examples/config/ray.sub1b.public.json`
- `RAY_NODE_MAJOR` — Node major version to install on the VPS when missing, defaults to `22`
- `RAY_AUTO_DEPLOY` — set to `true` if pushes to `main` should auto-deploy

Use `RAY_CONFIG_JSON` when the live deployment needs host-specific or private
settings that should not live in the public repository. If `RAY_CONFIG_JSON` is
present, it takes precedence over `RAY_CONFIG_PATH`.

`RAY_ENV_FILE_CONTENTS` is the right place for auth keys or env overrides, for example:

```dotenv
RAY_API_KEYS=replace-with-comma-separated-client-keys
RAY_LOG_LEVEL=info
```

Without `RAY_AUTO_DEPLOY=true`, the workflow is still available through
`workflow_dispatch` for manual deploys.

## Operational Notes

- Keep the model backend bound to localhost.
- Let Ray be the public inference surface.
- Keep the Ray gateway bound to localhost and expose it through Caddy or nginx.
- Enable `auth.enabled` before exposing Ray publicly; it also protects detailed `/health`, `/metrics`, and `/v1/config` responses.
- Use `/livez` for reverse-proxy health checks.
- Keep `cacheRamMiB` pinned for `llama.cpp`. The upstream default is too large for a 4 GB VPS.
- Tune `scheduler.concurrency` conservatively. Tiny hardware collapses faster from overcommit than underutilization.
- Keep `scheduler.requestTimeoutMs` slightly above `model.adapter.timeoutMs` so provider timeouts remain visible.
- Keep the cache bounded. Ray is designed to stay predictable under memory pressure.
- Prefer quantized models that fit comfortably rather than models that technically boot.
