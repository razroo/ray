import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir, totalmem } from "node:os";
import path from "node:path";
import { loadRayConfig, resolveAuthApiKeys } from "@ray/config";
import { toErrorMessage, type LlamaCppLaunchProfile, type RayConfig } from "@razroo/ray-core";

export interface SystemdServiceOptions {
  workingDirectory: string;
  configPath: string;
  user: string;
  envFile?: string;
  stateDirectory?: string;
  after?: string[];
  wants?: string[];
  nodeBinary?: string;
}

export interface ReverseProxyOptions {
  domain: string;
  upstreamPort: number;
  requestBodyLimitBytes: number;
  upstreamTimeoutMs: number;
}

export interface LlamaCppServiceOptions {
  user: string;
  envFile?: string;
  launchProfile: LlamaCppLaunchProfile;
}

export interface DeploymentDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

type MemoryBudgetSource = "override" | "preset" | "host";

export interface DeploymentPreflight {
  hostMemoryMiB?: number;
  memoryBudgetMiB?: number;
  memoryBudgetSource?: MemoryBudgetSource;
  modelFileBytes?: number;
  modelFilePath?: string;
  modelFileStatus?: "found" | "missing" | "unreadable";
  modelFileError?: string;
}

export interface LlamaCppMemoryEstimate {
  memoryBudgetMiB: number;
  memoryBudgetSource: MemoryBudgetSource;
  modelFileMiB: number;
  promptCacheMiB: number;
  kvCacheMiB: number;
  runtimeMiB: number;
  schedulerBufferMiB: number;
  reserveMiB: number;
  safeBudgetMiB: number;
  projectedWorkingSetMiB: number;
}

export interface DiagnoseConfigOptions {
  preflight?: DeploymentPreflight;
  strictFilesystem?: boolean;
}

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_CACHE_RAM_MIB = 8_192;
const RAY_RUNTIME_RESERVE_MIB = 192;
const LLAMA_CPP_RUNTIME_RESERVE_MIB = 160;
const MIN_SYSTEM_RESERVE_MIB = 768;
const SYSTEM_RESERVE_RATIO = 0.2;
const SCHEDULER_BYTES_PER_TOKEN = 768;
const TIGHT_MEMORY_RATIO = 0.9;
const LLAMA_CPP_SYSTEMD_SERVICE = "ray-llama-cpp.service";
const MAX_SYSTEMD_DEPENDENCY_UNITS = 32;
const MAX_SYSTEMD_DEPENDENCY_UNIT_CHARS = 256;
const MAX_LLAMA_CPP_EXTRA_ARGS = 64;
const MAX_LLAMA_CPP_EXTRA_ARG_CHARS = 4_096;
const CADDY_UPSTREAM_TIMEOUT_GRACE_MS = 5_000;
const CADDY_DIAL_TIMEOUT_MS = 5_000;
const CADDY_WRITE_TIMEOUT_MS = 10_000;
const MAX_CADDY_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const MAX_CADDY_UPSTREAM_TIMEOUT_MS = 120_000 + CADDY_UPSTREAM_TIMEOUT_GRACE_MS;

const llamaCppLaunchPresets = new Set<LlamaCppLaunchProfile["preset"]>([
  "single-vps-sub1b",
  "single-vps-sub1b-cx23",
  "single-vps-sub1b-cax11",
  "single-vps-1b-cx23",
  "single-vps-1b-8gb",
  "single-vps-balanced",
]);

function isSub1bPreset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return (
    preset === "single-vps-sub1b" ||
    preset === "single-vps-sub1b-cx23" ||
    preset === "single-vps-sub1b-cax11"
  );
}

function is1bPreset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return preset === "single-vps-1b-cx23" || preset === "single-vps-1b-8gb";
}

function isSmallVpsPreset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return isSub1bPreset(preset) || preset === "single-vps-1b-cx23";
}

function isCax11Preset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return preset === "single-vps-sub1b-cax11";
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTemporaryStoragePath(storageDir: string): boolean {
  const resolved = path.resolve(storageDir);
  return (
    isPathInside(path.resolve(tmpdir()), resolved) ||
    isPathInside("/tmp", resolved) ||
    isPathInside("/var/tmp", resolved)
  );
}

function isSystemdProtectHomePath(value: string): boolean {
  if (!path.isAbsolute(value)) {
    return false;
  }

  const resolved = path.resolve(value);
  return ["/home", "/root", "/run/user"].some((protectedPath) =>
    isPathInside(protectedPath, resolved),
  );
}

function isLoopbackHost(value: string): boolean {
  const host = normalizeHostLiteral(value);

  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }

  if (isIP(host) === 4) {
    const firstOctet = Number(host.split(".")[0]);
    return firstOctet === 127;
  }

  return false;
}

function normalizeHostLiteral(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function launchHostRequiresExactBaseUrlHost(value: string): boolean {
  return isIP(normalizeHostLiteral(value)) > 0;
}

function parseAdapterBaseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function getUrlPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function inferRayStateDirectory(config: RayConfig): string | undefined {
  if (!config.asyncQueue.enabled) {
    return undefined;
  }

  const storageDir = path.resolve(config.asyncQueue.storageDir);

  if (isPathInside("/var/lib/ray", storageDir)) {
    return "ray";
  }

  return undefined;
}

function escapeSystemdScalar(value: string | number): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

function assertOptionsObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertSystemdScalar(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} cannot contain control characters`);
  }
}

function assertOptionalSystemdText(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} cannot contain control characters`);
  }
}

function assertSystemdUser(value: unknown): asserts value is string {
  assertSystemdScalar(value, "user");

  if (!/^(?:[A-Za-z_][A-Za-z0-9_-]{0,30}|[0-9]{1,10})$/.test(value)) {
    throw new Error(
      "user must be a system account name or numeric UID using only letters, digits, underscores, or hyphens",
    );
  }
}

function assertSystemdStateDirectory(value: unknown): asserts value is string {
  assertSystemdScalar(value, "stateDirectory");

  if (
    path.isAbsolute(value) ||
    value
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
  ) {
    throw new Error(
      "stateDirectory must be a relative systemd state directory without whitespace or path traversal",
    );
  }
}

function assertOptionalSystemdDependencyArray(
  value: unknown,
  label: string,
): asserts value is string[] | undefined {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  if (value.length > MAX_SYSTEMD_DEPENDENCY_UNITS) {
    throw new Error(`${label} must contain at most ${MAX_SYSTEMD_DEPENDENCY_UNITS} entries`);
  }

  for (const [index, unit] of value.entries()) {
    if (typeof unit !== "string") {
      throw new Error(`${label}[${index}] must be a string`);
    }

    if (unit.length > MAX_SYSTEMD_DEPENDENCY_UNIT_CHARS) {
      throw new Error(
        `${label}[${index}] must be at most ${MAX_SYSTEMD_DEPENDENCY_UNIT_CHARS} characters`,
      );
    }
  }
}

function formatSystemdDirectiveValue(value: string, label: string): string {
  assertSystemdScalar(value, label);

  const escaped = escapeSystemdScalar(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped) ? escaped : `"${escaped}"`;
}

function formatSystemdEnvironmentLine(name: string, value: string | number): string {
  const escapedValue = escapeSystemdScalar(value);
  return `Environment="${name}=${escapedValue}"`;
}

function formatSystemdDependencyLine(name: "After" | "Wants", units: unknown): string {
  if (!Array.isArray(units)) {
    throw new Error(`${name} units must be an array of strings`);
  }

  const uniqueUnits = Array.from(
    new Set(
      units
        .map((unit, index) => {
          if (typeof unit !== "string") {
            throw new Error(`${name} unit at index ${index} must be a string`);
          }

          if (unit.length > MAX_SYSTEMD_DEPENDENCY_UNIT_CHARS) {
            throw new Error(
              `${name} unit at index ${index} must be at most ${MAX_SYSTEMD_DEPENDENCY_UNIT_CHARS} characters`,
            );
          }

          const trimmed = unit.trim();
          assertSystemdScalar(trimmed, `${name} unit`);
          if (/\s/.test(trimmed)) {
            throw new Error(`${name} unit cannot contain whitespace`);
          }
          return trimmed;
        })
        .filter((unit) => unit.length > 0),
    ),
  );
  return uniqueUnits.length > 0 ? `${name}=${uniqueUnits.join(" ")}\n` : "";
}

function formatSystemdExecArg(value: string): string {
  assertSystemdScalar(value, "ExecStart argument");
  const escaped = escapeSystemdScalar(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped) ? escaped : `"${escaped}"`;
}

function formatSystemdExecStart(args: string[]): string {
  return `ExecStart=${args.map((arg) => formatSystemdExecArg(arg)).join(" ")}`;
}

function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

function formatCaddySiteAddress(value: string): string {
  assertNonEmptyString(value, "Caddy site address");

  const address = value.trim();

  if (address.length === 0 || address !== value || /[\s{}]/.test(address)) {
    throw new Error("Caddy site address must be non-empty and cannot contain whitespace or braces");
  }

  return address;
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertIntegerAtLeast(
  value: unknown,
  minimum: number,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  }
}

function assertPositiveIntegerAtMost(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number {
  assertPositiveInteger(value, label);

  if (value > maximum) {
    throw new Error(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertTcpPort(value: unknown, label: string): asserts value is number {
  assertPositiveInteger(value, label);

  if (value > 65_535) {
    throw new Error(`${label} must be less than or equal to 65535`);
  }
}

function assertCaddyPort(value: unknown): asserts value is number {
  assertTcpPort(value, "upstreamPort");
}

function formatCaddyDurationMs(value: number, label: string): string {
  assertPositiveInteger(value, label);

  if (value % 1_000 === 0) {
    return `${value / 1_000}s`;
  }

  return `${value}ms`;
}

function isLlamaCppLaunchPreset(value: unknown): value is LlamaCppLaunchProfile["preset"] {
  return (
    typeof value === "string" && llamaCppLaunchPresets.has(value as LlamaCppLaunchProfile["preset"])
  );
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertOptionalSystemdStringArray(
  value: unknown,
  label: string,
  maxEntries: number,
  maxEntryChars: number,
): asserts value is string[] | undefined {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }

  if (value.length > maxEntries) {
    throw new Error(`${label} must contain at most ${maxEntries} entries`);
  }

  for (const [index, entry] of value.entries()) {
    if (entry.length > maxEntryChars) {
      throw new Error(`${label}[${index}] must be at most ${maxEntryChars} characters`);
    }
  }
}

function assertLlamaCppLaunchProfileForEnvironment(
  value: unknown,
): asserts value is LlamaCppLaunchProfile {
  assertOptionsObject(value, "model.adapter.launchProfile");

  if (!isLlamaCppLaunchPreset(value.preset)) {
    throw new Error("model.adapter.launchProfile.preset is not recognized");
  }

  assertSystemdScalar(value.modelPath, "model.adapter.launchProfile.modelPath");
  assertAbsolutePath(value.modelPath, "model.adapter.launchProfile.modelPath");
  assertSystemdScalar(value.host, "model.adapter.launchProfile.host");
  assertOptionalSystemdText(value.alias, "model.adapter.launchProfile.alias");
  assertTcpPort(value.port, "model.adapter.launchProfile.port");
  assertPositiveInteger(value.ctxSize, "model.adapter.launchProfile.ctxSize");
  assertPositiveInteger(value.parallel, "model.adapter.launchProfile.parallel");
  assertPositiveInteger(value.threads, "model.adapter.launchProfile.threads");
  assertPositiveInteger(value.threadsHttp, "model.adapter.launchProfile.threadsHttp");
  assertPositiveInteger(value.batchSize, "model.adapter.launchProfile.batchSize");
  assertPositiveInteger(value.ubatchSize, "model.adapter.launchProfile.ubatchSize");
  if (value.ubatchSize > value.batchSize) {
    throw new Error(
      "model.adapter.launchProfile.ubatchSize must be less than or equal to batchSize",
    );
  }

  assertNonNegativeInteger(value.cacheReuse, "model.adapter.launchProfile.cacheReuse");
  assertBoolean(value.cachePrompt, "model.adapter.launchProfile.cachePrompt");
  assertBoolean(value.continuousBatching, "model.adapter.launchProfile.continuousBatching");
  assertBoolean(value.enableMetrics, "model.adapter.launchProfile.enableMetrics");
  assertBoolean(value.exposeSlots, "model.adapter.launchProfile.exposeSlots");
  assertBoolean(value.warmup, "model.adapter.launchProfile.warmup");
  assertBoolean(value.enableUnifiedKv, "model.adapter.launchProfile.enableUnifiedKv");
  assertBoolean(value.cacheIdleSlots, "model.adapter.launchProfile.cacheIdleSlots");
  assertBoolean(value.contextShift, "model.adapter.launchProfile.contextShift");

  if (value.cacheRamMiB !== undefined) {
    assertIntegerAtLeast(value.cacheRamMiB, -1, "model.adapter.launchProfile.cacheRamMiB");
  }

  if (value.threadsBatch !== undefined) {
    assertPositiveInteger(value.threadsBatch, "model.adapter.launchProfile.threadsBatch");
  }
}

function assertLlamaCppLaunchProfileForService(
  value: unknown,
): asserts value is LlamaCppLaunchProfile {
  assertLlamaCppLaunchProfileForEnvironment(value);
  assertSystemdScalar(value.binaryPath, "model.adapter.launchProfile.binaryPath");
  assertAbsolutePath(value.binaryPath, "model.adapter.launchProfile.binaryPath");

  assertOptionalSystemdStringArray(
    value.extraArgs,
    "model.adapter.launchProfile.extraArgs",
    MAX_LLAMA_CPP_EXTRA_ARGS,
    MAX_LLAMA_CPP_EXTRA_ARG_CHARS,
  );
}

function boolToEnv(value: boolean): "1" | "0" {
  return value ? "1" : "0";
}

function bytesToMiBRoundedUp(value: number): number {
  return Math.ceil(value / BYTES_PER_MIB);
}

function formatMiB(value: number): string {
  return `${value.toLocaleString("en-US")} MiB`;
}

function getPresetMemoryBudgetMiB(preset: LlamaCppLaunchProfile["preset"]): number {
  return isSmallVpsPreset(preset) ? 4_096 : 8_192;
}

function estimateKvBytesPerToken(preset: LlamaCppLaunchProfile["preset"]): number {
  return isSub1bPreset(preset) ? 128 * 1_024 : is1bPreset(preset) ? 192 * 1_024 : 320 * 1_024;
}

function formatMemoryEstimateMessage(estimate: LlamaCppMemoryEstimate): string {
  return `Projected llama.cpp working set is about ${formatMiB(
    estimate.projectedWorkingSetMiB,
  )} against a safe budget of ${formatMiB(estimate.safeBudgetMiB)} on a ${formatMiB(
    estimate.memoryBudgetMiB,
  )} ${estimate.memoryBudgetSource} target. Components: model=${formatMiB(
    estimate.modelFileMiB,
  )}, cache-ram=${formatMiB(estimate.promptCacheMiB)}, kv=${formatMiB(
    estimate.kvCacheMiB,
  )}, runtime=${formatMiB(estimate.runtimeMiB)}, scheduler=${formatMiB(
    estimate.schedulerBufferMiB,
  )}, reserve=${formatMiB(estimate.reserveMiB)}.`;
}

function resolveMemoryBudget(options: {
  preset: LlamaCppLaunchProfile["preset"];
  overrideMemoryBudgetMiB?: number;
  hostMemoryMiB?: number;
}): { memoryBudgetMiB: number; memoryBudgetSource: MemoryBudgetSource } {
  if (options.overrideMemoryBudgetMiB !== undefined) {
    return {
      memoryBudgetMiB: options.overrideMemoryBudgetMiB,
      memoryBudgetSource: "override",
    };
  }

  const presetBudgetMiB = getPresetMemoryBudgetMiB(options.preset);
  const hostMemoryMiB = options.hostMemoryMiB;

  if (hostMemoryMiB !== undefined && hostMemoryMiB > 0) {
    if (hostMemoryMiB < presetBudgetMiB) {
      return {
        memoryBudgetMiB: hostMemoryMiB,
        memoryBudgetSource: "host",
      };
    }

    return {
      memoryBudgetMiB: presetBudgetMiB,
      memoryBudgetSource: "preset",
    };
  }

  return {
    memoryBudgetMiB: presetBudgetMiB,
    memoryBudgetSource: "preset",
  };
}

export function estimateLlamaCppMemoryFit(
  config: RayConfig,
  launchProfile: LlamaCppLaunchProfile,
  preflight: DeploymentPreflight,
): LlamaCppMemoryEstimate | undefined {
  if (
    preflight.memoryBudgetMiB === undefined ||
    preflight.memoryBudgetSource === undefined ||
    preflight.modelFileBytes === undefined
  ) {
    return undefined;
  }

  if (launchProfile.cacheRamMiB === -1) {
    return undefined;
  }

  const promptCacheMiB =
    launchProfile.cacheRamMiB === undefined
      ? DEFAULT_CACHE_RAM_MIB
      : Math.max(0, launchProfile.cacheRamMiB);
  const kvCacheMiB = bytesToMiBRoundedUp(
    launchProfile.ctxSize *
      Math.max(1, launchProfile.parallel) *
      estimateKvBytesPerToken(launchProfile.preset),
  );
  const schedulerBufferMiB = bytesToMiBRoundedUp(
    (config.scheduler.maxQueuedTokens + config.scheduler.maxInflightTokens) *
      SCHEDULER_BYTES_PER_TOKEN,
  );
  const runtimeMiB = RAY_RUNTIME_RESERVE_MIB + LLAMA_CPP_RUNTIME_RESERVE_MIB;
  const reserveMiB = Math.max(
    MIN_SYSTEM_RESERVE_MIB,
    Math.ceil(preflight.memoryBudgetMiB * SYSTEM_RESERVE_RATIO),
  );
  const safeBudgetMiB = Math.max(0, preflight.memoryBudgetMiB - reserveMiB);
  const modelFileMiB = bytesToMiBRoundedUp(preflight.modelFileBytes);
  const projectedWorkingSetMiB =
    modelFileMiB + promptCacheMiB + kvCacheMiB + runtimeMiB + schedulerBufferMiB;

  return {
    memoryBudgetMiB: preflight.memoryBudgetMiB,
    memoryBudgetSource: preflight.memoryBudgetSource,
    modelFileMiB,
    promptCacheMiB,
    kvCacheMiB,
    runtimeMiB,
    schedulerBufferMiB,
    reserveMiB,
    safeBudgetMiB,
    projectedWorkingSetMiB,
  };
}

export function buildLlamaCppEnvironment(profile: LlamaCppLaunchProfile): Record<string, string> {
  assertLlamaCppLaunchProfileForEnvironment(profile);

  return {
    LLAMA_ARG_MODEL: profile.modelPath,
    ...(profile.alias ? { LLAMA_ARG_ALIAS: profile.alias } : {}),
    LLAMA_ARG_HOST: profile.host,
    LLAMA_ARG_PORT: profile.port.toString(),
    LLAMA_ARG_CTX_SIZE: profile.ctxSize.toString(),
    LLAMA_ARG_N_PARALLEL: profile.parallel.toString(),
    LLAMA_ARG_THREADS: profile.threads.toString(),
    ...(profile.threadsBatch !== undefined
      ? { LLAMA_ARG_THREADS_BATCH: profile.threadsBatch.toString() }
      : {}),
    LLAMA_ARG_THREADS_HTTP: profile.threadsHttp.toString(),
    LLAMA_ARG_BATCH_SIZE: profile.batchSize.toString(),
    LLAMA_ARG_UBATCH_SIZE: profile.ubatchSize.toString(),
    LLAMA_ARG_CACHE_PROMPT: boolToEnv(profile.cachePrompt),
    LLAMA_ARG_CACHE_REUSE: profile.cacheReuse.toString(),
    ...(profile.cacheRamMiB !== undefined
      ? { LLAMA_ARG_CACHE_RAM: profile.cacheRamMiB.toString() }
      : {}),
    LLAMA_ARG_CONT_BATCHING: boolToEnv(profile.continuousBatching),
    LLAMA_ARG_ENDPOINT_METRICS: boolToEnv(profile.enableMetrics),
    LLAMA_ARG_ENDPOINT_SLOTS: boolToEnv(profile.exposeSlots),
    LLAMA_ARG_WARMUP: boolToEnv(profile.warmup),
    LLAMA_ARG_KV_UNIFIED: boolToEnv(profile.enableUnifiedKv),
    LLAMA_ARG_CACHE_IDLE_SLOTS: boolToEnv(profile.cacheIdleSlots),
    LLAMA_ARG_CONTEXT_SHIFT: boolToEnv(profile.contextShift),
  };
}

export function renderSystemdService(options: SystemdServiceOptions): string {
  assertOptionsObject(options, "Systemd service options");

  const after = options.after;
  const wants = options.wants;
  assertOptionalSystemdDependencyArray(after, "after");
  assertOptionalSystemdDependencyArray(wants, "wants");

  const nodeBinary = options.nodeBinary === undefined ? "/usr/bin/node" : options.nodeBinary;
  assertSystemdScalar(nodeBinary, "nodeBinary");
  assertSystemdScalar(options.workingDirectory, "workingDirectory");
  assertAbsolutePath(nodeBinary, "nodeBinary");
  assertAbsolutePath(options.workingDirectory, "workingDirectory");
  if (options.envFile !== undefined) {
    assertSystemdScalar(options.envFile, "envFile");
    assertAbsolutePath(options.envFile, "envFile");
  }

  assertSystemdUser(options.user);
  if (options.stateDirectory !== undefined) {
    assertSystemdStateDirectory(options.stateDirectory);
  }

  const envFileLine = options.envFile
    ? `EnvironmentFile=${formatSystemdDirectiveValue(options.envFile, "envFile")}\n`
    : "";
  const stateDirectoryLine = options.stateDirectory
    ? `StateDirectory=${formatSystemdDirectiveValue(options.stateDirectory, "stateDirectory")}\n`
    : "";
  const wantsLine = formatSystemdDependencyLine("Wants", wants ?? []);
  const afterLine = formatSystemdDependencyLine("After", ["network.target", ...(after ?? [])]);
  const absoluteConfigPath = path.resolve(options.workingDirectory, options.configPath);
  const gatewayEntryPoint = path.join(options.workingDirectory, "apps/gateway/dist/index.js");
  const execStart = formatSystemdExecStart([
    nodeBinary,
    gatewayEntryPoint,
    "--config",
    absoluteConfigPath,
  ]);

  return `[Unit]
Description=Ray Gateway
${wantsLine}${afterLine}StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=${options.user}
WorkingDirectory=${formatSystemdDirectiveValue(options.workingDirectory, "workingDirectory")}
${envFileLine}Environment=NODE_ENV=production
${execStart}
Restart=always
RestartSec=2
TimeoutStopSec=35
KillSignal=SIGTERM
KillMode=mixed
TasksMax=128
CPUAccounting=true
MemoryAccounting=true
IOAccounting=true
${stateDirectoryLine}NoNewPrivileges=true
CapabilityBoundingSet=
SystemCallArchitectures=native
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectClock=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=true
RestrictSUIDSGID=true
UMask=027
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

export function renderCaddyfile(options: ReverseProxyOptions): string {
  assertOptionsObject(options, "Caddyfile options");

  const domain = formatCaddySiteAddress(options.domain);
  assertCaddyPort(options.upstreamPort);
  assertPositiveIntegerAtMost(
    options.requestBodyLimitBytes,
    "requestBodyLimitBytes",
    MAX_CADDY_REQUEST_BODY_LIMIT_BYTES,
  );
  assertPositiveIntegerAtMost(
    options.upstreamTimeoutMs,
    "upstreamTimeoutMs",
    MAX_CADDY_UPSTREAM_TIMEOUT_MS,
  );
  const upstreamTimeout = formatCaddyDurationMs(options.upstreamTimeoutMs, "upstreamTimeoutMs");
  const dialTimeout = formatCaddyDurationMs(CADDY_DIAL_TIMEOUT_MS, "dialTimeoutMs");
  const writeTimeout = formatCaddyDurationMs(CADDY_WRITE_TIMEOUT_MS, "writeTimeoutMs");

  return `${domain} {
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
    health_uri /livez
    health_interval 15s
    transport http {
      dial_timeout ${dialTimeout}
      response_header_timeout ${upstreamTimeout}
      read_timeout ${upstreamTimeout}
      write_timeout ${writeTimeout}
    }
  }
}
`;
}

export function renderLlamaCppService(options: LlamaCppServiceOptions): string {
  assertOptionsObject(options, "llama.cpp service options");
  assertLlamaCppLaunchProfileForService(options.launchProfile);

  if (options.envFile !== undefined) {
    assertSystemdScalar(options.envFile, "envFile");
    assertAbsolutePath(options.envFile, "envFile");
  }
  assertSystemdUser(options.user);

  const envFileLine = options.envFile
    ? `EnvironmentFile=${formatSystemdDirectiveValue(options.envFile, "envFile")}\n`
    : "";
  const profile = options.launchProfile;

  const environmentLines = Object.entries(buildLlamaCppEnvironment(profile))
    .map(([name, value]) => formatSystemdEnvironmentLine(name, value))
    .map((line) => `${line}\n`)
    .join("");
  const execStart = formatSystemdExecStart([profile.binaryPath, ...(profile.extraArgs ?? [])]);

  return `[Unit]
Description=llama.cpp Server for Ray
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=${options.user}
${envFileLine}${environmentLines}${execStart}
Restart=always
RestartSec=2
TimeoutStopSec=35
KillSignal=SIGTERM
KillMode=mixed
TasksMax=256
CPUAccounting=true
MemoryAccounting=true
IOAccounting=true
NoNewPrivileges=true
CapabilityBoundingSet=
SystemCallArchitectures=native
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectClock=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=true
RestrictSUIDSGID=true
UMask=027
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

export function renderEnvironmentFileExample(config: RayConfig): string {
  const lines = ["# Ray environment variables"];

  if (config.auth.apiKeyEnv) {
    lines.push(`${config.auth.apiKeyEnv}=replace-with-comma-separated-client-api-keys`);
  }

  if (
    (config.model.adapter.kind === "openai-compatible" ||
      config.model.adapter.kind === "llama.cpp") &&
    config.model.adapter.apiKeyEnv
  ) {
    lines.push(`${config.model.adapter.apiKeyEnv}=replace-with-upstream-api-key`);
  }

  if (config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile) {
    lines.push(
      "# llama.cpp launch profile is rendered directly into the generated systemd service.",
    );
    lines.push("# Optional portable 1B/model overrides:");
    lines.push(`# RAY_MODEL_ID=${config.model.id}`);
    lines.push(`# RAY_MODEL_REF=${config.model.adapter.modelRef}`);
    lines.push(`# RAY_MODEL_PATH=${config.model.adapter.launchProfile.modelPath}`);
    lines.push(`# RAY_MODEL_FAMILY=${config.model.family}`);
    lines.push(`# RAY_MODEL_QUANTIZATION=${config.model.quantization}`);
    lines.push(`# RAY_LLAMA_CPP_BINARY_PATH=${config.model.adapter.launchProfile.binaryPath}`);
    lines.push(`# RAY_LLAMA_CPP_CTX_SIZE=${config.model.adapter.launchProfile.ctxSize}`);
    lines.push(`# RAY_LLAMA_CPP_PARALLEL=${config.model.adapter.launchProfile.parallel}`);
    lines.push(`# RAY_LLAMA_CPP_THREADS=${config.model.adapter.launchProfile.threads}`);
    lines.push(
      `# RAY_LLAMA_CPP_CACHE_RAM_MIB=${config.model.adapter.launchProfile.cacheRamMiB ?? ""}`,
    );
    lines.push(`# RAY_SCHEDULER_CONCURRENCY=${config.scheduler.concurrency}`);
    lines.push(`# RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=${config.scheduler.maxInflightTokens}`);
    lines.push(
      `# RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=${config.gracefulDegradation.memoryRssThresholdMiB}`,
    );
  }

  if (config.asyncQueue.enabled) {
    lines.push("# Optional async durable queue overrides:");
    lines.push(`# RAY_ASYNC_QUEUE_STORAGE_DIR=${config.asyncQueue.storageDir}`);
    lines.push(`# RAY_ASYNC_QUEUE_MAX_JOBS=${config.asyncQueue.maxJobs}`);
    lines.push(`# RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=${config.asyncQueue.completedTtlMs}`);
  }

  if (lines.length === 1) {
    lines.push("# No environment variables are required for this profile.");
  }

  return `${lines.join("\n")}\n`;
}

export function diagnoseConfig(
  config: RayConfig,
  env: NodeJS.ProcessEnv,
  envFile?: string,
  options: DiagnoseConfigOptions = {},
): DeploymentDiagnostic[] {
  const diagnostics: DeploymentDiagnostic[] = [];
  const strictFilesystem = options.strictFilesystem === true;
  const preflight = options.preflight;

  if (
    config.server.host !== "127.0.0.1" &&
    config.server.host !== "::1" &&
    config.server.host !== "localhost"
  ) {
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
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "auth_keys_missing",
        message: `Auth key configuration is invalid: ${toErrorMessage(error)}`,
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

  if (!isLoopbackHost(config.server.host)) {
    diagnostics.push({
      level: "error",
      code: "gateway_bind_host_public",
      message:
        "server.host is not loopback. Generated VPS deployments should bind the Ray gateway to 127.0.0.1 or localhost and expose it only through Caddy.",
    });
  }

  if (envFile && !path.isAbsolute(envFile)) {
    diagnostics.push({
      level: "error",
      code: "env_file_relative",
      message:
        "EnvironmentFile paths rendered into systemd units must be absolute. Pass an absolute --ray-env-file path or resolve it against --cwd before rendering.",
    });
  }

  if (!config.rateLimit.enabled) {
    diagnostics.push({
      level: "warn",
      code: "rate_limit_disabled",
      message:
        "Inference rate limiting is disabled. Public endpoints should have a bounded request budget.",
    });
  }

  if (config.asyncQueue.enabled) {
    if (!path.isAbsolute(config.asyncQueue.storageDir)) {
      diagnostics.push({
        level: "warn",
        code: "async_queue_storage_relative",
        message:
          "asyncQueue.storageDir is relative. Durable VPS queues should use an explicit persistent path such as /var/lib/ray/async-queue.",
      });
    }

    if (isTemporaryStoragePath(config.asyncQueue.storageDir)) {
      diagnostics.push({
        level: "warn",
        code: "async_queue_storage_volatile",
        message:
          "asyncQueue.storageDir points at temporary storage. Use persistent local storage such as /var/lib/ray/async-queue so queued work survives restarts.",
      });
    }

    if (isSystemdProtectHomePath(config.asyncQueue.storageDir)) {
      diagnostics.push({
        level: "error",
        code: "async_queue_storage_home_protected",
        message:
          "asyncQueue.storageDir is under /home, /root, or /run/user, but the generated gateway service uses ProtectHome=true. Use a service-readable path such as /var/lib/ray/async-queue.",
      });
    }
  }

  if (
    config.model.adapter.kind === "openai-compatible" ||
    config.model.adapter.kind === "llama.cpp"
  ) {
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

  if (config.model.adapter.kind === "llama.cpp") {
    const launchProfile = config.model.adapter.launchProfile;
    if (!launchProfile) {
      diagnostics.push({
        level: "warn",
        code: "llama_launch_profile_missing",
        message:
          "No llama.cpp launchProfile is defined. Single-VPS deployments are easier to reproduce when Ray renders the backend service too.",
      });
    } else {
      const perSlotContext = Math.floor(
        launchProfile.ctxSize / Math.max(1, launchProfile.parallel),
      );

      if (!isLoopbackHost(launchProfile.host)) {
        diagnostics.push({
          level: "error",
          code: "llama_launch_host_public",
          message:
            "model.adapter.launchProfile.host is not loopback. Generated llama.cpp services should bind to 127.0.0.1 or localhost so Ray remains the public inference surface.",
        });
      }

      const adapterBaseUrl = parseAdapterBaseUrl(config.model.adapter.baseUrl);
      if (!adapterBaseUrl) {
        diagnostics.push({
          level: "error",
          code: "llama_base_url_invalid",
          message:
            "model.adapter.baseUrl must be an absolute HTTP URL when Ray renders a local llama.cpp service.",
        });
      } else {
        if (adapterBaseUrl.protocol !== "http:") {
          diagnostics.push({
            level: "error",
            code: "llama_base_url_scheme_mismatch",
            message:
              "model.adapter.baseUrl must use plain HTTP when Ray renders the local llama.cpp service; the generated backend unit does not terminate TLS.",
          });
        }

        if (!isLoopbackHost(adapterBaseUrl.hostname)) {
          diagnostics.push({
            level: "error",
            code: "llama_base_url_public",
            message:
              "model.adapter.baseUrl is not loopback while a local llama.cpp launchProfile is configured. Point Ray at the generated local backend instead of a public backend.",
          });
        }

        if (
          launchHostRequiresExactBaseUrlHost(launchProfile.host) &&
          normalizeHostLiteral(adapterBaseUrl.hostname) !== normalizeHostLiteral(launchProfile.host)
        ) {
          diagnostics.push({
            level: "error",
            code: "llama_base_url_host_mismatch",
            message:
              "model.adapter.baseUrl host does not match the literal IP in model.adapter.launchProfile.host. Ray would connect to a different loopback address than the generated llama.cpp service binds.",
          });
        }

        if (getUrlPort(adapterBaseUrl) !== launchProfile.port) {
          diagnostics.push({
            level: "error",
            code: "llama_base_url_launch_mismatch",
            message:
              "model.adapter.baseUrl port does not match model.adapter.launchProfile.port. Ray would send traffic to a different backend than the generated llama.cpp service.",
          });
        }

        if (adapterBaseUrl.pathname !== "/" || adapterBaseUrl.search || adapterBaseUrl.hash) {
          diagnostics.push({
            level: "error",
            code: "llama_base_url_path_mismatch",
            message:
              "model.adapter.baseUrl must point at the generated llama.cpp service root without a path, query, or fragment.",
          });
        }
      }

      if (!path.isAbsolute(launchProfile.binaryPath)) {
        diagnostics.push({
          level: "error",
          code: "llama_binary_path_relative",
          message:
            "model.adapter.launchProfile.binaryPath must be an absolute path so the generated systemd service can start llama.cpp reliably.",
        });
      }

      if (isSystemdProtectHomePath(launchProfile.binaryPath)) {
        diagnostics.push({
          level: "error",
          code: "llama_binary_path_home_protected",
          message:
            "model.adapter.launchProfile.binaryPath is under /home, /root, or /run/user, but the generated llama.cpp service uses ProtectHome=true. Install llama-server somewhere service-readable such as /usr/local/bin/llama-server.",
        });
      }

      if (!path.isAbsolute(launchProfile.modelPath)) {
        diagnostics.push({
          level: "error",
          code: "llama_model_path_relative",
          message:
            "model.adapter.launchProfile.modelPath must be an absolute path so the generated llama.cpp service can find the GGUF file.",
        });
      }

      if (isSystemdProtectHomePath(launchProfile.modelPath)) {
        diagnostics.push({
          level: "error",
          code: "llama_model_path_home_protected",
          message:
            "model.adapter.launchProfile.modelPath is under /home, /root, or /run/user, but the generated llama.cpp service uses ProtectHome=true. Store GGUF files somewhere service-readable such as /var/lib/ray/models.",
        });
      }

      if (!launchProfile.cachePrompt) {
        diagnostics.push({
          level: "warn",
          code: "cache_prompt_disabled",
          message: "llama.cpp cachePrompt is disabled. Prompt reuse and TTFT will be worse.",
        });
      }

      if (launchProfile.cacheRamMiB === undefined) {
        diagnostics.push({
          level: "warn",
          code: "cache_ram_implicit",
          message:
            "llama.cpp cacheRamMiB is not pinned. The upstream cache-ram default is much larger than a 4 GB VPS target, so Ray should set an explicit budget.",
        });
      } else {
        if (launchProfile.cacheRamMiB === -1) {
          diagnostics.push({
            level: "warn",
            code: "cache_ram_unbounded",
            message:
              "llama.cpp cacheRamMiB is unlimited. Cheap VPS deployments should bound prompt cache RAM explicitly.",
          });
        }

        if (launchProfile.cacheRamMiB === 0 && launchProfile.cacheIdleSlots) {
          diagnostics.push({
            level: "warn",
            code: "cache_idle_slots_without_cache_ram",
            message:
              "cacheIdleSlots is enabled but cacheRamMiB is 0. llama.cpp idle-slot caching needs cache RAM to be enabled.",
          });
        }

        if (isSmallVpsPreset(launchProfile.preset) && launchProfile.cacheRamMiB > 1024) {
          diagnostics.push({
            level: "warn",
            code: "cache_ram_high_for_small_vps",
            message:
              "cacheRamMiB is high for a 4 GB VPS target. Sub-1B single-node profiles should keep prompt cache RAM tightly bounded.",
          });
        }
      }

      if (launchProfile.cacheIdleSlots && !launchProfile.enableUnifiedKv) {
        diagnostics.push({
          level: "warn",
          code: "cache_idle_slots_without_unified_kv",
          message:
            "cacheIdleSlots is enabled without unified KV. llama.cpp idle-slot caching expects unified KV to stay on.",
        });
      }

      if (!launchProfile.enableMetrics || !launchProfile.exposeSlots) {
        diagnostics.push({
          level: "warn",
          code: "llama_endpoints_disabled",
          message:
            "llama.cpp metrics and slots endpoints should stay enabled so Ray can route work by slot and benchmark accurately.",
        });
      }

      if (config.scheduler.concurrency > launchProfile.parallel) {
        diagnostics.push({
          level: "warn",
          code: "scheduler_exceeds_parallel",
          message:
            "scheduler.concurrency is higher than llama.cpp parallel slots. Extra queued work will increase tail latency without increasing true concurrency.",
        });
      }

      if (perSlotContext >= 4096) {
        diagnostics.push({
          level: "warn",
          code: "ctx_per_slot_high",
          message:
            "The effective ctx-size per slot is high for a small-model VPS profile. Reducing ctx-size often improves throughput on 2 vCPU nodes.",
        });
      }

      if (isCax11Preset(launchProfile.preset) && launchProfile.parallel > 1) {
        diagnostics.push({
          level: "warn",
          code: "cax11_parallel_high",
          message:
            "The CAX11-class ARM preset is tuned for one active slot. Raising parallel above 1 usually hurts latency before it helps throughput on 2 vCPU ARM nodes.",
        });
      }

      if (perSlotContext < config.model.maxOutputTokens * 2) {
        diagnostics.push({
          level: "warn",
          code: "ctx_per_slot_tight",
          message:
            "The effective ctx-size per slot is close to the configured output budget. Longer prompts may be rejected or truncated sooner than expected.",
        });
      }

      if (strictFilesystem && preflight?.modelFileStatus === "missing") {
        diagnostics.push({
          level: "error",
          code: "model_file_missing",
          message: `The configured GGUF model file was not found at ${preflight.modelFilePath}. Doctor cannot estimate memory fit without the real model file.`,
        });
      } else if (strictFilesystem && preflight?.modelFileStatus === "unreadable") {
        diagnostics.push({
          level: "error",
          code: "model_file_unreadable",
          message: `The configured GGUF model file at ${preflight.modelFilePath} could not be read${preflight.modelFileError ? ` (${preflight.modelFileError})` : ""}. Doctor cannot estimate memory fit without the real model file.`,
        });
      }

      if (launchProfile.cacheRamMiB === -1 && preflight?.memoryBudgetMiB !== undefined) {
        diagnostics.push({
          level: "error",
          code: "memory_fit_unbounded",
          message:
            "cacheRamMiB is unlimited, so Ray cannot guarantee that the llama.cpp working set will fit within the target memory budget.",
        });
      }

      const memoryEstimate = estimateLlamaCppMemoryFit(config, launchProfile, preflight ?? {});
      if (memoryEstimate) {
        const message = formatMemoryEstimateMessage(memoryEstimate);

        if (memoryEstimate.projectedWorkingSetMiB > memoryEstimate.safeBudgetMiB) {
          diagnostics.push({
            level: "error",
            code: "memory_fit_exceeded",
            message,
          });
        } else if (
          memoryEstimate.projectedWorkingSetMiB >
          Math.floor(memoryEstimate.safeBudgetMiB * TIGHT_MEMORY_RATIO)
        ) {
          diagnostics.push({
            level: "warn",
            code: "memory_fit_tight",
            message,
          });
        } else {
          diagnostics.push({
            level: "info",
            code: "memory_fit_ok",
            message,
          });
        }
      }
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
  memoryBudgetMiB?: number;
  strictFilesystem?: boolean;
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
  const preflight = await collectDeploymentPreflight(loaded.config, {
    ...(options.memoryBudgetMiB !== undefined ? { memoryBudgetMiB: options.memoryBudgetMiB } : {}),
    ...(options.strictFilesystem !== undefined
      ? { strictFilesystem: options.strictFilesystem }
      : {}),
  });

  return {
    config: loaded.config,
    diagnostics: diagnoseConfig(loaded.config, options.env ?? process.env, options.envFile, {
      preflight,
      ...(options.strictFilesystem !== undefined
        ? { strictFilesystem: options.strictFilesystem }
        : {}),
    }),
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
  memoryBudgetMiB?: number;
  nodeBinary?: string;
}): Promise<{
  service: string;
  caddyfile: string;
  envFileExample: string;
  llamaCppService?: string;
  summary: Record<string, unknown>;
}> {
  const cwd = path.resolve(options.cwd);
  const envFile = options.envFile ? path.resolve(cwd, options.envFile) : undefined;
  const inspected = await loadAndDiagnoseDeployment({
    ...options,
    cwd,
    ...(envFile ? { envFile } : {}),
  });
  const stateDirectory = inferRayStateDirectory(inspected.config);
  const rendersLlamaCppService =
    inspected.config.model.adapter.kind === "llama.cpp" &&
    inspected.config.model.adapter.launchProfile !== undefined;

  return {
    service: renderSystemdService({
      workingDirectory: cwd,
      configPath: options.configPath,
      user: options.user,
      ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
      ...(envFile ? { envFile } : {}),
      ...(stateDirectory ? { stateDirectory } : {}),
      ...(rendersLlamaCppService
        ? {
            after: [LLAMA_CPP_SYSTEMD_SERVICE],
            wants: [LLAMA_CPP_SYSTEMD_SERVICE],
          }
        : {}),
    }),
    caddyfile: renderCaddyfile({
      domain: options.domain,
      upstreamPort: inspected.config.server.port,
      requestBodyLimitBytes: inspected.config.server.requestBodyLimitBytes,
      upstreamTimeoutMs:
        inspected.config.scheduler.requestTimeoutMs + CADDY_UPSTREAM_TIMEOUT_GRACE_MS,
    }),
    envFileExample: renderEnvironmentFileExample(inspected.config),
    ...(inspected.config.model.adapter.kind === "llama.cpp" &&
    inspected.config.model.adapter.launchProfile
      ? {
          llamaCppService: renderLlamaCppService({
            user: options.user,
            launchProfile: inspected.config.model.adapter.launchProfile,
          }),
        }
      : {}),
    summary: {
      profile: inspected.config.profile,
      model: inspected.config.model,
      server: inspected.config.server,
      diagnostics: inspected.diagnostics,
    },
  };
}

async function collectDeploymentPreflight(
  config: RayConfig,
  options: {
    memoryBudgetMiB?: number;
    strictFilesystem?: boolean;
  },
): Promise<DeploymentPreflight> {
  const hostMemoryMiB = Math.max(1, Math.floor(totalmem() / BYTES_PER_MIB));

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    return {
      hostMemoryMiB,
    };
  }

  const launchProfile = config.model.adapter.launchProfile;
  const budget = resolveMemoryBudget({
    preset: launchProfile.preset,
    ...(options.memoryBudgetMiB !== undefined
      ? { overrideMemoryBudgetMiB: options.memoryBudgetMiB }
      : {}),
    hostMemoryMiB,
  });
  const preflight: DeploymentPreflight = {
    hostMemoryMiB,
    memoryBudgetMiB: budget.memoryBudgetMiB,
    memoryBudgetSource: budget.memoryBudgetSource,
    modelFilePath: launchProfile.modelPath,
  };

  try {
    const fileStat = await stat(launchProfile.modelPath);
    if (!fileStat.isFile()) {
      return {
        ...preflight,
        modelFileStatus: "unreadable",
        modelFileError: "not a regular file",
      };
    }

    return {
      ...preflight,
      modelFileBytes: fileStat.size,
      modelFileStatus: "found",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissing =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";

    if (!options.strictFilesystem) {
      return preflight;
    }

    return {
      ...preflight,
      modelFileStatus: isMissing ? "missing" : "unreadable",
      modelFileError: message,
    };
  }
}
