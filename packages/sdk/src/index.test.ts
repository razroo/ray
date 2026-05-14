import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { RayClient } from "./index.js";

test("RayClient rejects invalid direct options", () => {
  assert.throws(() => new RayClient(null as never), /RayClient options must be an object/);
  assert.throws(() => new RayClient({ baseUrl: "ftp://127.0.0.1" }), /baseUrl/);
  assert.throws(() => new RayClient({ baseUrl: "http://127.0.0.1/?debug=true" }), /baseUrl/);
  assert.throws(
    () => new RayClient({ baseUrl: " http://127.0.0.1" }),
    /baseUrl must not contain unencoded whitespace or control characters/,
  );
  assert.throws(
    () => new RayClient({ baseUrl: "http://exa\tmple.com" }),
    /baseUrl must not contain unencoded whitespace or control characters/,
  );
  assert.throws(() => new RayClient({ baseUrl: "http://127.0.0.1", timeoutMs: 0 }), /timeoutMs/);
  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", timeoutMs: 600_001 }),
    /timeoutMs/,
  );
  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", requestBodyLimitBytes: 0 }),
    /requestBodyLimitBytes/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        requestBodyLimitBytes: 1_048_577,
      }),
    /requestBodyLimitBytes/,
  );
  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", responseBodyLimitBytes: Infinity }),
    /responseBodyLimitBytes/,
  );
  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", headers: { "x-bad\nname": "value" } }),
    /headers names/,
  );
  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", headers: { "x-test": "bad\nvalue" } }),
    /headers values/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: null as unknown as Record<string, string>,
      }),
    /headers must be an object/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: JSON.parse('{"__proto__":"polluted"}') as Record<string, string>,
      }),
    /headers names must not contain unsafe key "__proto__"/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: { "content-length": "999999" },
      }),
    /reserved HTTP header "content-length"/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: { "content-encoding": "gzip" },
      }),
    /reserved HTTP header "content-encoding"/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: { host: "example.com" },
      }),
    /reserved HTTP header "host"/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: { "X-Ray-Test": "one", "x-ray-test": "two" },
      }),
    /duplicate HTTP header "x-ray-test"/,
  );

  const headers = {};
  Object.defineProperty(headers, "x-ray-test", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        headers: headers as Record<string, string>,
      }),
    /headers must not contain unreadable properties/,
  );

  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", apiKey: "x".repeat(1_025) }),
    /apiKey/,
  );
  assert.throws(
    () =>
      new RayClient({
        baseUrl: "http://127.0.0.1",
        apiKey: `bad${String.fromCharCode(0x1f)}token`,
      }),
    /apiKey must be a bounded bearer token string without whitespace or control characters/,
  );
});

test("RayClient snapshots direct options at construction", async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        authorization: request.headers.authorization,
        header: request.headers["x-ray-test"],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const options = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    headers: {
      "x-ray-test": "initial-header",
    },
    apiKey: "initial-key",
  };
  const client = new RayClient(options);
  options.headers["x-ray-test"] = "mutated-header";
  options.apiKey = "mutated-key";

  assert.deepEqual(await client.config(), {
    authorization: "Bearer initial-key",
    header: "initial-header",
  });
});

test("RayClient fetches unauthenticated readiness snapshots", async (t) => {
  const seenPaths: string[] = [];
  const server = createServer((request, response) => {
    seenPaths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "degraded",
        service: "ray-gateway",
        providerStatus: "ready",
        queueDepth: 3,
        inFlight: 1,
        pressure: {
          queue: true,
          preparation: false,
          memory: false,
          cpu: false,
          asyncQueue: false,
          rateLimit: false,
          gatewayHttp: false,
        },
        reasons: ["queue_pressure"],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const readiness = await client.readyz();

  assert.deepEqual(seenPaths, ["/readyz"]);
  assert.equal(readiness.status, "degraded");
  assert.equal(readiness.providerStatus, "ready");
  assert.equal(readiness.queueDepth, 3);
  assert.equal(readiness.pressure.queue, true);
  assert.deepEqual(readiness.reasons, ["queue_pressure"]);
});

test("RayClient accepts structured JSON response media types", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/vnd.ray+json; charset=utf-8" });
    response.end(
      JSON.stringify({
        status: "ok",
        service: "ray-gateway",
        providerStatus: "ready",
        queueDepth: 0,
        inFlight: 0,
        pressure: {
          queue: false,
          preparation: false,
          memory: false,
          cpu: false,
          asyncQueue: false,
          rateLimit: false,
          gatewayHttp: false,
        },
        reasons: [],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const readiness = await client.readyz();

  assert.equal(readiness.status, "ok");
});

test("RayClient rejects successful non-JSON responses before parsing", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; note=application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  await assert.rejects(
    () => client.readyz(),
    /must use application\/json or application\/\*\+json content type/,
  );
});

test("RayClient reports malformed successful JSON responses with route context", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end("{");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  await assert.rejects(
    () => client.readyz(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ray response for \/readyz must be valid JSON/);
      assert.match(error.message, /JSON/);
      return true;
    },
  );
});

test("RayClient refuses to follow redirects away from the configured gateway", async (t) => {
  let redirectedRequests = 0;
  let redirectedAuthorization: string | undefined;
  const redirectedServer = createServer((request, response) => {
    redirectedRequests += 1;
    redirectedAuthorization =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ready" }));
  });

  await new Promise<void>((resolve) => redirectedServer.listen(0, "127.0.0.1", resolve));
  t.after(() => redirectedServer.close());

  const redirectedAddress = redirectedServer.address();
  if (!redirectedAddress || typeof redirectedAddress === "string") {
    throw new Error("Expected a TCP server address");
  }

  const redirectingServer = createServer((_request, response) => {
    response.writeHead(307, {
      "content-type": "application/json",
      location: `http://127.0.0.1:${redirectedAddress.port}/readyz`,
    });
    response.end(JSON.stringify({ error: { code: "redirected" } }));
  });

  await new Promise<void>((resolve) => redirectingServer.listen(0, "127.0.0.1", resolve));
  t.after(() => redirectingServer.close());

  const redirectingAddress = redirectingServer.address();
  if (!redirectingAddress || typeof redirectingAddress === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${redirectingAddress.port}`,
    apiKey: "client-secret",
  });

  await assert.rejects(() => client.readyz(), /Ray request failed with 307/);
  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedAuthorization, undefined);
});

test("RayClient times out stalled requests", async (t) => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    }, 100);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    timeoutMs: 10,
  });

  await assert.rejects(() => client.health(), /timed out after 10ms/);
});

test("RayClient rejects oversized request bodies before dispatch", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: "ok" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestBodyLimitBytes: 16,
  });

  assert.throws(
    () => client.infer({ input: "x".repeat(64) }),
    /Ray request body exceeded 16 bytes/,
  );
  assert.throws(
    () => client.createJob({ input: "x".repeat(64) }),
    /Ray request body exceeded 16 bytes/,
  );
  assert.equal(requests, 0);
});

test("RayClient rejects non-serializable request bodies before dispatch", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: "ok" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  const request: Record<string, unknown> = { input: "hello" };
  request.self = request;

  assert.throws(() => client.infer(request as never), /Ray request body must be JSON serializable/);
  assert.equal(requests, 0);
});

test("RayClient caps error response bodies", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.write("x".repeat(64));
    response.end("x".repeat(64));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    responseBodyLimitBytes: 16,
  });

  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /response body truncated at 16 bytes/);
      assert.match(error.message, /x{16}/);
      assert.doesNotMatch(error.message, /x{17}/);
      return true;
    },
  );
});

test("RayClient redacts stack fields from JSON error responses", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        error: {
          code: "gateway_error",
          message: "gateway failed",
          details: {
            stack: "internal stack trace",
            cause: {
              message: "backend failed",
              stack: "nested stack trace",
            },
          },
        },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /gateway_error/);
      assert.match(error.message, /backend failed/);
      assert.doesNotMatch(error.message, /internal stack trace/);
      assert.doesNotMatch(error.message, /nested stack trace/);
      return true;
    },
  );
});

test("RayClient rejects oversized successful responses", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(128));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    responseBodyLimitBytes: 16,
  });

  await assert.rejects(() => client.health(), /Ray response exceeded 16 bytes/);
});

test("RayClient rejects declared oversized successful responses before reading body", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "17",
    });
    response.end("x");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    responseBodyLimitBytes: 16,
  });

  await assert.rejects(() => client.health(), /Ray response exceeded 16 bytes/);
});

test("RayClient validates async job ids before request dispatch", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "job_ok", status: "succeeded" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const client = new RayClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  assert.throws(() => client.job("../job"), /jobId must be 1-128 characters/);
  assert.throws(() => client.job("x".repeat(129)), /jobId must be 1-128 characters/);
  assert.equal(requests, 0);
});
