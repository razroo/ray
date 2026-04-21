import path from "node:path";
import { loadRayConfig, resolveAuthApiKeys } from "@ray/config";
import { type RayConfig } from "@ray/core";

export interface SystemdServiceOptions {
  workingDirectory: string;
  configPath: string;
  user: string;
  envFile?: string;
  nodeBinary?: string;
}

export interface ReverseProxyOptions {
  domain: string;
  upstreamPort: number;
  requestBodyLimitBytes: number;
}

export interface DeploymentDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export function renderSystemdService(options: SystemdServiceOptions): string {
  const nodeBinary = options.nodeBinary ?? "/usr/bin/node";
  const envFileLine = options.envFile ? `EnvironmentFile=${options.envFile}\n` : "";
  const absoluteConfigPath = path.resolve(options.workingDirectory, options.configPath);

  return `[Unit]
Description=Ray Gateway
After=network.target

[Service]
Type=simple
User=${options.user}
WorkingDirectory=${options.workingDirectory}
${envFileLine}Environment=NODE_ENV=production
ExecStart=${nodeBinary} ${path.join(options.workingDirectory, "apps/gateway/dist/index.js")} --config ${absoluteConfigPath}
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectControlGroups=true
ProtectKernelTunables=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictSUIDSGID=true
UMask=027
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

export function renderCaddyfile(options: ReverseProxyOptions): string {
  return `${options.domain} {
  encode zstd gzip
  request_body {
    max_size ${options.requestBodyLimitBytes}
  }
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    -Server
  }
  reverse_proxy 127.0.0.1:${options.upstreamPort} {
    health_uri /health
    health_interval 15s
  }
}
`;
}

export function renderEnvironmentFileExample(config: RayConfig): string {
  const lines = ["# Ray environment variables"];

  if (config.auth.apiKeyEnv) {
    lines.push(`${config.auth.apiKeyEnv}=replace-with-comma-separated-client-api-keys`);
  }

  if (config.model.adapter.kind === "openai-compatible" && config.model.adapter.apiKeyEnv) {
    lines.push(`${config.model.adapter.apiKeyEnv}=replace-with-upstream-api-key`);
  }

  if (lines.length === 1) {
    lines.push("# No environment variables are required for this profile.");
  }

  return `${lines.join("\n")}\n`;
}

export function diagnoseConfig(config: RayConfig, env: NodeJS.ProcessEnv, envFile?: string): DeploymentDiagnostic[] {
  const diagnostics: DeploymentDiagnostic[] = [];

  if (config.server.host !== "127.0.0.1" && config.server.host !== "::1" && config.server.host !== "localhost") {
    diagnostics.push({
      level: "warn",
      code: "public_bind_address",
      message: "server.host is not loopback. The gateway is safer behind a local reverse proxy.",
    });
  }

  if (!config.auth.enabled) {
    diagnostics.push({
      level: "warn",
      code: "auth_disabled",
      message: "Inference auth is disabled. Public deployments should require Bearer API keys.",
    });
  } else {
    try {
      resolveAuthApiKeys(config, env);
    } catch {
      diagnostics.push({
        level: "error",
        code: "auth_keys_missing",
        message: `Auth is enabled but ${config.auth.apiKeyEnv} is not populated with API keys.`,
      });
    }

    if (!envFile) {
      diagnostics.push({
        level: "warn",
        code: "env_file_missing",
        message: "Auth is enabled but no EnvironmentFile was supplied for the systemd unit.",
      });
    }
  }

  if (!config.rateLimit.enabled) {
    diagnostics.push({
      level: "warn",
      code: "rate_limit_disabled",
      message: "Inference rate limiting is disabled. Public endpoints should have a bounded request budget.",
    });
  }

  if (config.model.adapter.kind === "openai-compatible") {
    if (config.scheduler.requestTimeoutMs <= config.model.adapter.timeoutMs) {
      diagnostics.push({
        level: "warn",
        code: "timeout_budget_tight",
        message:
          "scheduler.requestTimeoutMs should exceed model.adapter.timeoutMs so gateway-level timeouts do not mask provider timeouts.",
      });
    }

    if (!config.model.warmOnBoot) {
      diagnostics.push({
        level: "warn",
        code: "warmup_disabled",
        message: "warmOnBoot is disabled. Cold starts on local backends will be less predictable.",
      });
    }
  }

  if (diagnostics.length === 0) {
    diagnostics.push({
      level: "info",
      code: "config_ok",
      message: "No deployment issues were detected for the current config.",
    });
  }

  return diagnostics;
}

export async function loadAndDiagnoseDeployment(options: {
  cwd: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
}): Promise<{
  config: RayConfig;
  configPath?: string;
  diagnostics: DeploymentDiagnostic[];
}> {
  const loaded = await loadRayConfig({
    cwd: options.cwd,
    configPath: options.configPath,
    ...(options.env ? { env: options.env } : {}),
  });

  return {
    config: loaded.config,
    diagnostics: diagnoseConfig(loaded.config, options.env ?? process.env, options.envFile),
    ...(loaded.configPath ? { configPath: loaded.configPath } : {}),
  };
}

export async function renderDeploymentBundle(options: {
  cwd: string;
  configPath: string;
  user: string;
  domain: string;
  envFile?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  service: string;
  caddyfile: string;
  envFileExample: string;
  summary: Record<string, unknown>;
}> {
  const inspected = await loadAndDiagnoseDeployment(options);

  return {
    service: renderSystemdService({
      workingDirectory: options.cwd,
      configPath: options.configPath,
      user: options.user,
      ...(options.envFile ? { envFile: options.envFile } : {}),
    }),
    caddyfile: renderCaddyfile({
      domain: options.domain,
      upstreamPort: inspected.config.server.port,
      requestBodyLimitBytes: inspected.config.server.requestBodyLimitBytes,
    }),
    envFileExample: renderEnvironmentFileExample(inspected.config),
    summary: {
      profile: inspected.config.profile,
      model: inspected.config.model,
      server: inspected.config.server,
      diagnostics: inspected.diagnostics,
    },
  };
}
