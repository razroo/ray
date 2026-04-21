# @ray/sdk

Minimal TypeScript client for the [Ray](https://github.com/razroo/ray) inference gateway HTTP API.

## Install

```bash
npm install @ray/sdk
```

Requires `@ray/core` (installed automatically as a dependency).

## Usage

```typescript
import { RayClient } from "@ray/sdk";

const client = new RayClient({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.RAY_API_KEY,
});

const result = await client.infer({ input: "Hello." });
```

See the gateway routes under `apps/gateway` and shared types in `@ray/core` for request and response shapes.
