# @razroo/ray-core

Shared TypeScript types, errors, and utility helpers for the Ray inference gateway and SDK.

## Install

```bash
bun add @razroo/ray-core
```

Most applications should install `@razroo/ray-sdk`, which depends on this package and provides the HTTP client.

## Usage

```typescript
import type { HealthSnapshot, InferenceRequest, InferenceResponse } from "@razroo/ray-core";
import { RayError, toErrorMessage } from "@razroo/ray-core";

export function assertInferenceRequest(request: InferenceRequest): void {
  if (!request.input.trim()) {
    throw new RayError("Inference input is required", {
      code: "invalid_request",
      status: 400,
    });
  }
}

export function logInferenceError(error: unknown): string {
  return toErrorMessage(error);
}
```

`@razroo/ray-core` does not start a gateway or model backend. It only publishes the shared contracts used by the gateway, the SDK, and downstream integrations.
