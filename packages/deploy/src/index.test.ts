import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { diagnoseConfig, renderCaddyfile, renderEnvironmentFileExample, renderSystemdService } from "./index.js";

test("renderSystemdService includes hardening directives", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.vps.json",
    user: "ray",
    envFile: "/etc/ray/ray.env",
  });

  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=full/);
  assert.match(service, /EnvironmentFile=\/etc\/ray\/ray.env/);
});

test("renderCaddyfile applies body size and health checks", () => {
  const caddyfile = renderCaddyfile({
    domain: "ray.example.com",
    upstreamPort: 3000,
    requestBodyLimitBytes: 64_000,
  });

  assert.match(caddyfile, /max_size 64000/);
  assert.match(caddyfile, /health_uri \/health/);
});

test("diagnoseConfig flags unsafe public deployment defaults", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    auth: {
      enabled: false,
    },
    rateLimit: {
      enabled: false,
    },
  });

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "auth_disabled"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "rate_limit_disabled"));
});

test("renderEnvironmentFileExample includes auth env placeholders", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    auth: {
      enabled: true,
      apiKeyEnv: "RAY_API_KEYS",
    },
  });

  const envFile = renderEnvironmentFileExample(config);
  assert.match(envFile, /RAY_API_KEYS=/);
});
