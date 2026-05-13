# @razroo/ray-sdk

Minimal TypeScript client for the [Ray](https://github.com/razroo/ray) inference gateway HTTP API.

## Install

```bash
bun add @razroo/ray-sdk
```

Requires `@razroo/ray-core` (installed automatically as a dependency).

## Usage

```typescript
import { RayClient } from "@razroo/ray-sdk";

const client = new RayClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.RAY_API_KEY,
  timeoutMs: 60_000,
  responseBodyLimitBytes: 2 * 1024 * 1024,
});

const result = await client.infer({
  input: "Hello.",
  seed: 17,
});

const job = await client.createJob({
  input: "Draft a short follow-up email body.",
  seed: 17,
  stop: ["\n\n"],
});

const finalJob = await client.job(job.id);

const readiness = await client.readyz();
```

Pass `callbackUrl` only when it points to an endpoint you operate.

Use `readyz()` for the unauthenticated minimal readiness payload and `health()` for the detailed protected health snapshot. See the gateway routes under `apps/gateway` and shared types in `@razroo/ray-core` for request and response shapes.

`timeoutMs` defaults to `60000`, and `responseBodyLimitBytes` defaults to `2097152`. SDK requests do not follow redirects, successful responses must use `application/json` or `application/*+json`, and oversized bodies are rejected before parsing.
