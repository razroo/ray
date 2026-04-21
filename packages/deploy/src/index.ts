import path from "node:path";
import { loadRayConfig } from "@ray/config";

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
${envFileLine}ExecStart=${nodeBinary} ${path.join(options.workingDirectory, "apps/gateway/dist/index.js")} --config ${absoluteConfigPath}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
}

export function renderCaddyfile(options: ReverseProxyOptions): string {
  return `${options.domain} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${options.upstreamPort}
}
`;
}

export async function renderDeploymentBundle(options: {
  cwd: string;
  configPath: string;
  user: string;
  domain: string;
  envFile?: string;
}): Promise<{
  service: string;
  caddyfile: string;
  summary: Record<string, unknown>;
}> {
  const loaded = await loadRayConfig({
    cwd: options.cwd,
    configPath: options.configPath,
  });

  return {
    service: renderSystemdService({
      workingDirectory: options.cwd,
      configPath: options.configPath,
      user: options.user,
      ...(options.envFile ? { envFile: options.envFile } : {}),
    }),
    caddyfile: renderCaddyfile({
      domain: options.domain,
      upstreamPort: loaded.config.server.port,
    }),
    summary: {
      profile: loaded.config.profile,
      model: loaded.config.model,
      server: loaded.config.server,
    },
  };
}
