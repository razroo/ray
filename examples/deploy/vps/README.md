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

Use any lightweight OpenAI-compatible backend you trust. A typical `llama.cpp` shape is:

```bash
./llama-server \
  --host 127.0.0.1 \
  --port 8081 \
  --model /srv/models/qwen2.5-3b-instruct-q4_k_m.gguf \
  --ctx-size 8192
```

### 3. Build Ray

```bash
git clone https://github.com/razroo/ray.git
cd ray
pnpm install
pnpm build
```

### 4. Place the config

Start from [ray.vps.json](../../config/ray.vps.json) and adjust:

- `model.id`
- `model.adapter.modelRef`
- `model.adapter.baseUrl`
- `auth.enabled`
- `rateLimit.maxRequests`

Put the final file somewhere stable, for example:

```bash
sudo mkdir -p /etc/ray
sudo cp examples/config/ray.vps.json /etc/ray/ray.vps.json
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
pnpm validate:config
pnpm doctor
```

## Operational Notes

- Keep the model backend bound to localhost.
- Let Ray be the public inference surface.
- Keep the Ray gateway bound to localhost and expose it through Caddy or nginx.
- Enable `auth.enabled` before exposing `/v1/infer` publicly.
- Tune `scheduler.concurrency` conservatively. Tiny hardware collapses faster from overcommit than underutilization.
- Keep `scheduler.requestTimeoutMs` slightly above `model.adapter.timeoutMs` so provider timeouts remain visible.
- Keep the cache bounded. Ray is designed to stay predictable under memory pressure.
- Prefer quantized models that fit comfortably rather than models that technically boot.
