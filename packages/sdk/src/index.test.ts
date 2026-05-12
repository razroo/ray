import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { RayClient } from "./index.js";

test("RayClient rejects invalid direct options", () => {
  assert.throws(() => new RayClient(null as never), /RayClient options must be an object/);
  assert.throws(() => new RayClient({ baseUrl: "ftp://127.0.0.1" }), /baseUrl/);
  assert.throws(() => new RayClient({ baseUrl: "http://127.0.0.1/?debug=true" }), /baseUrl/);
  assert.throws(() => new RayClient({ baseUrl: "http://127.0.0.1", timeoutMs: 0 }), /timeoutMs/);
  assert.throws(
    () => new RayClient({ baseUrl: "http://127.0.0.1", timeoutMs: 600_001 }),
    /timeoutMs/,
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

test("RayClient caps error response bodies", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
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
