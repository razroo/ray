import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, mkdtemp, open, rm, stat, statfs, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { loadRayConfig, resolveAuthApiKeys, sanitizeConfig } from "@ray/config";
import {
  getLlamaCppLaunchProfileExtraArgOverride,
  toErrorMessage,
  type LlamaCppLaunchProfile,
  type RayConfig,
} from "@razroo/ray-core";

export interface SystemdServiceOptions {
  workingDirectory: string;
  configPath: string;
  user: string;
  envFile?: string;
  stateDirectory?: string;
  after?: string[];
  wants?: string[];
  runtimeBinary?: string;
  nodeBinary?: string;
  memoryHighMiB?: number;
  memoryMaxMiB?: number;
  memorySwapMaxMiB?: number;
  cpuWeight?: number;
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
  memoryHighMiB?: number;
  memoryMaxMiB?: number;
  memorySwapMaxMiB?: number;
  cpuWeight?: number;
}

export interface DeploymentDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export interface SystemdMemoryControls {
  memoryHighMiB: number;
  memoryMaxMiB: number;
  memorySwapMaxMiB: number;
}

export interface SystemdResourceControls extends SystemdMemoryControls {
  cpuWeight: number;
}

export interface DeploymentBundleSummary {
  profile: RayConfig["profile"];
  model: RayConfig["model"];
  server: RayConfig["server"];
  diagnostics: DeploymentDiagnostic[];
  preflight: DeploymentPreflight;
  systemd: {
    gateway: SystemdResourceControls;
    llamaCpp?: SystemdResourceControls;
  };
}

type MemoryBudgetSource = "override" | "preset" | "host";
type ModelFileFormatStatus = "valid" | "invalid" | "unreadable";
type AsyncQueueStorageStatus = "directory" | "parent" | "not_directory" | "unreadable";
type BinaryPreflightStatus = "found" | "missing" | "unreadable";
type GatewayRuntimeKind = "bun" | "node";
type GatewayRuntimeBinaryStatus = BinaryPreflightStatus;
type GatewayRuntimeVersionStatus = "ok" | "too_old" | "unreadable";
type CaddyRuntimeStatus = "available" | "missing" | "unreadable";
type CaddyConfigStatus = "valid" | "invalid" | "unreadable";
type LlamaCppBinaryStatus = BinaryPreflightStatus;
type LlamaCppBinaryProbeStatus = "ok" | "failed";
type GatewayEntrypointStatus = BinaryPreflightStatus;
type ConfigFileStatus = BinaryPreflightStatus;
type WorkingDirectoryStatus = "found" | "missing" | "not_directory" | "unreadable";
type WorkingDirectoryStorageStatus = "available" | "unreadable";
type EnvFileStatus = "found" | "missing" | "unreadable";
type ServiceUserStatus = "found" | "missing" | "unreadable";
type ServiceUserAccessStatus = "ok" | "blocked";
type SystemdHostStatus = "available" | "missing" | "unreadable";
type SystemdUnitStatus = "valid" | "invalid" | "unreadable";
type SwapStatus = "available" | "missing" | "unreadable";
type SwappinessStatus = "available" | "unreadable";

export interface DeploymentPreflight {
  hostMemoryMiB?: number;
  hostCpuCount?: number;
  hostArchitecture?: string;
  caddySiteAddress?: string;
  memoryBudgetMiB?: number;
  memoryBudgetSource?: MemoryBudgetSource;
  modelFileBytes?: number;
  modelFilePath?: string;
  modelFileStatus?: "found" | "missing" | "unreadable";
  modelFileError?: string;
  modelFileFormatStatus?: ModelFileFormatStatus;
  modelFileFormatError?: string;
  modelFileAccessStatus?: ServiceUserAccessStatus;
  modelFileAccessError?: string;
  asyncQueueStoragePath?: string;
  asyncQueueStorageCheckPath?: string;
  asyncQueueStorageStatus?: AsyncQueueStorageStatus;
  asyncQueueStorageAvailableMiB?: number;
  asyncQueueStorageError?: string;
  asyncQueueStorageAccessStatus?: ServiceUserAccessStatus;
  asyncQueueStorageAccessError?: string;
  asyncQueueStorageManagedByStateDirectory?: boolean;
  gatewayRuntimeBinaryPath?: string;
  gatewayRuntimeBinaryStatus?: GatewayRuntimeBinaryStatus;
  gatewayRuntimeBinaryError?: string;
  gatewayRuntimeBinaryAccessStatus?: ServiceUserAccessStatus;
  gatewayRuntimeBinaryAccessError?: string;
  gatewayRuntimeKind?: GatewayRuntimeKind;
  gatewayRuntimeVersion?: string;
  gatewayRuntimeVersionStatus?: GatewayRuntimeVersionStatus;
  gatewayRuntimeVersionError?: string;
  caddyStatus?: CaddyRuntimeStatus;
  caddyBinaryPath?: string;
  caddyVersion?: string;
  caddyError?: string;
  caddyConfigStatus?: CaddyConfigStatus;
  caddyConfigError?: string;
  gatewayEntrypointPath?: string;
  gatewayEntrypointStatus?: GatewayEntrypointStatus;
  gatewayEntrypointError?: string;
  gatewayEntrypointAccessStatus?: ServiceUserAccessStatus;
  gatewayEntrypointAccessError?: string;
  configFilePath?: string;
  configFileStatus?: ConfigFileStatus;
  configFileError?: string;
  configFileAccessStatus?: ServiceUserAccessStatus;
  configFileAccessError?: string;
  workingDirectoryPath?: string;
  workingDirectoryStatus?: WorkingDirectoryStatus;
  workingDirectoryError?: string;
  workingDirectoryAccessStatus?: ServiceUserAccessStatus;
  workingDirectoryAccessError?: string;
  workingDirectoryStorageStatus?: WorkingDirectoryStorageStatus;
  workingDirectoryAvailableMiB?: number;
  workingDirectoryStorageError?: string;
  llamaCppBinaryPath?: string;
  llamaCppBinaryStatus?: LlamaCppBinaryStatus;
  llamaCppBinaryError?: string;
  llamaCppBinaryProbeStatus?: LlamaCppBinaryProbeStatus;
  llamaCppBinaryProbeError?: string;
  llamaCppBinaryAccessStatus?: ServiceUserAccessStatus;
  llamaCppBinaryAccessError?: string;
  envFilePath?: string;
  envFileStatus?: EnvFileStatus;
  envFileMode?: number;
  envFileError?: string;
  serviceUser?: string;
  serviceUserStatus?: ServiceUserStatus;
  serviceUserUid?: number;
  serviceUserGid?: number;
  serviceUserPrimaryGroup?: string;
  serviceUserGroupIds?: number[];
  serviceUserError?: string;
  systemdStatus?: SystemdHostStatus;
  systemdVersion?: string;
  systemdError?: string;
  systemdUnitStatus?: SystemdUnitStatus;
  systemdUnitError?: string;
  swapStatus?: SwapStatus;
  swapTotalMiB?: number;
  swapError?: string;
  swappinessStatus?: SwappinessStatus;
  swappiness?: number;
  swappinessError?: string;
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
  allowMissingAuthKeys?: boolean;
}

export interface DeploymentHostFilePaths {
  passwd?: string;
  group?: string;
  meminfo?: string;
  swappiness?: string;
}

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_CACHE_RAM_MIB = 8_192;
const RAY_RUNTIME_RESERVE_MIB = 192;
const LLAMA_CPP_RUNTIME_RESERVE_MIB = 160;
const GGUF_MAGIC = "GGUF";
const MIN_SYSTEM_RESERVE_MIB = 768;
const SYSTEM_RESERVE_RATIO = 0.2;
const MIN_SMALL_VPS_SWAP_MIB = 1_024;
const RECOMMENDED_SMALL_VPS_SWAPPINESS = 10;
const MAX_SMALL_VPS_SWAPPINESS = 20;
const SECRET_ENV_FILE_OPEN_MODE_MASK = 0o077;
const SCHEDULER_BYTES_PER_TOKEN = 768;
const TIGHT_MEMORY_RATIO = 0.9;
const LLAMA_CPP_SYSTEMD_SERVICE = "ray-llama-cpp.service";
const RAY_STATE_DIRECTORY_NAME = "ray";
const RAY_STATE_DIRECTORY_PATH = "/var/lib/ray";
const RAY_STATE_DIRECTORY_PARENT_PATH = path.dirname(RAY_STATE_DIRECTORY_PATH);
const GATEWAY_ENTRYPOINT_RELATIVE_PATH = "apps/gateway/dist/index.js";
const DEFAULT_GATEWAY_RUNTIME_BINARY = "/usr/local/bin/bun";
const DEFAULT_CADDY_RUNTIME_BINARY = "/usr/bin/caddy";
const BINARY_SOURCE_ENV = "RAY_LLAMA_CPP_BINARY_SOURCE_PATH";
const MODEL_SOURCE_ENV = "RAY_MODEL_SOURCE_PATH";
const MIN_GATEWAY_BUN_VERSION = "1.3.0";
const MIN_GATEWAY_NODE_VERSION = "20.11.0";
const GATEWAY_RUNTIME_VERSION_TIMEOUT_MS = 10_000;
const GATEWAY_RUNTIME_VERSION_MAX_BUFFER_BYTES = 16 * 1024;
const SYSTEMD_RUNTIME_DIRECTORY = "/run/systemd/system";
const SYSTEMCTL_VERSION_TIMEOUT_MS = 10_000;
const SYSTEMCTL_VERSION_MAX_BUFFER_BYTES = 16 * 1024;
const SYSTEMD_ANALYZE_VERIFY_TIMEOUT_MS = 10_000;
const SYSTEMD_ANALYZE_VERIFY_MAX_BUFFER_BYTES = 64 * 1024;
const CADDY_VERSION_TIMEOUT_MS = 10_000;
const CADDY_VERSION_MAX_BUFFER_BYTES = 16 * 1024;
const CADDY_VALIDATE_TIMEOUT_MS = 10_000;
const CADDY_VALIDATE_MAX_BUFFER_BYTES = 64 * 1024;
const LLAMA_CPP_BINARY_PROBE_TIMEOUT_MS = 10_000;
const LLAMA_CPP_BINARY_PROBE_MAX_BUFFER_BYTES = 64 * 1024;
const HOST_PASSWD_PATH = "/etc/passwd";
const HOST_GROUP_PATH = "/etc/group";
const HOST_MEMINFO_PATH = "/proc/meminfo";
const HOST_SWAPPINESS_PATH = "/proc/sys/vm/swappiness";
const MAX_HOST_IDENTITY_FILE_BYTES = 256 * 1024;
const MAX_HOST_MEMINFO_FILE_BYTES = 64 * 1024;
const MAX_HOST_SWAPPINESS_FILE_BYTES = 1_024;
const MAX_SYSTEMD_DEPENDENCY_UNITS = 32;
const MAX_SYSTEMD_DEPENDENCY_UNIT_CHARS = 256;
const MAX_SYSTEMD_MEMORY_MIB = 1_048_576;
const MAX_SYSTEMD_CPU_WEIGHT = 10_000;
const MAX_LLAMA_CPP_EXTRA_ARGS = 64;
const MAX_LLAMA_CPP_EXTRA_ARG_CHARS = 4_096;
const CADDY_UPSTREAM_TIMEOUT_GRACE_MS = 5_000;
const CADDY_DIAL_TIMEOUT_MS = 5_000;
const CADDY_WRITE_TIMEOUT_MS = 10_000;
const MAX_CADDY_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const MAX_CADDY_UPSTREAM_TIMEOUT_MS = 120_000 + CADDY_UPSTREAM_TIMEOUT_GRACE_MS;
const GATEWAY_MEMORY_HIGH_HEADROOM_MIB = 128;
const GATEWAY_MEMORY_MAX_HEADROOM_MIB = 384;
const GATEWAY_MEMORY_SWAP_MAX_MIB = 128;
const MIN_WORKING_DIRECTORY_FREE_MIB = 512;
const LLAMA_CPP_MEMORY_HIGH_RATIO = 0.9;
const LLAMA_CPP_SWAP_MAX_RATIO = 0.25;
const LLAMA_CPP_MIN_SWAP_MAX_MIB = 256;
const LLAMA_CPP_MAX_SWAP_MAX_MIB = MIN_SMALL_VPS_SWAP_MIB;
const GATEWAY_CPU_WEIGHT = 200;
const LLAMA_CPP_CPU_WEIGHT = 80;

interface StorageStats {
  bavail: number | bigint;
  bsize: number | bigint;
  blocks?: number | bigint;
  ffree?: number | bigint;
}

interface ServiceUserIdentity {
  name: string;
  uid: number;
  gid: number;
  groupIds: number[];
}

type SemverTuple = readonly [number, number, number];

interface ParsedRuntimeVersion {
  raw: string;
  tuple: SemverTuple;
}

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

function getExpectedHostArchitectureForPreset(
  preset: LlamaCppLaunchProfile["preset"],
): string | undefined {
  if (preset === "single-vps-sub1b-cax11") {
    return "arm64";
  }

  if (preset === "single-vps-sub1b-cx23") {
    return "x64";
  }

  return undefined;
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

function isSystemdPrivateTmpPath(value: string): boolean {
  if (!path.isAbsolute(value)) {
    return false;
  }

  const resolved = path.resolve(value);
  return ["/tmp", "/var/tmp"].some((privateTmpPath) => isPathInside(privateTmpPath, resolved));
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

function isSystemdProtectSystemReadOnlyPath(value: string): boolean {
  if (!path.isAbsolute(value)) {
    return false;
  }

  const resolved = path.resolve(value);
  return ["/etc", "/usr", "/boot"].some((protectedPath) => isPathInside(protectedPath, resolved));
}

function isRayStateDirectoryStoragePath(value: string): boolean {
  return path.isAbsolute(value) && isPathInside(RAY_STATE_DIRECTORY_PATH, path.resolve(value));
}

function isRayStateDirectoryCreationPath(storagePath: string, checkPath: string): boolean {
  return (
    isRayStateDirectoryStoragePath(storagePath) &&
    path.resolve(checkPath) === RAY_STATE_DIRECTORY_PARENT_PATH
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

function isWildcardBindHost(value: string): boolean {
  const host = normalizeHostLiteral(value);
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";
}

function localBindHostsOverlap(left: string, right: string): boolean {
  const leftHost = normalizeHostLiteral(left);
  const rightHost = normalizeHostLiteral(right);

  if (isWildcardBindHost(leftHost) || isWildcardBindHost(rightHost)) {
    return true;
  }

  if (leftHost === rightHost) {
    return true;
  }

  return (
    (leftHost === "localhost" || rightHost === "localhost") &&
    isLoopbackHost(leftHost) &&
    isLoopbackHost(rightHost)
  );
}

function adapterBaseUrlTargetsGatewaySocket(config: RayConfig, adapterBaseUrl: URL): boolean {
  if (getUrlPort(adapterBaseUrl) !== config.server.port) {
    return false;
  }

  const gatewayHost = normalizeHostLiteral(config.server.host);
  const adapterHost = normalizeHostLiteral(adapterBaseUrl.hostname);
  if (!isLoopbackHost(adapterHost) && adapterHost !== gatewayHost) {
    return false;
  }

  return localBindHostsOverlap(gatewayHost, adapterHost);
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

function extractCaddySiteAddressHost(value: string): string | undefined {
  const siteAddress = value.trim().toLowerCase();

  if (siteAddress.length === 0) {
    return undefined;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//.test(siteAddress)) {
    try {
      const parsed = new URL(siteAddress);
      return normalizeHostLiteral(parsed.hostname);
    } catch {
      return undefined;
    }
  }

  const bracketedHost = /^\[([^\]]+)](?::\d+)?$/.exec(siteAddress);
  if (bracketedHost?.[1]) {
    return normalizeHostLiteral(bracketedHost[1]);
  }

  if (siteAddress.startsWith(":")) {
    return undefined;
  }

  const host =
    siteAddress.includes(":") && siteAddress.indexOf(":") === siteAddress.lastIndexOf(":")
      ? siteAddress.slice(0, siteAddress.indexOf(":"))
      : siteAddress;
  return normalizeHostLiteral(host.replace(/^\*\./, ""));
}

function isLocalCaddySiteAddress(value: string): boolean {
  const host = extractCaddySiteAddressHost(value);

  if (host === undefined || host.length === 0) {
    return true;
  }

  return host === "ray.local" || host.endsWith(".local") || isLoopbackHost(host);
}

function inferRayStateDirectory(config: RayConfig): string | undefined {
  if (!config.asyncQueue.enabled) {
    return undefined;
  }

  const storageDir = path.resolve(config.asyncQueue.storageDir);

  if (isRayStateDirectoryStoragePath(storageDir)) {
    return RAY_STATE_DIRECTORY_NAME;
  }

  return undefined;
}

function readNonEmptyEnvValue(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatModelStageApplyHint(env: NodeJS.ProcessEnv): string {
  const hasBinarySource = readNonEmptyEnvValue(env[BINARY_SOURCE_ENV]) !== undefined;
  const hasModelSource = readNonEmptyEnvValue(env[MODEL_SOURCE_ENV]) !== undefined;
  const command =
    "bun run model:stage -- --config <same-config> --ray-env-file /etc/ray/ray.env --apply";

  if (hasBinarySource && hasModelSource) {
    return ` The deploy env already includes ${BINARY_SOURCE_ENV} and ${MODEL_SOURCE_ENV}; run \`${command}\` before rerunning doctor.`;
  }

  return ` If the source artifacts are already on this VPS, set both ${BINARY_SOURCE_ENV} and ${MODEL_SOURCE_ENV}, then run \`${command}\` before rerunning doctor.`;
}

function isRootServiceUser(
  preflight: Pick<DeploymentPreflight, "serviceUser" | "serviceUserUid">,
): boolean {
  return (
    preflight.serviceUser === "root" ||
    preflight.serviceUser === "0" ||
    preflight.serviceUserUid === 0
  );
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

function formatSystemdMemoryControlLines(options: {
  memoryHighMiB?: number;
  memoryMaxMiB?: number;
  memorySwapMaxMiB?: number;
}): string {
  const { memoryHighMiB, memoryMaxMiB, memorySwapMaxMiB } = options;

  if (memoryHighMiB === undefined && memoryMaxMiB === undefined && memorySwapMaxMiB === undefined) {
    return "";
  }

  if (memoryHighMiB !== undefined) {
    assertPositiveIntegerAtMost(memoryHighMiB, "memoryHighMiB", MAX_SYSTEMD_MEMORY_MIB);
  }

  if (memoryMaxMiB !== undefined) {
    assertPositiveIntegerAtMost(memoryMaxMiB, "memoryMaxMiB", MAX_SYSTEMD_MEMORY_MIB);
  }

  if (memorySwapMaxMiB !== undefined) {
    assertPositiveIntegerAtMost(memorySwapMaxMiB, "memorySwapMaxMiB", MAX_SYSTEMD_MEMORY_MIB);
  }

  if (memoryHighMiB !== undefined && memoryMaxMiB !== undefined && memoryHighMiB > memoryMaxMiB) {
    throw new Error("memoryHighMiB must be less than or equal to memoryMaxMiB");
  }

  return [
    ...(memoryHighMiB !== undefined ? [`MemoryHigh=${memoryHighMiB}M`] : []),
    ...(memoryMaxMiB !== undefined ? [`MemoryMax=${memoryMaxMiB}M`] : []),
    ...(memorySwapMaxMiB !== undefined ? [`MemorySwapMax=${memorySwapMaxMiB}M`] : []),
  ].join("\n");
}

function formatSystemdCpuWeightLine(cpuWeight: number | undefined): string {
  if (cpuWeight === undefined) {
    return "";
  }

  assertPositiveIntegerAtMost(cpuWeight, "cpuWeight", MAX_SYSTEMD_CPU_WEIGHT);
  return `CPUWeight=${cpuWeight}`;
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

function assertLlamaCppLaunchProfileExtraArgs(
  value: unknown,
): asserts value is string[] | undefined {
  assertOptionalSystemdStringArray(
    value,
    "model.adapter.launchProfile.extraArgs",
    MAX_LLAMA_CPP_EXTRA_ARGS,
    MAX_LLAMA_CPP_EXTRA_ARG_CHARS,
  );

  for (const [index, entry] of (value ?? []).entries()) {
    const override = getLlamaCppLaunchProfileExtraArgOverride(entry);
    if (override) {
      throw new Error(
        `model.adapter.launchProfile.extraArgs[${index}] must not override ${override}; use the launchProfile field instead`,
      );
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

  assertLlamaCppLaunchProfileExtraArgs(value.extraArgs);
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

function formatFileMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function readTextFileBounded(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await fileHandle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    if (offset > maxBytes) {
      throw new Error(`${label} file must be at most ${maxBytes} bytes: ${filePath}`);
    }

    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function parseSwapTotalMiB(meminfo: string): number | undefined {
  const match = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!match) {
    return undefined;
  }

  const swapKiB = Number(match[1]);
  return Number.isSafeInteger(swapKiB) && swapKiB >= 0 ? Math.floor(swapKiB / 1024) : undefined;
}

function parseNonNegativeInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseRuntimeVersion(value: string): ParsedRuntimeVersion | undefined {
  const match = /(?:^|[^\d])((\d+)\.(\d+)\.(\d+))(?:[^\d]|$)/.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const raw = match[1];
  const majorValue = match[2];
  const minorValue = match[3];
  const patchValue = match[4];
  if (
    raw === undefined ||
    majorValue === undefined ||
    minorValue === undefined ||
    patchValue === undefined
  ) {
    return undefined;
  }

  const major = Number(majorValue);
  const minor = Number(minorValue);
  const patch = Number(patchValue);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part >= 0)) {
    return undefined;
  }

  return {
    raw,
    tuple: [major, minor, patch],
  };
}

function compareRuntimeVersions(left: SemverTuple, right: SemverTuple): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function identifyGatewayRuntimeKind(runtimeBinary: string): GatewayRuntimeKind | undefined {
  const baseName = path.basename(runtimeBinary).toLowerCase();
  if (baseName === "bun" || baseName === "bun.exe") {
    return "bun";
  }

  if (baseName === "node" || baseName === "node.exe") {
    return "node";
  }

  return undefined;
}

function formatGatewayRuntimeKind(kind: GatewayRuntimeKind): string {
  return kind === "bun" ? "Bun" : "Node.js";
}

function minimumGatewayRuntimeVersion(kind: GatewayRuntimeKind): ParsedRuntimeVersion {
  const minimum = kind === "bun" ? MIN_GATEWAY_BUN_VERSION : MIN_GATEWAY_NODE_VERSION;
  const parsed = parseRuntimeVersion(minimum);
  if (!parsed) {
    throw new Error(`Invalid built-in gateway runtime minimum version: ${minimum}`);
  }

  return parsed;
}

function truncateRuntimeVersionOutput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 256 ? `${normalized.slice(0, 256)}...` : normalized;
}

function parseCommandVersionOutput(value: string): string | undefined {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ? truncateRuntimeVersionOutput(firstLine) : undefined;
}

function resolvePasswdUser(passwd: string, user: string): ServiceUserIdentity | undefined {
  const numericUid = /^\d+$/.test(user) ? user : undefined;

  for (const rawLine of passwd.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const fields = line.split(":");
    if (fields.length < 4) {
      continue;
    }

    const name = fields[0];
    const uidField = fields[2];
    const gidField = fields[3];
    if (name === undefined || uidField === undefined || gidField === undefined) {
      continue;
    }

    if (name === user || (numericUid !== undefined && uidField === numericUid)) {
      const uid = parseNonNegativeInteger(uidField);
      const gid = parseNonNegativeInteger(gidField);

      if (uid === undefined || gid === undefined) {
        return undefined;
      }

      return {
        name,
        uid,
        gid,
        groupIds: [gid],
      };
    }
  }

  return undefined;
}

function parseSupplementaryGroupIds(
  groupFile: string,
  userName: string,
  primaryGid: number,
): number[] {
  const groupIds = new Set<number>([primaryGid]);

  for (const rawLine of groupFile.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const fields = line.split(":");
    if (fields.length < 4) {
      continue;
    }

    const gidField = fields[2];
    const membersField = fields[3];
    if (gidField === undefined || membersField === undefined) {
      continue;
    }

    const gid = parseNonNegativeInteger(gidField);
    if (gid === undefined) {
      continue;
    }

    const members = membersField
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member.length > 0);
    if (members.includes(userName)) {
      groupIds.add(gid);
    }
  }

  return [...groupIds];
}

function resolveGroupNameByGid(groupFile: string, targetGid: number): string | undefined {
  for (const rawLine of groupFile.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const fields = line.split(":");
    if (fields.length < 3) {
      continue;
    }

    const name = fields[0];
    const gidField = fields[2];
    if (name === undefined || name.length === 0 || gidField === undefined) {
      continue;
    }

    const gid = parseNonNegativeInteger(gidField);
    if (gid === targetGid) {
      return name;
    }
  }

  return undefined;
}

function resolveModeBitsForIdentity(fileStat: Stats, identity: ServiceUserIdentity): number {
  if (fileStat.uid === identity.uid) {
    return (fileStat.mode >> 6) & 0b111;
  }

  if (identity.groupIds.includes(fileStat.gid)) {
    return (fileStat.mode >> 3) & 0b111;
  }

  return fileStat.mode & 0b111;
}

function canAccessPathWithModeBits(
  fileStat: Stats,
  identity: ServiceUserIdentity,
  requiredBits: number,
): boolean {
  if (identity.uid === 0) {
    return true;
  }

  return (resolveModeBitsForIdentity(fileStat, identity) & requiredBits) === requiredBits;
}

function formatServiceUserAccessError(
  identity: ServiceUserIdentity,
  operation: string,
  targetPath: string,
  fileStat: Stats,
): string {
  return `${operation} permission is not granted to ${identity.name} by POSIX mode bits on ${targetPath} (${formatFileMode(
    fileStat.mode,
  )})`;
}

async function verifyServiceUserPathAccess(
  targetPath: string,
  identity: ServiceUserIdentity,
  targetBits: number,
  targetOperation: string,
): Promise<{ status: ServiceUserAccessStatus; error?: string }> {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const relativeParts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let currentPath = root;

  for (const part of relativeParts.slice(0, -1)) {
    currentPath = path.join(currentPath, part);
    const directoryStat = await stat(currentPath);

    if (!directoryStat.isDirectory()) {
      return {
        status: "blocked",
        error: `ancestor path is not a directory at ${currentPath}`,
      };
    }

    if (!canAccessPathWithModeBits(directoryStat, identity, 0o1)) {
      return {
        status: "blocked",
        error: formatServiceUserAccessError(identity, "execute", currentPath, directoryStat),
      };
    }
  }

  const targetStat = await stat(resolved);
  if (!canAccessPathWithModeBits(targetStat, identity, targetBits)) {
    return {
      status: "blocked",
      error: formatServiceUserAccessError(identity, targetOperation, resolved, targetStat),
    };
  }

  return { status: "ok" };
}

function shouldRequireSwapCushion(
  launchProfile: LlamaCppLaunchProfile,
  preflight: DeploymentPreflight | undefined,
): boolean {
  if (!isSmallVpsPreset(launchProfile.preset)) {
    return false;
  }

  return preflight?.memoryBudgetMiB === undefined || preflight.memoryBudgetMiB <= 4_096;
}

function statValueToNumber(value: number | bigint | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numberValue = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function resolveAvailableStorageMiB(stats: StorageStats): number | undefined {
  let availableBlocks = statValueToNumber(stats.bavail);
  let blockSize = statValueToNumber(stats.bsize);

  if (blockSize === 0) {
    const fallbackBlockSize = statValueToNumber(stats.blocks);
    const fallbackAvailableBlocks = statValueToNumber(stats.ffree);

    if (
      fallbackBlockSize !== undefined &&
      fallbackBlockSize > 0 &&
      fallbackBlockSize <= BYTES_PER_MIB &&
      fallbackAvailableBlocks !== undefined
    ) {
      blockSize = fallbackBlockSize;
      availableBlocks = fallbackAvailableBlocks;
    }
  }

  if (availableBlocks === undefined || blockSize === undefined || blockSize <= 0) {
    return undefined;
  }

  return Math.floor((availableBlocks * blockSize) / BYTES_PER_MIB);
}

function getPresetMemoryBudgetMiB(preset: LlamaCppLaunchProfile["preset"]): number {
  return isSmallVpsPreset(preset) ? 4_096 : 8_192;
}

function collectHostCpuCount(): number | undefined {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return undefined;
  }
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

function resolveGatewayMemoryControls(config: RayConfig): {
  memoryHighMiB: number;
  memoryMaxMiB: number;
  memorySwapMaxMiB: number;
} {
  return {
    memoryHighMiB:
      config.gracefulDegradation.memoryRssThresholdMiB + GATEWAY_MEMORY_HIGH_HEADROOM_MIB,
    memoryMaxMiB:
      config.gracefulDegradation.memoryRssThresholdMiB + GATEWAY_MEMORY_MAX_HEADROOM_MIB,
    memorySwapMaxMiB: GATEWAY_MEMORY_SWAP_MAX_MIB,
  };
}

function resolveLlamaCppMemoryControls(
  launchProfile: LlamaCppLaunchProfile,
  preflight: Pick<DeploymentPreflight, "memoryBudgetMiB">,
): {
  memoryHighMiB: number;
  memoryMaxMiB: number;
  memorySwapMaxMiB: number;
} {
  const memoryBudgetMiB =
    preflight.memoryBudgetMiB ?? getPresetMemoryBudgetMiB(launchProfile.preset);
  const reserveMiB = Math.max(
    MIN_SYSTEM_RESERVE_MIB,
    Math.ceil(memoryBudgetMiB * SYSTEM_RESERVE_RATIO),
  );
  const memoryMaxMiB = Math.max(512, memoryBudgetMiB - reserveMiB - RAY_RUNTIME_RESERVE_MIB);

  return {
    memoryHighMiB: Math.max(1, Math.floor(memoryMaxMiB * LLAMA_CPP_MEMORY_HIGH_RATIO)),
    memoryMaxMiB,
    memorySwapMaxMiB: Math.min(
      LLAMA_CPP_MAX_SWAP_MAX_MIB,
      Math.max(LLAMA_CPP_MIN_SWAP_MAX_MIB, Math.floor(memoryMaxMiB * LLAMA_CPP_SWAP_MAX_RATIO)),
    ),
  };
}

function resolveGatewaySystemdControls(config: RayConfig): SystemdResourceControls {
  return {
    ...resolveGatewayMemoryControls(config),
    cpuWeight: GATEWAY_CPU_WEIGHT,
  };
}

function resolveLlamaCppSystemdControls(
  launchProfile: LlamaCppLaunchProfile,
  preflight: Pick<DeploymentPreflight, "memoryBudgetMiB">,
): SystemdResourceControls {
  return {
    ...resolveLlamaCppMemoryControls(launchProfile, preflight),
    cpuWeight: LLAMA_CPP_CPU_WEIGHT,
  };
}

function sanitizeDeploymentSummaryConfig(
  config: RayConfig,
): Pick<DeploymentBundleSummary, "profile" | "model" | "server"> {
  const sanitized = sanitizeConfig(config) as unknown as Pick<
    RayConfig,
    "profile" | "model" | "server"
  >;

  return {
    profile: sanitized.profile,
    model: sanitized.model,
    server: sanitized.server,
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
    LLAMA_ARG_BATCH: profile.batchSize.toString(),
    LLAMA_ARG_BATCH_SIZE: profile.batchSize.toString(),
    LLAMA_ARG_UBATCH: profile.ubatchSize.toString(),
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

function boolToLaunchArg(value: boolean, enabledFlag: string, disabledFlag?: string): string[] {
  if (value) {
    return [enabledFlag];
  }

  return disabledFlag ? [disabledFlag] : [];
}

function buildLlamaCppLaunchArgs(profile: LlamaCppLaunchProfile): string[] {
  assertLlamaCppLaunchProfileForEnvironment(profile);

  return [
    "--model",
    profile.modelPath,
    ...(profile.alias ? ["--alias", profile.alias] : []),
    "--host",
    profile.host,
    "--port",
    profile.port.toString(),
    "--ctx-size",
    profile.ctxSize.toString(),
    "--parallel",
    profile.parallel.toString(),
    "--threads",
    profile.threads.toString(),
    ...(profile.threadsBatch !== undefined
      ? ["--threads-batch", profile.threadsBatch.toString()]
      : []),
    "--threads-http",
    profile.threadsHttp.toString(),
    "--batch-size",
    profile.batchSize.toString(),
    "--ubatch-size",
    profile.ubatchSize.toString(),
    ...boolToLaunchArg(profile.cachePrompt, "--cache-prompt", "--no-cache-prompt"),
    "--cache-reuse",
    profile.cacheReuse.toString(),
    ...(profile.cacheRamMiB !== undefined ? ["--cache-ram", profile.cacheRamMiB.toString()] : []),
    ...boolToLaunchArg(profile.continuousBatching, "--cont-batching", "--no-cont-batching"),
    ...boolToLaunchArg(profile.enableMetrics, "--metrics"),
    ...boolToLaunchArg(profile.exposeSlots, "--slots", "--no-slots"),
    ...boolToLaunchArg(profile.warmup, "--warmup", "--no-warmup"),
    ...boolToLaunchArg(profile.enableUnifiedKv, "--kv-unified", "--no-kv-unified"),
    ...boolToLaunchArg(profile.cacheIdleSlots, "--cache-idle-slots", "--no-cache-idle-slots"),
    ...boolToLaunchArg(profile.contextShift, "--context-shift", "--no-context-shift"),
  ];
}

export function renderSystemdService(options: SystemdServiceOptions): string {
  assertOptionsObject(options, "Systemd service options");

  const after = options.after;
  const wants = options.wants;
  assertOptionalSystemdDependencyArray(after, "after");
  assertOptionalSystemdDependencyArray(wants, "wants");

  const runtimeBinary =
    options.runtimeBinary ?? options.nodeBinary ?? DEFAULT_GATEWAY_RUNTIME_BINARY;
  assertSystemdScalar(runtimeBinary, "runtimeBinary");
  assertSystemdScalar(options.workingDirectory, "workingDirectory");
  assertSystemdScalar(options.configPath, "configPath");
  assertAbsolutePath(runtimeBinary, "runtimeBinary");
  assertAbsolutePath(options.workingDirectory, "workingDirectory");
  if (isSystemdProtectHomePath(runtimeBinary)) {
    throw new Error(
      "runtimeBinary is under /home, /root, or /run/user, but the generated gateway service uses ProtectHome=true",
    );
  }
  if (isSystemdPrivateTmpPath(runtimeBinary)) {
    throw new Error(
      "runtimeBinary is under /tmp or /var/tmp, but the generated gateway service uses PrivateTmp=true",
    );
  }
  if (isSystemdProtectHomePath(options.workingDirectory)) {
    throw new Error(
      "workingDirectory is under /home, /root, or /run/user, but the generated gateway service uses ProtectHome=true",
    );
  }
  if (isSystemdPrivateTmpPath(options.workingDirectory)) {
    throw new Error(
      "workingDirectory is under /tmp or /var/tmp, but the generated gateway service uses PrivateTmp=true",
    );
  }
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
  if (isSystemdProtectHomePath(absoluteConfigPath)) {
    throw new Error(
      "configPath resolves under /home, /root, or /run/user, but the generated gateway service uses ProtectHome=true",
    );
  }
  if (isSystemdPrivateTmpPath(absoluteConfigPath)) {
    throw new Error(
      "configPath resolves under /tmp or /var/tmp, but the generated gateway service uses PrivateTmp=true",
    );
  }
  const gatewayEntryPoint = path.join(options.workingDirectory, GATEWAY_ENTRYPOINT_RELATIVE_PATH);
  const execStart = formatSystemdExecStart([
    runtimeBinary,
    gatewayEntryPoint,
    "--config",
    absoluteConfigPath,
  ]);
  const memoryControlLines = formatSystemdMemoryControlLines({
    ...(options.memoryHighMiB !== undefined ? { memoryHighMiB: options.memoryHighMiB } : {}),
    ...(options.memoryMaxMiB !== undefined ? { memoryMaxMiB: options.memoryMaxMiB } : {}),
    ...(options.memorySwapMaxMiB !== undefined
      ? { memorySwapMaxMiB: options.memorySwapMaxMiB }
      : {}),
  });
  const cpuWeightLine = formatSystemdCpuWeightLine(options.cpuWeight);

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
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200
TimeoutStopSec=35
KillSignal=SIGTERM
KillMode=mixed
OOMPolicy=stop
OOMScoreAdjust=-250
TasksMax=128
CPUAccounting=true
${cpuWeightLine ? `${cpuWeightLine}\n` : ""}
MemoryAccounting=true
IOAccounting=true
${memoryControlLines ? `${memoryControlLines}\n` : ""}
${stateDirectoryLine}NoNewPrivileges=true
CapabilityBoundingSet=
SystemCallArchitectures=native
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectClock=true
ProtectHostname=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
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
  if (isSystemdProtectHomePath(options.launchProfile.binaryPath)) {
    throw new Error(
      "model.adapter.launchProfile.binaryPath is under /home, /root, or /run/user, but the generated llama.cpp service uses ProtectHome=true",
    );
  }
  if (isSystemdPrivateTmpPath(options.launchProfile.binaryPath)) {
    throw new Error(
      "model.adapter.launchProfile.binaryPath is under /tmp or /var/tmp, but the generated llama.cpp service uses PrivateTmp=true",
    );
  }
  if (isSystemdProtectHomePath(options.launchProfile.modelPath)) {
    throw new Error(
      "model.adapter.launchProfile.modelPath is under /home, /root, or /run/user, but the generated llama.cpp service uses ProtectHome=true",
    );
  }
  if (isSystemdPrivateTmpPath(options.launchProfile.modelPath)) {
    throw new Error(
      "model.adapter.launchProfile.modelPath is under /tmp or /var/tmp, but the generated llama.cpp service uses PrivateTmp=true",
    );
  }

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
  const execStart = formatSystemdExecStart([
    profile.binaryPath,
    ...buildLlamaCppLaunchArgs(profile),
    ...(profile.extraArgs ?? []),
  ]);
  const memoryControlLines = formatSystemdMemoryControlLines({
    ...(options.memoryHighMiB !== undefined ? { memoryHighMiB: options.memoryHighMiB } : {}),
    ...(options.memoryMaxMiB !== undefined ? { memoryMaxMiB: options.memoryMaxMiB } : {}),
    ...(options.memorySwapMaxMiB !== undefined
      ? { memorySwapMaxMiB: options.memorySwapMaxMiB }
      : {}),
  });
  const cpuWeightLine = formatSystemdCpuWeightLine(options.cpuWeight);

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
LogRateLimitIntervalSec=30s
LogRateLimitBurst=200
TimeoutStopSec=35
KillSignal=SIGTERM
KillMode=mixed
OOMPolicy=stop
OOMScoreAdjust=250
TasksMax=256
CPUAccounting=true
${cpuWeightLine ? `${cpuWeightLine}\n` : ""}
MemoryAccounting=true
IOAccounting=true
${memoryControlLines ? `${memoryControlLines}\n` : ""}
NoNewPrivileges=true
CapabilityBoundingSet=
SystemCallArchitectures=native
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectClock=true
ProtectHostname=true
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
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

  lines.push("# Optional deployment/render switches:");
  lines.push("# RAY_DEPLOY_SERVICE_USER=ray");
  lines.push("# RAY_DEPLOY_DOMAIN=ray.local");
  lines.push(`# RAY_DEPLOY_MEMORY_MIB=${config.model.operational?.memoryClassMiB ?? ""}`);
  lines.push(`# RAY_GATEWAY_RUNTIME_BINARY=${DEFAULT_GATEWAY_RUNTIME_BINARY}`);
  lines.push(`# RAY_DEPLOY_CADDY_BINARY=${DEFAULT_CADDY_RUNTIME_BINARY}`);

  lines.push("# Optional gateway behavior switches:");
  lines.push(`# RAY_PROFILE=${config.profile}`);
  lines.push(`# RAY_HOST=${config.server.host}`);
  lines.push(`# RAY_PORT=${config.server.port}`);
  lines.push(`# RAY_LOG_LEVEL=${config.telemetry.logLevel}`);
  lines.push(`# RAY_TELEMETRY_SERVICE_NAME=${config.telemetry.serviceName}`);
  lines.push(`# RAY_TELEMETRY_INCLUDE_DEBUG_METRICS=${config.telemetry.includeDebugMetrics}`);
  lines.push(
    `# RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS=${config.telemetry.slowRequestThresholdMs}`,
  );
  if (
    (config.model.adapter.kind === "openai-compatible" ||
      config.model.adapter.kind === "llama.cpp") &&
    config.model.adapter.apiKeyEnv
  ) {
    lines.push(`# RAY_MODEL_API_KEY_ENV=${config.model.adapter.apiKeyEnv}`);
  }
  if (
    config.model.adapter.kind === "openai-compatible" ||
    config.model.adapter.kind === "llama.cpp"
  ) {
    lines.push(`# RAY_MODEL_BASE_URL=${config.model.adapter.baseUrl}`);
    lines.push(`# RAY_MODEL_REF=${config.model.adapter.modelRef}`);
  }
  lines.push(`# RAY_MODEL_WARM_ON_BOOT=${config.model.warmOnBoot}`);
  lines.push(`# RAY_MODEL_CONTEXT_WINDOW=${config.model.contextWindow}`);
  lines.push(`# RAY_MODEL_MAX_OUTPUT_TOKENS=${config.model.maxOutputTokens}`);
  if (config.model.operational) {
    lines.push(
      `# RAY_MODEL_TOKENS_PER_SECOND_TARGET=${config.model.operational.tokensPerSecondTarget}`,
    );
    lines.push(`# RAY_MODEL_MEMORY_CLASS_MIB=${config.model.operational.memoryClassMiB}`);
    lines.push(`# RAY_MODEL_PREFERRED_CTX_SIZE=${config.model.operational.preferredCtxSize}`);
  }
  lines.push(`# RAY_REQUEST_BODY_LIMIT_BYTES=${config.server.requestBodyLimitBytes}`);
  lines.push(`# RAY_ASYNC_QUEUE_ENABLED=${config.asyncQueue.enabled}`);
  lines.push(`# RAY_CACHE_ENABLED=${config.cache.enabled}`);
  lines.push(`# RAY_CACHE_MAX_ENTRIES=${config.cache.maxEntries}`);
  lines.push(`# RAY_CACHE_MAX_BYTES=${config.cache.maxBytes}`);
  lines.push(`# RAY_CACHE_TTL_MS=${config.cache.ttlMs}`);
  lines.push(`# RAY_CACHE_KEY_STRATEGY=${config.cache.keyStrategy}`);
  lines.push(`# RAY_GRACEFUL_DEGRADATION_ENABLED=${config.gracefulDegradation.enabled}`);
  lines.push(
    `# RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD=${config.gracefulDegradation.queueDepthThreshold}`,
  );
  lines.push(`# RAY_DEGRADATION_MAX_PROMPT_CHARS=${config.gracefulDegradation.maxPromptChars}`);
  lines.push(`# RAY_DEGRADATION_MAX_TOKENS=${config.gracefulDegradation.degradeToMaxTokens}`);
  lines.push(`# RAY_PROMPT_COMPILER_ENABLED=${config.promptCompiler.enabled}`);
  lines.push(
    `# RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE=${config.promptCompiler.collapseWhitespace}`,
  );
  lines.push(
    `# RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES=${config.promptCompiler.dedupeRepeatedLines}`,
  );
  lines.push(
    `# RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS=${config.promptCompiler.familyMetadataKeys.join(
      ",",
    )}`,
  );
  lines.push(`# RAY_ADAPTIVE_TUNING_ENABLED=${config.adaptiveTuning.enabled}`);
  lines.push(`# RAY_ADAPTIVE_SAMPLE_SIZE=${config.adaptiveTuning.sampleSize}`);
  lines.push(
    `# RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS=${config.adaptiveTuning.queueLatencyThresholdMs}`,
  );
  lines.push(
    `# RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND=${config.adaptiveTuning.minCompletionTokensPerSecond}`,
  );
  lines.push(
    `# RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO=${config.adaptiveTuning.maxOutputReductionRatio}`,
  );
  lines.push(`# RAY_ADAPTIVE_MIN_OUTPUT_TOKENS=${config.adaptiveTuning.minOutputTokens}`);
  lines.push(
    `# RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED=${config.adaptiveTuning.learnedFamilyCapEnabled}`,
  );
  lines.push(`# RAY_ADAPTIVE_FAMILY_HISTORY_SIZE=${config.adaptiveTuning.familyHistorySize}`);
  lines.push(
    `# RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES=${config.adaptiveTuning.learnedCapMinSamples}`,
  );
  lines.push(`# RAY_ADAPTIVE_DRAFT_PERCENTILE=${config.adaptiveTuning.draftPercentile}`);
  lines.push(`# RAY_ADAPTIVE_SHORT_PERCENTILE=${config.adaptiveTuning.shortPercentile}`);
  lines.push(
    `# RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS=${config.adaptiveTuning.learnedCapHeadroomTokens}`,
  );
  lines.push(`# RAY_AUTH_ENABLED=${config.auth.enabled}`);
  lines.push(`# RAY_AUTH_API_KEY_ENV=${config.auth.apiKeyEnv}`);
  lines.push(`# RAY_RATE_LIMIT_ENABLED=${config.rateLimit.enabled}`);
  lines.push(`# RAY_RATE_LIMIT_WINDOW_MS=${config.rateLimit.windowMs}`);
  lines.push(`# RAY_RATE_LIMIT_MAX_REQUESTS=${config.rateLimit.maxRequests}`);
  lines.push(`# RAY_RATE_LIMIT_MAX_KEYS=${config.rateLimit.maxKeys}`);
  lines.push(`# RAY_RATE_LIMIT_KEY_STRATEGY=${config.rateLimit.keyStrategy}`);
  lines.push(`# RAY_RATE_LIMIT_TRUST_PROXY_HEADERS=${config.rateLimit.trustProxyHeaders}`);

  if (config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile) {
    const modelArtifactFilename =
      path.basename(config.model.adapter.launchProfile.modelPath) || "model.gguf";

    lines.push(
      "# llama.cpp launch profile is rendered directly into the generated systemd service.",
    );
    lines.push("# Optional portable 1B/model overrides:");
    lines.push(`# RAY_MODEL_ID=${config.model.id}`);
    lines.push(`# RAY_MODEL_REF=${config.model.adapter.modelRef}`);
    lines.push(`# RAY_MODEL_PATH=${config.model.adapter.launchProfile.modelPath}`);
    lines.push(`# RAY_MODEL_FAMILY=${config.model.family}`);
    lines.push(`# RAY_MODEL_QUANTIZATION=${config.model.quantization}`);
    lines.push(`# RAY_LLAMA_CPP_BASE_URL=${config.model.adapter.baseUrl}`);
    lines.push(`# RAY_LLAMA_CPP_MODEL_REF=${config.model.adapter.modelRef}`);
    lines.push(`# RAY_LLAMA_CPP_MODEL_PATH=${config.model.adapter.launchProfile.modelPath}`);
    lines.push(`# RAY_LLAMA_CPP_BINARY_PATH=${config.model.adapter.launchProfile.binaryPath}`);
    lines.push("# Optional artifact staging inputs for bun run model:stage*:");
    lines.push("# RAY_LLAMA_CPP_BINARY_SOURCE_PATH=/tmp/ray-artifacts/llama-server");
    lines.push("# RAY_LLAMA_CPP_BINARY_SHA256=replace-with-64-character-sha256");
    lines.push(`# RAY_MODEL_SOURCE_PATH=/tmp/ray-artifacts/${modelArtifactFilename}`);
    lines.push("# RAY_MODEL_SHA256=replace-with-64-character-sha256");
    lines.push(`# RAY_LLAMA_CPP_ALIAS=${config.model.adapter.launchProfile.alias ?? ""}`);
    lines.push(`# RAY_LLAMA_CPP_HOST=${config.model.adapter.launchProfile.host}`);
    lines.push(`# RAY_LLAMA_CPP_PORT=${config.model.adapter.launchProfile.port}`);
    lines.push(`# RAY_LLAMA_CPP_CTX_SIZE=${config.model.adapter.launchProfile.ctxSize}`);
    lines.push(`# RAY_LLAMA_CPP_PARALLEL=${config.model.adapter.launchProfile.parallel}`);
    lines.push(`# RAY_LLAMA_CPP_THREADS=${config.model.adapter.launchProfile.threads}`);
    lines.push(
      `# RAY_LLAMA_CPP_THREADS_BATCH=${config.model.adapter.launchProfile.threadsBatch ?? ""}`,
    );
    lines.push(`# RAY_LLAMA_CPP_THREADS_HTTP=${config.model.adapter.launchProfile.threadsHttp}`);
    lines.push(`# RAY_LLAMA_CPP_BATCH_SIZE=${config.model.adapter.launchProfile.batchSize}`);
    lines.push(`# RAY_LLAMA_CPP_UBATCH_SIZE=${config.model.adapter.launchProfile.ubatchSize}`);
    lines.push(`# RAY_LLAMA_CPP_CACHE_REUSE=${config.model.adapter.launchProfile.cacheReuse}`);
    lines.push(
      `# RAY_LLAMA_CPP_CACHE_RAM_MIB=${config.model.adapter.launchProfile.cacheRamMiB ?? ""}`,
    );
    lines.push(`# RAY_LLAMA_CPP_CACHE_PROMPT=${config.model.adapter.launchProfile.cachePrompt}`);
    lines.push(`# RAY_LLAMA_CPP_SLOT_ID=${config.model.adapter.slotId ?? ""}`);
    lines.push(`# RAY_LLAMA_CPP_SLOT_STATE_TTL_MS=${config.model.adapter.slotStateTtlMs ?? ""}`);
    lines.push(
      `# RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS=${config.model.adapter.slotSnapshotTimeoutMs ?? ""}`,
    );
    lines.push(
      `# RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES=${config.model.adapter.promptScaffoldCacheEntries ?? ""}`,
    );
    lines.push(
      `# RAY_LLAMA_CPP_CONTINUOUS_BATCHING=${config.model.adapter.launchProfile.continuousBatching}`,
    );
    lines.push(
      `# RAY_LLAMA_CPP_ENABLE_METRICS=${config.model.adapter.launchProfile.enableMetrics}`,
    );
    lines.push(`# RAY_LLAMA_CPP_EXPOSE_SLOTS=${config.model.adapter.launchProfile.exposeSlots}`);
    lines.push(`# RAY_LLAMA_CPP_WARMUP=${config.model.adapter.launchProfile.warmup}`);
    lines.push(
      `# RAY_LLAMA_CPP_ENABLE_UNIFIED_KV=${config.model.adapter.launchProfile.enableUnifiedKv}`,
    );
    lines.push(
      `# RAY_LLAMA_CPP_CACHE_IDLE_SLOTS=${config.model.adapter.launchProfile.cacheIdleSlots}`,
    );
    lines.push(`# RAY_LLAMA_CPP_CONTEXT_SHIFT=${config.model.adapter.launchProfile.contextShift}`);
    lines.push(`# RAY_SCHEDULER_CONCURRENCY=${config.scheduler.concurrency}`);
    lines.push(`# RAY_SCHEDULER_MAX_QUEUE=${config.scheduler.maxQueue}`);
    lines.push(`# RAY_SCHEDULER_MAX_QUEUED_TOKENS=${config.scheduler.maxQueuedTokens}`);
    lines.push(`# RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=${config.scheduler.maxInflightTokens}`);
    lines.push(`# RAY_SCHEDULER_REQUEST_TIMEOUT_MS=${config.scheduler.requestTimeoutMs}`);
    lines.push(`# RAY_SCHEDULER_DEDUPE_INFLIGHT=${config.scheduler.dedupeInflight}`);
    lines.push(`# RAY_SCHEDULER_BATCH_WINDOW_MS=${config.scheduler.batchWindowMs}`);
    lines.push(`# RAY_SCHEDULER_AFFINITY_LOOKAHEAD=${config.scheduler.affinityLookahead}`);
    lines.push(`# RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS=${config.scheduler.shortJobMaxTokens}`);
    lines.push(
      `# RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=${config.gracefulDegradation.memoryRssThresholdMiB}`,
    );
    lines.push(
      `# RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD=${config.gracefulDegradation.cpuThrottledRatioThreshold}`,
    );
  }

  if (config.asyncQueue.enabled) {
    lines.push("# Optional async durable queue overrides:");
    lines.push(`# RAY_ASYNC_QUEUE_STORAGE_DIR=${config.asyncQueue.storageDir}`);
    lines.push(`# RAY_ASYNC_QUEUE_MAX_JOBS=${config.asyncQueue.maxJobs}`);
    lines.push(`# RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=${config.asyncQueue.minFreeStorageMiB}`);
    lines.push(`# RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=${config.asyncQueue.completedTtlMs}`);
    lines.push(`# RAY_ASYNC_QUEUE_POLL_INTERVAL_MS=${config.asyncQueue.pollIntervalMs}`);
    lines.push(`# RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY=${config.asyncQueue.dispatchConcurrency}`);
    lines.push(`# RAY_ASYNC_QUEUE_MAX_ATTEMPTS=${config.asyncQueue.maxAttempts}`);
    lines.push(`# RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS=${config.asyncQueue.callbackTimeoutMs}`);
    lines.push(`# RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS=${config.asyncQueue.maxCallbackAttempts}`);
    lines.push(
      `# RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK=${config.asyncQueue.callbackAllowPrivateNetwork}`,
    );
    lines.push(
      `# RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=${config.asyncQueue.callbackAllowedHosts.join(",")}`,
    );
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
    const authKeyEnv = config.auth.apiKeyEnv;
    const rawAuthKeys = authKeyEnv ? env[authKeyEnv] : undefined;
    const shouldDeferAuthKeyValidation =
      options.allowMissingAuthKeys === true &&
      envFile !== undefined &&
      typeof authKeyEnv === "string" &&
      authKeyEnv.length > 0 &&
      (typeof rawAuthKeys !== "string" || rawAuthKeys.trim().length === 0);

    if (shouldDeferAuthKeyValidation) {
      diagnostics.push({
        level: "warn",
        code: "auth_keys_unverified",
        message: `Auth is enabled but ${authKeyEnv} was not present while rendering. The generated systemd unit must load it from ${envFile}.`,
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

  if (
    preflight?.caddySiteAddress !== undefined &&
    isLocalCaddySiteAddress(preflight.caddySiteAddress)
  ) {
    diagnostics.push({
      level: "warn",
      code: "caddy_site_address_local",
      message: `Generated Caddyfile site address "${preflight.caddySiteAddress}" is local or placeholder-only. Set --domain or RAY_DEPLOY_DOMAIN to the real public DNS name before installing Caddy on a VPS.`,
    });
  }

  if (preflight?.serviceUser !== undefined && isRootServiceUser(preflight)) {
    diagnostics.push({
      level: "warn",
      code: "service_user_root",
      message:
        'Generated Ray systemd units are configured to run as root. Use a dedicated non-root service account such as "ray" so a gateway or backend compromise is contained by systemd hardening and file ownership.',
    });
  }

  if (strictFilesystem && preflight?.systemdStatus !== undefined) {
    if (preflight.systemdStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "systemd_host_missing",
        message: `This host does not appear to be booted with systemd${preflight.systemdError ? ` (${preflight.systemdError})` : ""}. Generated Ray deployments install ray-gateway.service and ray-llama-cpp.service, so run doctor on the target systemd VPS before restarting services.`,
      });
    } else if (preflight.systemdStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "systemd_host_unreadable",
        message: `Doctor could not verify that this host can run systemd services${preflight.systemdError ? ` (${preflight.systemdError})` : ""}. Verify systemd and systemctl manually before installing the generated Ray units.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "systemd_host_ok",
        message: `systemd is available on this host${preflight.systemdVersion ? ` (${preflight.systemdVersion})` : ""}.`,
      });
    }
  }

  if (strictFilesystem && preflight?.systemdUnitStatus !== undefined) {
    if (preflight.systemdUnitStatus === "invalid") {
      diagnostics.push({
        level: "error",
        code: "systemd_units_invalid",
        message: `The generated systemd units did not verify with systemd-analyze${preflight.systemdUnitError ? ` (${preflight.systemdUnitError})` : ""}. Fix the rendered gateway or llama.cpp unit before installing or restarting services.`,
      });
    } else if (preflight.systemdUnitStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "systemd_units_unreadable",
        message: `Doctor could not verify the generated systemd units${preflight.systemdUnitError ? ` (${preflight.systemdUnitError})` : ""}. Run systemd-analyze verify manually before installing or restarting Ray services.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "systemd_units_ok",
        message: "The generated systemd units verify with systemd-analyze on this host.",
      });
    }
  }

  if (strictFilesystem && preflight?.caddyStatus !== undefined) {
    if (preflight.caddyStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "caddy_runtime_missing",
        message: `Caddy was not found on this host${preflight.caddyError ? ` (${preflight.caddyError})` : ""}. Generated Ray VPS deployments include a Caddyfile and expect Caddy to terminate public HTTPS before proxying to the local gateway.`,
      });
    } else if (preflight.caddyStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "caddy_runtime_unreadable",
        message: `Doctor could not run caddy version${preflight.caddyError ? ` (${preflight.caddyError})` : ""}. Verify Caddy manually before exposing Ray publicly through the generated Caddyfile.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "caddy_runtime_ok",
        message: `Caddy is available on this host${preflight.caddyVersion ? ` (${preflight.caddyVersion})` : ""}.`,
      });
    }
  }

  if (strictFilesystem && preflight?.caddyConfigStatus !== undefined) {
    if (preflight.caddyConfigStatus === "invalid") {
      diagnostics.push({
        level: "error",
        code: "caddy_config_invalid",
        message: `The generated Caddyfile did not validate with the installed Caddy runtime${preflight.caddyConfigError ? ` (${preflight.caddyConfigError})` : ""}. Fix the rendered reverse proxy config before installing or reloading Caddy.`,
      });
    } else if (preflight.caddyConfigStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "caddy_config_unreadable",
        message: `Doctor could not validate the generated Caddyfile${preflight.caddyConfigError ? ` (${preflight.caddyConfigError})` : ""}. Verify Caddy manually before exposing Ray publicly.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "caddy_config_ok",
        message:
          "The generated Caddyfile validates with the installed Caddy runtime for this config.",
      });
    }
  }

  if (strictFilesystem && preflight?.workingDirectoryStatus !== undefined) {
    const workingDirectoryPath =
      preflight.workingDirectoryPath ?? "the configured WorkingDirectory";

    if (preflight.workingDirectoryStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "working_directory_missing",
        message: `The generated systemd WorkingDirectory was not found at ${workingDirectoryPath}. Sync Ray to that path before rendering or restarting ray-gateway.service.`,
      });
    } else if (preflight.workingDirectoryStatus === "not_directory") {
      diagnostics.push({
        level: "error",
        code: "working_directory_not_directory",
        message: `The generated systemd WorkingDirectory path is not a directory at ${workingDirectoryPath}. Point --cwd at the Ray repository directory before rendering or restarting ray-gateway.service.`,
      });
    } else if (preflight.workingDirectoryStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "working_directory_unreadable",
        message: `The generated systemd WorkingDirectory at ${workingDirectoryPath} could not be inspected${preflight.workingDirectoryError ? ` (${preflight.workingDirectoryError})` : ""}. Doctor cannot verify that ray-gateway.service will start in the intended repository directory.`,
      });
    } else if (isSystemdProtectHomePath(workingDirectoryPath)) {
      diagnostics.push({
        level: "error",
        code: "working_directory_home_protected",
        message: `The generated systemd WorkingDirectory is under /home, /root, or /run/user at ${workingDirectoryPath}, but ray-gateway.service uses ProtectHome=true. Sync Ray to a service-readable path such as /srv/ray.`,
      });
    } else if (isSystemdPrivateTmpPath(workingDirectoryPath)) {
      diagnostics.push({
        level: "error",
        code: "working_directory_private_tmp",
        message: `The generated systemd WorkingDirectory is under /tmp or /var/tmp at ${workingDirectoryPath}, but ray-gateway.service uses PrivateTmp=true and temporary storage can be hidden or wiped. Sync Ray to a persistent service-readable path such as /srv/ray.`,
      });
    } else if (preflight.workingDirectoryAccessStatus === "blocked") {
      diagnostics.push({
        level: "error",
        code: "working_directory_service_user_inaccessible",
        message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot access the WorkingDirectory at ${workingDirectoryPath}${preflight.workingDirectoryAccessError ? ` (${preflight.workingDirectoryAccessError})` : ""}. Grant read/execute access or sync Ray to a service-readable path such as /srv/ray.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "working_directory_ok",
        message:
          preflight.workingDirectoryAccessStatus === "ok"
            ? `Generated systemd WorkingDirectory exists and is accessible to "${preflight.serviceUser ?? "the configured service user"}" at ${workingDirectoryPath}.`
            : `Generated systemd WorkingDirectory exists at ${workingDirectoryPath}.`,
      });
    }

    if (preflight.workingDirectoryStatus === "found") {
      if (preflight.workingDirectoryStorageStatus === "unreadable") {
        diagnostics.push({
          level: "error",
          code: "working_directory_storage_unreadable",
          message: `Doctor could not inspect free space for the generated systemd WorkingDirectory at ${workingDirectoryPath}${preflight.workingDirectoryStorageError ? ` (${preflight.workingDirectoryStorageError})` : ""}. Verify there is room for the synced Ray checkout, built gateway assets, and Bun production install before restarting ray-gateway.service.`,
        });
      } else if (preflight.workingDirectoryAvailableMiB !== undefined) {
        if (preflight.workingDirectoryAvailableMiB < MIN_WORKING_DIRECTORY_FREE_MIB) {
          diagnostics.push({
            level: "error",
            code: "working_directory_storage_low",
            message: `The generated systemd WorkingDirectory filesystem has ${formatMiB(preflight.workingDirectoryAvailableMiB)} free at ${workingDirectoryPath}, below the ${formatMiB(MIN_WORKING_DIRECTORY_FREE_MIB)} deployment cushion for the synced Ray checkout, built gateway assets, and Bun production install. Free disk space or move the checkout before restarting ray-gateway.service.`,
          });
        } else {
          diagnostics.push({
            level: "info",
            code: "working_directory_storage_ok",
            message: `The generated systemd WorkingDirectory filesystem has ${formatMiB(preflight.workingDirectoryAvailableMiB)} free at ${workingDirectoryPath}, satisfying the ${formatMiB(MIN_WORKING_DIRECTORY_FREE_MIB)} deployment cushion for the synced Ray checkout, built gateway assets, and Bun production install.`,
          });
        }
      }
    }
  }

  if (strictFilesystem && preflight?.envFileStatus !== undefined) {
    const checkedEnvFile = preflight.envFilePath ?? envFile ?? "the configured EnvironmentFile";

    if (preflight.envFileStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "env_file_missing_on_disk",
        message: `The configured EnvironmentFile was not found at ${checkedEnvFile}. Create it before rendering or restarting ray-gateway.service.`,
      });
    } else if (preflight.envFileStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "env_file_unreadable",
        message: `The configured EnvironmentFile at ${checkedEnvFile} could not be inspected${preflight.envFileError ? ` (${preflight.envFileError})` : ""}. Doctor cannot verify env-file readiness.`,
      });
    } else if (
      preflight.envFileMode !== undefined &&
      (preflight.envFileMode & SECRET_ENV_FILE_OPEN_MODE_MASK) !== 0
    ) {
      diagnostics.push({
        level: "warn",
        code: "env_file_permissions_open",
        message: `EnvironmentFile ${checkedEnvFile} has mode ${formatFileMode(
          preflight.envFileMode,
        )}. /etc/ray/ray.env often contains API keys; use chmod 600 or similarly tight ownership before exposing Ray publicly.`,
      });
    }
  }

  if (strictFilesystem && preflight?.serviceUserStatus !== undefined) {
    const serviceUser = preflight.serviceUser ?? "the configured service user";

    if (preflight.serviceUserStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "service_user_missing",
        message: `The generated systemd service user "${serviceUser}" was not found on this host. Create it before rendering or restarting Ray services, or pass --user with an existing system account.`,
      });
    } else if (preflight.serviceUserStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "service_user_unreadable",
        message: `Doctor could not inspect the generated systemd service user "${serviceUser}"${preflight.serviceUserError ? ` (${preflight.serviceUserError})` : ""}. Verify the account exists before restarting Ray services.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "service_user_ok",
        message: `Generated systemd service user "${serviceUser}" exists on this host.`,
      });
    }
  }

  if (strictFilesystem && preflight?.configFileStatus !== undefined) {
    const configFilePath = preflight.configFilePath ?? "the configured Ray config file";
    const configFileOwnershipExample = preflight.serviceUserPrimaryGroup
      ? `root:${preflight.serviceUserPrimaryGroup}`
      : "root:<service-user-primary-group>";

    if (isSystemdProtectHomePath(configFilePath)) {
      diagnostics.push({
        level: "error",
        code: "config_file_home_protected",
        message: `The generated gateway config file is under /home, /root, or /run/user at ${configFilePath}, but ray-gateway.service uses ProtectHome=true. Install the rendered config somewhere service-readable such as /etc/ray/ray.json.`,
      });
    } else if (isSystemdPrivateTmpPath(configFilePath)) {
      diagnostics.push({
        level: "error",
        code: "config_file_private_tmp",
        message: `The generated gateway config file is under /tmp or /var/tmp at ${configFilePath}, but ray-gateway.service uses PrivateTmp=true and temporary storage can be hidden or wiped. Install the rendered config somewhere persistent such as /etc/ray/ray.json.`,
      });
    } else if (preflight.configFileStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "config_file_missing",
        message: `The generated gateway config file was not found at ${configFilePath}. Install it before restarting ray-gateway.service.`,
      });
    } else if (preflight.configFileStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "config_file_unreadable",
        message: `The generated gateway config file at ${configFilePath} could not be inspected${preflight.configFileError ? ` (${preflight.configFileError})` : ""}. Doctor cannot verify that ray-gateway.service can load its config.`,
      });
    } else if (preflight.configFileAccessStatus === "blocked") {
      diagnostics.push({
        level: "error",
        code: "config_file_service_user_inaccessible",
        message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot read the generated gateway config file at ${configFilePath}${preflight.configFileAccessError ? ` (${preflight.configFileAccessError})` : ""}. Grant read access, for example with ${configFileOwnershipExample} ownership and mode 0640, before restarting ray-gateway.service.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "config_file_ok",
        message:
          preflight.configFileAccessStatus === "ok"
            ? `Generated gateway config file exists and is readable by "${preflight.serviceUser ?? "the configured service user"}" at ${configFilePath}.`
            : `Generated gateway config file exists at ${configFilePath}.`,
      });
    }
  }

  if (strictFilesystem && preflight?.gatewayRuntimeBinaryStatus !== undefined) {
    const runtimePath = preflight.gatewayRuntimeBinaryPath ?? "the configured gateway runtime";

    if (isSystemdProtectHomePath(runtimePath)) {
      diagnostics.push({
        level: "error",
        code: "gateway_runtime_home_protected",
        message: `The configured gateway runtime binary is under /home, /root, or /run/user at ${runtimePath}, but ray-gateway.service uses ProtectHome=true. Install Bun somewhere service-readable such as ${DEFAULT_GATEWAY_RUNTIME_BINARY} or pass --gateway-runtime-binary with that path.`,
      });
    } else if (isSystemdPrivateTmpPath(runtimePath)) {
      diagnostics.push({
        level: "error",
        code: "gateway_runtime_private_tmp",
        message: `The configured gateway runtime binary is under /tmp or /var/tmp at ${runtimePath}, but ray-gateway.service uses PrivateTmp=true and temporary storage can be hidden or wiped. Install Bun somewhere persistent such as ${DEFAULT_GATEWAY_RUNTIME_BINARY} or pass --gateway-runtime-binary with that path.`,
      });
    } else if (preflight.gatewayRuntimeBinaryStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "gateway_runtime_missing",
        message: `The configured gateway runtime binary was not found at ${runtimePath}. Install Bun at that path or pass --gateway-runtime-binary with the absolute runtime used by ray-gateway.service.`,
      });
    } else if (preflight.gatewayRuntimeBinaryStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "gateway_runtime_unreadable",
        message: `The configured gateway runtime binary at ${runtimePath} could not be used${preflight.gatewayRuntimeBinaryError ? ` (${preflight.gatewayRuntimeBinaryError})` : ""}. Doctor cannot verify that ray-gateway.service will start.`,
      });
    } else if (preflight.gatewayRuntimeBinaryAccessStatus === "blocked") {
      diagnostics.push({
        level: "error",
        code: "gateway_runtime_service_user_inaccessible",
        message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot execute the configured gateway runtime binary at ${runtimePath}${preflight.gatewayRuntimeBinaryAccessError ? ` (${preflight.gatewayRuntimeBinaryAccessError})` : ""}. Install Bun in a service-readable path such as ${DEFAULT_GATEWAY_RUNTIME_BINARY} or adjust ownership and mode bits before restarting ray-gateway.service.`,
      });
    } else {
      if (preflight.gatewayRuntimeKind === "node") {
        diagnostics.push({
          level: "warn",
          code: "gateway_runtime_node_fallback",
          message: `Gateway runtime at ${runtimePath} is Node.js. Bun at ${DEFAULT_GATEWAY_RUNTIME_BINARY} is Ray's preferred small-VPS runtime; keep Node only as a compatibility fallback when Bun is unavailable.`,
        });
      }

      if (preflight.gatewayRuntimeKind && preflight.gatewayRuntimeVersionStatus === "too_old") {
        const runtimeKind = formatGatewayRuntimeKind(preflight.gatewayRuntimeKind);
        const minimum = minimumGatewayRuntimeVersion(preflight.gatewayRuntimeKind).raw;
        diagnostics.push({
          level: "error",
          code: "gateway_runtime_version_unsupported",
          message: `Gateway runtime ${runtimeKind} at ${runtimePath} reports version ${
            preflight.gatewayRuntimeVersion ?? "unknown"
          }, but Ray requires ${runtimeKind} >= ${minimum}. Install a compatible runtime before restarting ray-gateway.service.`,
        });
      } else if (
        preflight.gatewayRuntimeKind &&
        preflight.gatewayRuntimeVersionStatus === "unreadable"
      ) {
        const runtimeKind = formatGatewayRuntimeKind(preflight.gatewayRuntimeKind);
        const minimum = minimumGatewayRuntimeVersion(preflight.gatewayRuntimeKind).raw;
        diagnostics.push({
          level: "error",
          code: "gateway_runtime_version_unreadable",
          message: `Doctor could not verify the ${runtimeKind} version from ${runtimePath}${
            preflight.gatewayRuntimeVersionError ? ` (${preflight.gatewayRuntimeVersionError})` : ""
          }. Ray requires ${runtimeKind} >= ${minimum} for the generated gateway service.`,
        });
      } else if (
        preflight.gatewayRuntimeKind &&
        preflight.gatewayRuntimeVersionStatus === "ok" &&
        preflight.gatewayRuntimeVersion
      ) {
        const runtimeKind = formatGatewayRuntimeKind(preflight.gatewayRuntimeKind);
        const minimum = minimumGatewayRuntimeVersion(preflight.gatewayRuntimeKind).raw;
        diagnostics.push({
          level: "info",
          code: "gateway_runtime_version_ok",
          message: `Gateway runtime ${runtimeKind} version ${preflight.gatewayRuntimeVersion} satisfies >= ${minimum} at ${runtimePath}.`,
        });
      }

      diagnostics.push({
        level: "info",
        code: "gateway_runtime_ok",
        message:
          preflight.gatewayRuntimeBinaryAccessStatus === "ok"
            ? `Gateway runtime binary is executable by "${preflight.serviceUser ?? "the configured service user"}" at ${runtimePath}.`
            : `Gateway runtime binary is executable at ${runtimePath}.`,
      });
    }
  }

  if (strictFilesystem && preflight?.gatewayEntrypointStatus !== undefined) {
    const entrypointPath = preflight.gatewayEntrypointPath ?? GATEWAY_ENTRYPOINT_RELATIVE_PATH;

    if (preflight.gatewayEntrypointStatus === "missing") {
      diagnostics.push({
        level: "error",
        code: "gateway_entrypoint_missing",
        message: `The built Ray gateway entrypoint was not found at ${entrypointPath}. Run bun run build before rendering or restarting ray-gateway.service.`,
      });
    } else if (preflight.gatewayEntrypointStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "gateway_entrypoint_unreadable",
        message: `The built Ray gateway entrypoint at ${entrypointPath} could not be inspected${preflight.gatewayEntrypointError ? ` (${preflight.gatewayEntrypointError})` : ""}. Doctor cannot verify that ray-gateway.service will start.`,
      });
    } else if (preflight.gatewayEntrypointAccessStatus === "blocked") {
      diagnostics.push({
        level: "error",
        code: "gateway_entrypoint_service_user_inaccessible",
        message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot read the built Ray gateway entrypoint at ${entrypointPath}${preflight.gatewayEntrypointAccessError ? ` (${preflight.gatewayEntrypointAccessError})` : ""}. Run chmod -R a+rX on the Ray checkout or adjust ownership before restarting ray-gateway.service.`,
      });
    } else {
      diagnostics.push({
        level: "info",
        code: "gateway_entrypoint_ok",
        message:
          preflight.gatewayEntrypointAccessStatus === "ok"
            ? `Built Ray gateway entrypoint exists and is readable by "${preflight.serviceUser ?? "the configured service user"}" at ${entrypointPath}.`
            : `Built Ray gateway entrypoint exists at ${entrypointPath}.`,
      });
    }
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
    if (config.asyncQueue.callbackAllowPrivateNetwork) {
      diagnostics.push({
        level: "warn",
        code: "async_callback_private_network_allowed",
        message:
          "asyncQueue.callbackAllowPrivateNetwork is enabled. Public VPS async queues should keep private, local, and non-global callback targets blocked; use callbackAllowedHosts for specific trusted callback hosts instead of a global private-network bypass.",
      });
    }

    if (config.asyncQueue.callbackAllowedHosts.length > 0) {
      diagnostics.push({
        level: "warn",
        code: "async_callback_hosts_allowlisted",
        message: `asyncQueue.callbackAllowedHosts trusts ${config.asyncQueue.callbackAllowedHosts.length} host pattern(s). Matching callback hosts bypass DNS/network address blocking, so keep the list limited to operator-owned callback endpoints.`,
      });
    }

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

    if (isSystemdProtectSystemReadOnlyPath(config.asyncQueue.storageDir)) {
      diagnostics.push({
        level: "error",
        code: "async_queue_storage_protect_system_readonly",
        message:
          "asyncQueue.storageDir is under /etc, /usr, or /boot, but the generated gateway service uses ProtectSystem=full and cannot write there. Use writable service state such as /var/lib/ray/async-queue.",
      });
    }

    if (preflight?.asyncQueueStorageStatus === "not_directory") {
      diagnostics.push({
        level: strictFilesystem ? "error" : "warn",
        code: "async_queue_storage_not_directory",
        message: `asyncQueue.storageDir cannot be created because ${preflight.asyncQueueStorageCheckPath ?? preflight.asyncQueueStoragePath ?? config.asyncQueue.storageDir} is not a directory.`,
      });
    } else if (strictFilesystem && preflight?.asyncQueueStorageStatus === "unreadable") {
      diagnostics.push({
        level: "error",
        code: "async_queue_storage_unreadable",
        message: `asyncQueue.storageDir free space could not be inspected at ${preflight.asyncQueueStorageCheckPath ?? preflight.asyncQueueStoragePath ?? config.asyncQueue.storageDir}${preflight.asyncQueueStorageError ? ` (${preflight.asyncQueueStorageError})` : ""}. Doctor cannot verify the async queue storage reserve.`,
      });
    } else if (
      strictFilesystem &&
      preflight?.asyncQueueStorageStatus !== undefined &&
      preflight.asyncQueueStorageAvailableMiB === undefined
    ) {
      diagnostics.push({
        level: "error",
        code: "async_queue_storage_unreadable",
        message: `asyncQueue.storageDir free space could not be resolved at ${preflight.asyncQueueStorageCheckPath ?? preflight.asyncQueueStoragePath ?? config.asyncQueue.storageDir}. Doctor cannot verify the async queue storage reserve.`,
      });
    } else if (
      strictFilesystem &&
      preflight?.asyncQueueStorageAccessStatus === "blocked" &&
      preflight.asyncQueueStorageStatus !== undefined &&
      preflight.asyncQueueStorageManagedByStateDirectory !== true
    ) {
      diagnostics.push({
        level: "error",
        code: "async_queue_storage_service_user_inaccessible",
        message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot ${
          preflight.asyncQueueStorageStatus === "directory"
            ? "write to asyncQueue.storageDir"
            : "create asyncQueue.storageDir from the nearest existing parent"
        } at ${preflight.asyncQueueStorageCheckPath ?? preflight.asyncQueueStoragePath ?? config.asyncQueue.storageDir}${preflight.asyncQueueStorageAccessError ? ` (${preflight.asyncQueueStorageAccessError})` : ""}. Adjust ownership or mode bits before accepting durable async jobs.`,
      });
    } else if (preflight?.asyncQueueStorageAvailableMiB !== undefined) {
      const storagePath = preflight.asyncQueueStoragePath ?? config.asyncQueue.storageDir;
      const checkedPath = preflight.asyncQueueStorageCheckPath ?? storagePath;

      if (preflight.asyncQueueStorageAvailableMiB < config.asyncQueue.minFreeStorageMiB) {
        diagnostics.push({
          level: strictFilesystem ? "error" : "warn",
          code: "async_queue_storage_low",
          message: `Async queue storage has ${formatMiB(preflight.asyncQueueStorageAvailableMiB)} free at ${checkedPath}, below asyncQueue.minFreeStorageMiB (${formatMiB(config.asyncQueue.minFreeStorageMiB)}) for ${storagePath}. Move the queue to a larger persistent volume or lower the reserve only after sizing the VPS disk.`,
        });
      } else {
        const writableStatus =
          preflight.asyncQueueStorageAccessStatus === "ok"
            ? `, and is writable by "${preflight.serviceUser ?? "the configured service user"}"`
            : preflight.asyncQueueStorageManagedByStateDirectory
              ? `, and StateDirectory=${RAY_STATE_DIRECTORY_NAME} will create ${RAY_STATE_DIRECTORY_PATH} for "${preflight.serviceUser ?? "the configured service user"}"`
              : "";
        diagnostics.push({
          level: "info",
          code: "async_queue_storage_ok",
          message: `Async queue storage has ${formatMiB(preflight.asyncQueueStorageAvailableMiB)} free at ${checkedPath}, satisfying asyncQueue.minFreeStorageMiB (${formatMiB(config.asyncQueue.minFreeStorageMiB)}) for ${storagePath}${
            writableStatus
          }.`,
        });
      }
    }
  }

  if (
    config.model.adapter.kind === "openai-compatible" ||
    config.model.adapter.kind === "llama.cpp"
  ) {
    const adapterBaseUrl = parseAdapterBaseUrl(config.model.adapter.baseUrl);
    if (adapterBaseUrl && adapterBaseUrlTargetsGatewaySocket(config, adapterBaseUrl)) {
      diagnostics.push({
        level: "error",
        code: "adapter_base_url_gateway_loop",
        message: `model.adapter.baseUrl (${config.model.adapter.baseUrl}) points at the Ray gateway listen socket (${config.server.host}:${config.server.port}). Point it at the model backend instead so inference requests do not recursively call the gateway.`,
      });
    }

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
      const expectedHostArchitecture = getExpectedHostArchitectureForPreset(launchProfile.preset);

      if (
        strictFilesystem &&
        expectedHostArchitecture !== undefined &&
        preflight?.hostArchitecture !== undefined
      ) {
        if (preflight.hostArchitecture !== expectedHostArchitecture) {
          diagnostics.push({
            level: "error",
            code: "llama_launch_profile_architecture_mismatch",
            message: `model.adapter.launchProfile.preset ${launchProfile.preset} expects a ${expectedHostArchitecture} host, but doctor detected ${preflight.hostArchitecture}. Use the matching public deploy profile before staging a llama.cpp binary.`,
          });
        } else {
          diagnostics.push({
            level: "info",
            code: "llama_launch_profile_architecture_ok",
            message: `model.adapter.launchProfile.preset ${launchProfile.preset} matches the detected ${preflight.hostArchitecture} host architecture.`,
          });
        }
      }

      if (!isLoopbackHost(launchProfile.host)) {
        diagnostics.push({
          level: "error",
          code: "llama_launch_host_public",
          message:
            "model.adapter.launchProfile.host is not loopback. Generated llama.cpp services should bind to 127.0.0.1 or localhost so Ray remains the public inference surface.",
        });
      }

      if (
        config.server.port === launchProfile.port &&
        localBindHostsOverlap(config.server.host, launchProfile.host)
      ) {
        diagnostics.push({
          level: "error",
          code: "gateway_llama_port_conflict",
          message: `server.host/server.port (${config.server.host}:${config.server.port}) overlaps model.adapter.launchProfile.host/port (${launchProfile.host}:${launchProfile.port}). The generated ray-gateway.service and ray-llama-cpp.service must listen on distinct local sockets before systemd restarts them.`,
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

      if (isSystemdPrivateTmpPath(launchProfile.binaryPath)) {
        diagnostics.push({
          level: "error",
          code: "llama_binary_path_private_tmp",
          message:
            "model.adapter.launchProfile.binaryPath is under /tmp or /var/tmp, but the generated llama.cpp service uses PrivateTmp=true and temporary storage can be hidden or wiped. Install llama-server somewhere persistent such as /usr/local/bin/llama-server.",
        });
      }

      if (strictFilesystem && preflight?.llamaCppBinaryStatus !== undefined) {
        const binaryPath = preflight.llamaCppBinaryPath ?? launchProfile.binaryPath;

        if (preflight.llamaCppBinaryStatus === "missing") {
          diagnostics.push({
            level: "error",
            code: "llama_binary_missing",
            message: `The configured llama.cpp binary was not found at ${binaryPath}. Install llama-server there or set RAY_LLAMA_CPP_BINARY_PATH before rendering the generated backend service.${formatModelStageApplyHint(env)}`,
          });
        } else if (preflight.llamaCppBinaryStatus === "unreadable") {
          diagnostics.push({
            level: "error",
            code: "llama_binary_unreadable",
            message: `The configured llama.cpp binary at ${binaryPath} could not be executed${preflight.llamaCppBinaryError ? ` (${preflight.llamaCppBinaryError})` : ""}. Doctor cannot verify that ray-llama-cpp.service will start.`,
          });
        } else if (preflight.llamaCppBinaryAccessStatus === "blocked") {
          diagnostics.push({
            level: "error",
            code: "llama_binary_service_user_inaccessible",
            message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot execute the configured llama.cpp binary at ${binaryPath}${preflight.llamaCppBinaryAccessError ? ` (${preflight.llamaCppBinaryAccessError})` : ""}. Adjust ownership or mode bits before restarting ray-llama-cpp.service.`,
          });
        } else {
          diagnostics.push({
            level: "info",
            code: "llama_binary_ok",
            message:
              preflight.llamaCppBinaryAccessStatus === "ok"
                ? `llama.cpp binary is executable by "${preflight.serviceUser ?? "the configured service user"}" at ${binaryPath}.`
                : `llama.cpp binary is executable at ${binaryPath}.`,
          });

          if (preflight.llamaCppBinaryProbeStatus === "failed") {
            diagnostics.push({
              level: "error",
              code: "llama_binary_probe_failed",
              message: `The configured llama.cpp binary at ${binaryPath} is executable but failed to start with --help${preflight.llamaCppBinaryProbeError ? ` (${preflight.llamaCppBinaryProbeError})` : ""}. This usually means a wrong CPU architecture or missing shared libraries; stage a compatible llama-server before restarting ray-llama-cpp.service.`,
            });
          } else if (preflight.llamaCppBinaryProbeStatus === "ok") {
            diagnostics.push({
              level: "info",
              code: "llama_binary_probe_ok",
              message: `llama.cpp binary starts successfully with --help at ${binaryPath}.`,
            });
          }
        }
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

      if (isSystemdPrivateTmpPath(launchProfile.modelPath)) {
        diagnostics.push({
          level: "error",
          code: "llama_model_path_private_tmp",
          message:
            "model.adapter.launchProfile.modelPath is under /tmp or /var/tmp, but the generated llama.cpp service uses PrivateTmp=true and temporary storage can be hidden or wiped. Store GGUF files somewhere persistent such as /var/lib/ray/models.",
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

      const hostCpuCount = preflight?.hostCpuCount;
      const llamaComputeThreads = Math.max(launchProfile.threads, launchProfile.threadsBatch ?? 0);
      if (hostCpuCount !== undefined && llamaComputeThreads > hostCpuCount) {
        diagnostics.push({
          level: "warn",
          code: "llama_threads_exceed_host_cpu",
          message: `llama.cpp is configured for ${llamaComputeThreads} compute thread(s), above the detected ${hostCpuCount} vCPU host. Lower RAY_LLAMA_CPP_THREADS or RAY_LLAMA_CPP_THREADS_BATCH on cheap VPS nodes to reduce CPU contention.`,
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
          message: `The configured GGUF model file was not found at ${preflight.modelFilePath}. Doctor cannot estimate memory fit without the real model file.${formatModelStageApplyHint(env)}`,
        });
      } else if (strictFilesystem && preflight?.modelFileStatus === "unreadable") {
        diagnostics.push({
          level: "error",
          code: "model_file_unreadable",
          message: `The configured GGUF model file at ${preflight.modelFilePath} could not be read${preflight.modelFileError ? ` (${preflight.modelFileError})` : ""}. Doctor cannot estimate memory fit without the real model file.`,
        });
      } else if (
        strictFilesystem &&
        preflight?.modelFileStatus === "found" &&
        preflight.modelFileFormatStatus === "invalid"
      ) {
        diagnostics.push({
          level: "error",
          code: "model_file_format_invalid",
          message: `The configured GGUF model file at ${preflight.modelFilePath} does not have a valid GGUF header${preflight.modelFileFormatError ? ` (${preflight.modelFileFormatError})` : ""}. Restage the model before restarting ray-llama-cpp.service.${formatModelStageApplyHint(env)}`,
        });
      } else if (
        strictFilesystem &&
        preflight?.modelFileStatus === "found" &&
        preflight.modelFileFormatStatus === "unreadable"
      ) {
        diagnostics.push({
          level: "error",
          code: "model_file_format_unreadable",
          message: `Doctor could not read the GGUF header from ${preflight.modelFilePath}${preflight.modelFileFormatError ? ` (${preflight.modelFileFormatError})` : ""}. Restage the model or verify it manually before restarting ray-llama-cpp.service.`,
        });
      } else if (
        strictFilesystem &&
        preflight?.modelFileStatus === "found" &&
        preflight.modelFileFormatStatus === "valid"
      ) {
        diagnostics.push({
          level: "info",
          code: "model_file_format_ok",
          message: `The configured GGUF model file at ${preflight.modelFilePath} has a valid GGUF header.`,
        });
      }

      if (
        strictFilesystem &&
        preflight?.modelFileStatus === "found" &&
        preflight.modelFileAccessStatus === "blocked"
      ) {
        diagnostics.push({
          level: "error",
          code: "model_file_service_user_inaccessible",
          message: `The generated systemd service user "${preflight.serviceUser ?? "the configured service user"}" cannot read the configured GGUF model file at ${preflight.modelFilePath}${preflight.modelFileAccessError ? ` (${preflight.modelFileAccessError})` : ""}. Adjust ownership or mode bits before restarting ray-llama-cpp.service.`,
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

      if (strictFilesystem && shouldRequireSwapCushion(launchProfile, preflight)) {
        if (preflight?.swapStatus === "missing" || preflight?.swapTotalMiB === 0) {
          diagnostics.push({
            level: "warn",
            code: "swap_missing",
            message:
              "No swap is configured on this small-VPS llama.cpp target. Add a modest swap file before sustained inference so the backend has an OOM cushion when memory spikes; `bun run swap:plan` prints guarded setup commands.",
          });
        } else if (
          preflight?.swapTotalMiB !== undefined &&
          preflight.swapTotalMiB < MIN_SMALL_VPS_SWAP_MIB
        ) {
          diagnostics.push({
            level: "warn",
            code: "swap_low",
            message: `Only ${formatMiB(
              preflight.swapTotalMiB,
            )} of swap is configured. Small 4 GB llama.cpp VPS deployments should keep at least ${formatMiB(
              MIN_SMALL_VPS_SWAP_MIB,
            )} of swap as a last-resort OOM cushion; bun run swap:plan -- --size-mib ${MIN_SMALL_VPS_SWAP_MIB} prints guarded setup commands.`,
          });
        } else if (preflight?.swapTotalMiB !== undefined) {
          diagnostics.push({
            level: "info",
            code: "swap_ok",
            message: `Swap is configured with ${formatMiB(
              preflight.swapTotalMiB,
            )} available as a last-resort cushion for this small-VPS llama.cpp profile.`,
          });
        } else if (preflight?.swapStatus === "unreadable") {
          diagnostics.push({
            level: "warn",
            code: "swap_unreadable",
            message: `Doctor could not inspect host swap from /proc/meminfo${
              preflight.swapError ? ` (${preflight.swapError})` : ""
            }. Verify swap manually before sustained inference on a 4 GB VPS.`,
          });
        }

        if (
          preflight?.swapStatus === "available" &&
          preflight.swapTotalMiB !== undefined &&
          preflight.swapTotalMiB > 0
        ) {
          if (preflight.swappiness !== undefined) {
            if (preflight.swappiness > MAX_SMALL_VPS_SWAPPINESS) {
              diagnostics.push({
                level: "warn",
                code: "swap_swappiness_high",
                message: `vm.swappiness is ${preflight.swappiness}. Small 4 GB llama.cpp VPS deployments should avoid eager swapping; bun run swap:plan -- --swappiness ${RECOMMENDED_SMALL_VPS_SWAPPINESS} prints guarded sysctl commands.`,
              });
            } else {
              diagnostics.push({
                level: "info",
                code: "swap_swappiness_ok",
                message: `vm.swappiness is ${preflight.swappiness}, which is conservative enough for this small-VPS llama.cpp profile.`,
              });
            }
          } else if (preflight.swappinessStatus === "unreadable") {
            diagnostics.push({
              level: "warn",
              code: "swap_swappiness_unreadable",
              message: `Doctor could not inspect vm.swappiness from /proc/sys/vm/swappiness${
                preflight.swappinessError ? ` (${preflight.swappinessError})` : ""
              }. Verify it manually or run bun run swap:plan -- --swappiness ${RECOMMENDED_SMALL_VPS_SWAPPINESS} before sustained inference on a 4 GB VPS.`,
            });
          }
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
  runtimeBinary?: string;
  user?: string;
  domain?: string;
  strictFilesystem?: boolean;
  nodeBinary?: string;
  allowMissingAuthKeys?: boolean;
  hostFiles?: DeploymentHostFilePaths;
  inspectHostStorage?: boolean;
  caddyBinary?: string;
}): Promise<{
  config: RayConfig;
  configPath?: string;
  diagnostics: DeploymentDiagnostic[];
  preflight: DeploymentPreflight;
}> {
  const loaded = await loadRayConfig({
    cwd: options.cwd,
    configPath: options.configPath,
    ...(options.env ? { env: options.env } : {}),
  });
  const preflight = await collectDeploymentPreflight(loaded.config, {
    cwd: options.cwd,
    ...(loaded.configPath !== undefined ? { configPath: loaded.configPath } : {}),
    ...(options.memoryBudgetMiB !== undefined ? { memoryBudgetMiB: options.memoryBudgetMiB } : {}),
    ...(options.runtimeBinary !== undefined ? { runtimeBinary: options.runtimeBinary } : {}),
    ...(options.nodeBinary !== undefined ? { nodeBinary: options.nodeBinary } : {}),
    ...(options.envFile !== undefined ? { envFile: options.envFile } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    ...(options.caddyBinary !== undefined ? { caddyBinary: options.caddyBinary } : {}),
    ...(options.strictFilesystem !== undefined
      ? { strictFilesystem: options.strictFilesystem }
      : {}),
    ...(options.hostFiles !== undefined ? { hostFiles: options.hostFiles } : {}),
    ...(options.inspectHostStorage !== undefined
      ? { inspectHostStorage: options.inspectHostStorage }
      : {}),
  });

  return {
    config: loaded.config,
    preflight,
    diagnostics: diagnoseConfig(loaded.config, options.env ?? process.env, options.envFile, {
      preflight,
      ...(options.strictFilesystem !== undefined
        ? { strictFilesystem: options.strictFilesystem }
        : {}),
      ...(options.allowMissingAuthKeys !== undefined
        ? { allowMissingAuthKeys: options.allowMissingAuthKeys }
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
  systemdEnvFile?: string;
  env?: NodeJS.ProcessEnv;
  memoryBudgetMiB?: number;
  runtimeBinary?: string;
  nodeBinary?: string;
  strictFilesystem?: boolean;
  inspectHostStorage?: boolean;
  caddyBinary?: string;
}): Promise<{
  service: string;
  caddyfile: string;
  envFileExample: string;
  llamaCppService?: string;
  summary: DeploymentBundleSummary;
}> {
  const cwd = path.resolve(options.cwd);
  const envFile = options.envFile ? path.resolve(cwd, options.envFile) : undefined;
  const systemdEnvFile = options.systemdEnvFile
    ? path.resolve(cwd, options.systemdEnvFile)
    : envFile;
  const allowMissingAuthKeys = options.systemdEnvFile !== undefined && envFile === undefined;
  const inspected = await loadAndDiagnoseDeployment({
    cwd,
    configPath: options.configPath,
    ...(options.env ? { env: options.env } : {}),
    domain: options.domain,
    ...(systemdEnvFile ? { envFile: systemdEnvFile } : {}),
    ...(options.memoryBudgetMiB !== undefined ? { memoryBudgetMiB: options.memoryBudgetMiB } : {}),
    ...(options.runtimeBinary !== undefined ? { runtimeBinary: options.runtimeBinary } : {}),
    ...(options.nodeBinary !== undefined ? { nodeBinary: options.nodeBinary } : {}),
    ...(options.caddyBinary !== undefined ? { caddyBinary: options.caddyBinary } : {}),
    ...(options.user !== undefined ? { user: options.user } : {}),
    ...(options.strictFilesystem !== undefined
      ? { strictFilesystem: options.strictFilesystem }
      : {}),
    ...(options.inspectHostStorage !== undefined
      ? { inspectHostStorage: options.inspectHostStorage }
      : {}),
    ...(allowMissingAuthKeys ? { allowMissingAuthKeys } : {}),
  });
  const renderedSystemd = renderDeploymentSystemdServices(inspected.config, inspected.preflight, {
    cwd,
    configPath: options.configPath,
    user: options.user,
    ...(options.runtimeBinary ? { runtimeBinary: options.runtimeBinary } : {}),
    ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
    ...(systemdEnvFile ? { envFile: systemdEnvFile } : {}),
  });
  const summaryConfig = sanitizeDeploymentSummaryConfig(inspected.config);

  return {
    service: renderedSystemd.service,
    caddyfile: renderCaddyfile({
      domain: options.domain,
      upstreamPort: inspected.config.server.port,
      requestBodyLimitBytes: inspected.config.server.requestBodyLimitBytes,
      upstreamTimeoutMs:
        inspected.config.scheduler.requestTimeoutMs + CADDY_UPSTREAM_TIMEOUT_GRACE_MS,
    }),
    envFileExample: renderEnvironmentFileExample(inspected.config),
    ...(renderedSystemd.llamaCppService
      ? {
          llamaCppService: renderedSystemd.llamaCppService,
        }
      : {}),
    summary: {
      ...summaryConfig,
      diagnostics: inspected.diagnostics,
      preflight: inspected.preflight,
      systemd: renderedSystemd.systemd,
    },
  };
}

function renderDeploymentSystemdServices(
  config: RayConfig,
  preflight: Pick<DeploymentPreflight, "memoryBudgetMiB">,
  options: {
    cwd: string;
    configPath: string;
    user: string;
    envFile?: string;
    runtimeBinary?: string;
    nodeBinary?: string;
  },
): {
  service: string;
  llamaCppService?: string;
  systemd: DeploymentBundleSummary["systemd"];
} {
  const stateDirectory = inferRayStateDirectory(config);
  const rendersLlamaCppService =
    config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile !== undefined;
  const gatewaySystemdControls = resolveGatewaySystemdControls(config);
  const llamaCppSystemdControls =
    config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile
      ? resolveLlamaCppSystemdControls(config.model.adapter.launchProfile, preflight)
      : undefined;
  const service = renderSystemdService({
    workingDirectory: options.cwd,
    configPath: options.configPath,
    user: options.user,
    ...gatewaySystemdControls,
    ...(options.runtimeBinary ? { runtimeBinary: options.runtimeBinary } : {}),
    ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
    ...(options.envFile ? { envFile: options.envFile } : {}),
    ...(stateDirectory ? { stateDirectory } : {}),
    ...(rendersLlamaCppService
      ? {
          after: [LLAMA_CPP_SYSTEMD_SERVICE],
          wants: [LLAMA_CPP_SYSTEMD_SERVICE],
        }
      : {}),
  });
  const llamaCppService =
    config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile
      ? renderLlamaCppService({
          user: options.user,
          launchProfile: config.model.adapter.launchProfile,
          ...(llamaCppSystemdControls ? llamaCppSystemdControls : {}),
        })
      : undefined;

  return {
    service,
    ...(llamaCppService ? { llamaCppService } : {}),
    systemd: {
      gateway: gatewaySystemdControls,
      ...(llamaCppSystemdControls ? { llamaCpp: llamaCppSystemdControls } : {}),
    },
  };
}

async function collectAsyncQueueStoragePreflight(
  config: RayConfig,
  serviceUserIdentity: ServiceUserIdentity | undefined,
): Promise<Partial<DeploymentPreflight>> {
  if (!config.asyncQueue.enabled) {
    return {};
  }

  const storagePath = path.resolve(config.asyncQueue.storageDir);
  let checkPath = storagePath;

  while (true) {
    try {
      const pathStat = await stat(checkPath);

      if (!pathStat.isDirectory()) {
        return {
          asyncQueueStoragePath: storagePath,
          asyncQueueStorageCheckPath: checkPath,
          asyncQueueStorageStatus: "not_directory",
          asyncQueueStorageError: "not a directory",
        };
      }

      const storageStats = await statfs(checkPath);
      const availableMiB = resolveAvailableStorageMiB(storageStats);
      const storageStatus = checkPath === storagePath ? "directory" : "parent";
      const managedByStateDirectory =
        storageStatus === "parent" && isRayStateDirectoryCreationPath(storagePath, checkPath);
      const serviceUserAccess = serviceUserIdentity
        ? managedByStateDirectory
          ? undefined
          : await verifyServiceUserPathAccess(
              checkPath,
              serviceUserIdentity,
              storageStatus === "directory" ? 0o7 : 0o3,
              storageStatus === "directory" ? "read/write/execute" : "write/execute",
            )
        : undefined;

      return {
        asyncQueueStoragePath: storagePath,
        asyncQueueStorageCheckPath: checkPath,
        asyncQueueStorageStatus: storageStatus,
        ...(availableMiB !== undefined ? { asyncQueueStorageAvailableMiB: availableMiB } : {}),
        ...(managedByStateDirectory ? { asyncQueueStorageManagedByStateDirectory: true } : {}),
        ...(serviceUserAccess
          ? {
              asyncQueueStorageAccessStatus: serviceUserAccess.status,
              ...(serviceUserAccess.error
                ? { asyncQueueStorageAccessError: serviceUserAccess.error }
                : {}),
            }
          : {}),
      };
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;

      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          asyncQueueStoragePath: storagePath,
          asyncQueueStorageCheckPath: checkPath,
          asyncQueueStorageStatus: "unreadable",
          asyncQueueStorageError: toErrorMessage(error),
        };
      }

      const parent = path.dirname(checkPath);
      if (parent === checkPath) {
        return {
          asyncQueueStoragePath: storagePath,
          asyncQueueStorageCheckPath: checkPath,
          asyncQueueStorageStatus: "unreadable",
          asyncQueueStorageError: toErrorMessage(error),
        };
      }

      checkPath = parent;
    }
  }
}

async function collectEnvFilePreflight(
  envFile: string | undefined,
): Promise<Partial<DeploymentPreflight>> {
  if (envFile === undefined) {
    return {};
  }

  if (!path.isAbsolute(envFile)) {
    return {
      envFilePath: envFile,
      envFileStatus: "unreadable",
      envFileError: "EnvironmentFile path must be absolute",
    };
  }

  try {
    const envFileStat = await stat(envFile);

    if (!envFileStat.isFile()) {
      return {
        envFilePath: envFile,
        envFileStatus: "unreadable",
        envFileError: "not a regular file",
      };
    }

    return {
      envFilePath: envFile,
      envFileStatus: "found",
      envFileMode: envFileStat.mode & 0o777,
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      envFilePath: envFile,
      envFileStatus: code === "ENOENT" ? "missing" : "unreadable",
      envFileError: toErrorMessage(error),
    };
  }
}

async function collectServiceUserPreflight(
  user: string | undefined,
  strictFilesystem: boolean,
  hostFiles: DeploymentHostFilePaths = {},
): Promise<Partial<DeploymentPreflight>> {
  if (user === undefined) {
    return {};
  }

  if (!strictFilesystem) {
    return { serviceUser: user };
  }

  try {
    const passwd = await readTextFileBounded(
      hostFiles.passwd ?? HOST_PASSWD_PATH,
      MAX_HOST_IDENTITY_FILE_BYTES,
      "host passwd",
    );
    const identity = resolvePasswdUser(passwd, user);

    if (!identity) {
      return {
        serviceUser: user,
        serviceUserStatus: "missing",
      };
    }

    let serviceUserPrimaryGroup: string | undefined;

    try {
      const groupFile = await readTextFileBounded(
        hostFiles.group ?? HOST_GROUP_PATH,
        MAX_HOST_IDENTITY_FILE_BYTES,
        "host group",
      );
      serviceUserPrimaryGroup = resolveGroupNameByGid(groupFile, identity.gid);
      identity.groupIds = parseSupplementaryGroupIds(groupFile, identity.name, identity.gid);
    } catch {
      // The primary gid from /etc/passwd is enough for conservative mode-bit checks.
    }

    return {
      serviceUser: user,
      serviceUserStatus: "found",
      serviceUserUid: identity.uid,
      serviceUserGid: identity.gid,
      ...(serviceUserPrimaryGroup ? { serviceUserPrimaryGroup } : {}),
      serviceUserGroupIds: identity.groupIds,
    };
  } catch (error) {
    return {
      serviceUser: user,
      serviceUserStatus: "unreadable",
      serviceUserError: toErrorMessage(error),
    };
  }
}

async function collectSystemdPreflight(
  strictFilesystem: boolean,
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem) {
    return {};
  }

  try {
    const runtimeDirectoryStat = await stat(SYSTEMD_RUNTIME_DIRECTORY);

    if (!runtimeDirectoryStat.isDirectory()) {
      return {
        systemdStatus: "missing",
        systemdError: `${SYSTEMD_RUNTIME_DIRECTORY} is not a directory`,
      };
    }
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      systemdStatus: code === "ENOENT" ? "missing" : "unreadable",
      systemdError: toErrorMessage(error),
    };
  }

  return await new Promise<Partial<DeploymentPreflight>>((resolve) => {
    execFile(
      "systemctl",
      ["--version"],
      {
        timeout: SYSTEMCTL_VERSION_TIMEOUT_MS,
        maxBuffer: SYSTEMCTL_VERSION_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();

        if (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as { code?: string }).code
              : undefined;

          resolve({
            systemdStatus: code === "ENOENT" ? "missing" : "unreadable",
            systemdError: output
              ? `${toErrorMessage(error)}; output: ${truncateRuntimeVersionOutput(output)}`
              : toErrorMessage(error),
          });
          return;
        }

        const systemdVersion = parseCommandVersionOutput(output);
        resolve({
          systemdStatus: "available",
          ...(systemdVersion ? { systemdVersion } : {}),
        });
      },
    );
  });
}

async function runSystemdAnalyzeVerify(
  unitPaths: string[],
  unitDirectory: string,
): Promise<Partial<DeploymentPreflight>> {
  return await new Promise<Partial<DeploymentPreflight>>((resolve) => {
    execFile(
      "systemd-analyze",
      ["verify", ...unitPaths],
      {
        timeout: SYSTEMD_ANALYZE_VERIFY_TIMEOUT_MS,
        maxBuffer: SYSTEMD_ANALYZE_VERIFY_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          SYSTEMD_UNIT_PATH: process.env.SYSTEMD_UNIT_PATH
            ? `${unitDirectory}${path.delimiter}${process.env.SYSTEMD_UNIT_PATH}`
            : `${unitDirectory}${path.delimiter}`,
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();

        if (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as { code?: string }).code
              : undefined;

          resolve({
            systemdUnitStatus: code === "ENOENT" ? "unreadable" : "invalid",
            systemdUnitError: output
              ? `${toErrorMessage(error)}; output: ${truncateRuntimeVersionOutput(output)}`
              : toErrorMessage(error),
          });
          return;
        }

        resolve({ systemdUnitStatus: "valid" });
      },
    );
  });
}

async function collectSystemdUnitPreflight(
  config: RayConfig,
  preflight: Pick<DeploymentPreflight, "memoryBudgetMiB">,
  options: {
    cwd: string;
    configPath?: string;
    envFile?: string;
    runtimeBinary?: string;
    user?: string;
    nodeBinary?: string;
    strictFilesystem?: boolean;
  },
  systemdStatus: SystemdHostStatus | undefined,
): Promise<Partial<DeploymentPreflight>> {
  if (
    options.strictFilesystem !== true ||
    systemdStatus !== "available" ||
    options.user === undefined ||
    options.configPath === undefined
  ) {
    return {};
  }

  let renderedSystemd: ReturnType<typeof renderDeploymentSystemdServices>;
  try {
    renderedSystemd = renderDeploymentSystemdServices(config, preflight, {
      cwd: options.cwd,
      configPath: options.configPath,
      user: options.user,
      ...(options.envFile ? { envFile: options.envFile } : {}),
      ...(options.runtimeBinary ? { runtimeBinary: options.runtimeBinary } : {}),
      ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
    });
  } catch (error) {
    return {
      systemdUnitStatus: "invalid",
      systemdUnitError: toErrorMessage(error),
    };
  }

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "ray-systemd-verify-"));
  try {
    const gatewayUnitPath = path.join(tempDirectory, "ray-gateway.service");
    await writeFile(gatewayUnitPath, renderedSystemd.service, "utf8");

    const unitPaths = [gatewayUnitPath];
    if (renderedSystemd.llamaCppService) {
      const llamaUnitPath = path.join(tempDirectory, LLAMA_CPP_SYSTEMD_SERVICE);
      await writeFile(llamaUnitPath, renderedSystemd.llamaCppService, "utf8");
      unitPaths.push(llamaUnitPath);
    }

    return await runSystemdAnalyzeVerify(unitPaths, tempDirectory);
  } catch (error) {
    return {
      systemdUnitStatus: "unreadable",
      systemdUnitError: toErrorMessage(error),
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function collectCaddyPreflight(
  strictFilesystem: boolean,
  caddyBinary = "caddy",
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem) {
    return {};
  }

  return await new Promise<Partial<DeploymentPreflight>>((resolve) => {
    execFile(
      caddyBinary,
      ["version"],
      {
        timeout: CADDY_VERSION_TIMEOUT_MS,
        maxBuffer: CADDY_VERSION_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();

        if (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as { code?: string }).code
              : undefined;

          resolve({
            caddyStatus: code === "ENOENT" ? "missing" : "unreadable",
            caddyBinaryPath: caddyBinary,
            caddyError: output
              ? `${toErrorMessage(error)}; output: ${truncateRuntimeVersionOutput(output)}`
              : toErrorMessage(error),
          });
          return;
        }

        const caddyVersion = parseCommandVersionOutput(output);
        resolve({
          caddyStatus: "available",
          caddyBinaryPath: caddyBinary,
          ...(caddyVersion ? { caddyVersion } : {}),
        });
      },
    );
  });
}

async function runCaddyValidate(
  configPath: string,
  caddyBinary: string,
): Promise<Partial<DeploymentPreflight>> {
  return await new Promise<Partial<DeploymentPreflight>>((resolve) => {
    execFile(
      caddyBinary,
      ["validate", "--config", configPath],
      {
        timeout: CADDY_VALIDATE_TIMEOUT_MS,
        maxBuffer: CADDY_VALIDATE_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();

        if (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as { code?: string }).code
              : undefined;

          resolve({
            caddyConfigStatus: code === "ENOENT" ? "unreadable" : "invalid",
            caddyConfigError: output
              ? `${toErrorMessage(error)}; output: ${truncateRuntimeVersionOutput(output)}`
              : toErrorMessage(error),
          });
          return;
        }

        resolve({ caddyConfigStatus: "valid" });
      },
    );
  });
}

async function collectCaddyConfigPreflight(
  config: RayConfig,
  domain: string,
  strictFilesystem: boolean,
  caddyStatus: CaddyRuntimeStatus | undefined,
  caddyBinary = "caddy",
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem || caddyStatus !== "available") {
    return {};
  }

  let caddyfile: string;
  try {
    caddyfile = renderCaddyfile({
      domain,
      upstreamPort: config.server.port,
      requestBodyLimitBytes: config.server.requestBodyLimitBytes,
      upstreamTimeoutMs: config.scheduler.requestTimeoutMs + CADDY_UPSTREAM_TIMEOUT_GRACE_MS,
    });
  } catch (error) {
    return {
      caddyConfigStatus: "invalid",
      caddyConfigError: toErrorMessage(error),
    };
  }

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "ray-caddy-validate-"));
  try {
    const caddyfilePath = path.join(tempDirectory, "Caddyfile");
    await writeFile(caddyfilePath, caddyfile, "utf8");
    return await runCaddyValidate(caddyfilePath, caddyBinary);
  } catch (error) {
    return {
      caddyConfigStatus: "unreadable",
      caddyConfigError: toErrorMessage(error),
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function collectWorkingDirectoryPreflight(
  cwd: string,
  strictFilesystem: boolean,
  serviceUserIdentity: ServiceUserIdentity | undefined,
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem) {
    return {};
  }

  const workingDirectoryPath = path.resolve(cwd);

  try {
    const workingDirectoryStat = await stat(workingDirectoryPath);

    if (!workingDirectoryStat.isDirectory()) {
      return {
        workingDirectoryPath,
        workingDirectoryStatus: "not_directory",
        workingDirectoryError: "not a directory",
      };
    }

    let storagePreflight: Partial<DeploymentPreflight>;
    try {
      const storageStats = await statfs(workingDirectoryPath);
      const availableMiB = resolveAvailableStorageMiB(storageStats);
      storagePreflight =
        availableMiB === undefined
          ? {
              workingDirectoryStorageStatus: "unreadable",
              workingDirectoryStorageError: "free space could not be resolved",
            }
          : {
              workingDirectoryStorageStatus: "available",
              workingDirectoryAvailableMiB: availableMiB,
            };
    } catch (error) {
      storagePreflight = {
        workingDirectoryStorageStatus: "unreadable",
        workingDirectoryStorageError: toErrorMessage(error),
      };
    }

    const serviceUserAccess = serviceUserIdentity
      ? await verifyServiceUserPathAccess(
          workingDirectoryPath,
          serviceUserIdentity,
          0o5,
          "read/execute",
        )
      : undefined;

    return {
      workingDirectoryPath,
      workingDirectoryStatus: "found",
      ...storagePreflight,
      ...(serviceUserAccess
        ? {
            workingDirectoryAccessStatus: serviceUserAccess.status,
            ...(serviceUserAccess.error
              ? { workingDirectoryAccessError: serviceUserAccess.error }
              : {}),
          }
        : {}),
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      workingDirectoryPath,
      workingDirectoryStatus: code === "ENOENT" ? "missing" : "unreadable",
      workingDirectoryError: toErrorMessage(error),
    };
  }
}

async function collectGatewayRuntimePreflight(
  runtimeBinary: string | undefined,
  serviceUserIdentity: ServiceUserIdentity | undefined,
  strictFilesystem: boolean,
): Promise<Partial<DeploymentPreflight>> {
  if (runtimeBinary === undefined) {
    return {};
  }

  if (!path.isAbsolute(runtimeBinary)) {
    return {
      gatewayRuntimeBinaryPath: runtimeBinary,
      gatewayRuntimeBinaryStatus: "unreadable",
      gatewayRuntimeBinaryError: "runtime binary path must be absolute",
    };
  }

  try {
    const runtimeKind = identifyGatewayRuntimeKind(runtimeBinary);
    const runtimeStat = await stat(runtimeBinary);

    if (!runtimeStat.isFile()) {
      return {
        gatewayRuntimeBinaryPath: runtimeBinary,
        gatewayRuntimeBinaryStatus: "unreadable",
        gatewayRuntimeBinaryError: "not a regular file",
      };
    }

    await access(runtimeBinary, constants.X_OK);
    const serviceUserAccess = serviceUserIdentity
      ? await verifyServiceUserPathAccess(runtimeBinary, serviceUserIdentity, 0o1, "execute")
      : undefined;
    const versionPreflight =
      strictFilesystem && runtimeKind
        ? await collectGatewayRuntimeVersionPreflight(runtimeBinary, runtimeKind)
        : runtimeKind
          ? { gatewayRuntimeKind: runtimeKind }
          : {};

    return {
      gatewayRuntimeBinaryPath: runtimeBinary,
      gatewayRuntimeBinaryStatus: "found",
      ...versionPreflight,
      ...(serviceUserAccess
        ? {
            gatewayRuntimeBinaryAccessStatus: serviceUserAccess.status,
            ...(serviceUserAccess.error
              ? { gatewayRuntimeBinaryAccessError: serviceUserAccess.error }
              : {}),
          }
        : {}),
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      gatewayRuntimeBinaryPath: runtimeBinary,
      gatewayRuntimeBinaryStatus: code === "ENOENT" ? "missing" : "unreadable",
      gatewayRuntimeBinaryError: toErrorMessage(error),
    };
  }
}

async function collectGatewayRuntimeVersionPreflight(
  runtimeBinary: string,
  runtimeKind: GatewayRuntimeKind,
): Promise<Partial<DeploymentPreflight>> {
  return await new Promise<Partial<DeploymentPreflight>>((resolve) => {
    execFile(
      runtimeBinary,
      ["--version"],
      {
        timeout: GATEWAY_RUNTIME_VERSION_TIMEOUT_MS,
        maxBuffer: GATEWAY_RUNTIME_VERSION_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        const basePreflight = {
          gatewayRuntimeKind: runtimeKind,
        };

        if (error) {
          resolve({
            ...basePreflight,
            gatewayRuntimeVersionStatus: "unreadable",
            gatewayRuntimeVersionError: output
              ? `${toErrorMessage(error)}; output: ${truncateRuntimeVersionOutput(output)}`
              : toErrorMessage(error),
          });
          return;
        }

        const parsed = parseRuntimeVersion(output);
        if (!parsed) {
          resolve({
            ...basePreflight,
            gatewayRuntimeVersionStatus: "unreadable",
            gatewayRuntimeVersionError: output
              ? `could not parse version output: ${truncateRuntimeVersionOutput(output)}`
              : "runtime produced no version output",
          });
          return;
        }

        const minimum = minimumGatewayRuntimeVersion(runtimeKind);
        resolve({
          ...basePreflight,
          gatewayRuntimeVersion: parsed.raw,
          gatewayRuntimeVersionStatus:
            compareRuntimeVersions(parsed.tuple, minimum.tuple) < 0 ? "too_old" : "ok",
        });
      },
    );
  });
}

async function collectGatewayEntrypointPreflight(
  cwd: string,
  strictFilesystem: boolean,
  serviceUserIdentity: ServiceUserIdentity | undefined,
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem) {
    return {};
  }

  const entrypointPath = path.resolve(cwd, GATEWAY_ENTRYPOINT_RELATIVE_PATH);

  try {
    const entrypointStat = await stat(entrypointPath);

    if (!entrypointStat.isFile()) {
      return {
        gatewayEntrypointPath: entrypointPath,
        gatewayEntrypointStatus: "unreadable",
        gatewayEntrypointError: "not a regular file",
      };
    }

    const serviceUserAccess = serviceUserIdentity
      ? await verifyServiceUserPathAccess(entrypointPath, serviceUserIdentity, 0o4, "read")
      : undefined;

    return {
      gatewayEntrypointPath: entrypointPath,
      gatewayEntrypointStatus: "found",
      ...(serviceUserAccess
        ? {
            gatewayEntrypointAccessStatus: serviceUserAccess.status,
            ...(serviceUserAccess.error
              ? { gatewayEntrypointAccessError: serviceUserAccess.error }
              : {}),
          }
        : {}),
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      gatewayEntrypointPath: entrypointPath,
      gatewayEntrypointStatus: code === "ENOENT" ? "missing" : "unreadable",
      gatewayEntrypointError: toErrorMessage(error),
    };
  }
}

async function collectConfigFilePreflight(
  configPath: string | undefined,
  strictFilesystem: boolean,
  serviceUserIdentity: ServiceUserIdentity | undefined,
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem || configPath === undefined) {
    return {};
  }

  const resolvedConfigPath = path.resolve(configPath);

  try {
    const configFileStat = await stat(resolvedConfigPath);

    if (!configFileStat.isFile()) {
      return {
        configFilePath: resolvedConfigPath,
        configFileStatus: "unreadable",
        configFileError: "not a regular file",
      };
    }

    const serviceUserAccess = serviceUserIdentity
      ? await verifyServiceUserPathAccess(resolvedConfigPath, serviceUserIdentity, 0o4, "read")
      : undefined;

    return {
      configFilePath: resolvedConfigPath,
      configFileStatus: "found",
      ...(serviceUserAccess
        ? {
            configFileAccessStatus: serviceUserAccess.status,
            ...(serviceUserAccess.error ? { configFileAccessError: serviceUserAccess.error } : {}),
          }
        : {}),
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      configFilePath: resolvedConfigPath,
      configFileStatus: code === "ENOENT" ? "missing" : "unreadable",
      configFileError: toErrorMessage(error),
    };
  }
}

async function collectLlamaCppBinaryPreflight(
  launchProfile: LlamaCppLaunchProfile,
  serviceUserIdentity: ServiceUserIdentity | undefined,
  strictFilesystem: boolean,
): Promise<Partial<DeploymentPreflight>> {
  const binaryPath = launchProfile.binaryPath;

  if (!path.isAbsolute(binaryPath)) {
    return {
      llamaCppBinaryPath: binaryPath,
      llamaCppBinaryStatus: "unreadable",
      llamaCppBinaryError: "binary path must be absolute",
    };
  }

  try {
    const binaryStat = await stat(binaryPath);

    if (!binaryStat.isFile()) {
      return {
        llamaCppBinaryPath: binaryPath,
        llamaCppBinaryStatus: "unreadable",
        llamaCppBinaryError: "not a regular file",
      };
    }

    await access(binaryPath, constants.X_OK);

    const serviceUserAccess = serviceUserIdentity
      ? await verifyServiceUserPathAccess(binaryPath, serviceUserIdentity, 0o1, "execute")
      : undefined;
    const probePreflight = strictFilesystem
      ? await collectLlamaCppBinaryProbePreflight(binaryPath)
      : {};

    return {
      llamaCppBinaryPath: binaryPath,
      llamaCppBinaryStatus: "found",
      ...probePreflight,
      ...(serviceUserAccess
        ? {
            llamaCppBinaryAccessStatus: serviceUserAccess.status,
            ...(serviceUserAccess.error
              ? { llamaCppBinaryAccessError: serviceUserAccess.error }
              : {}),
          }
        : {}),
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    return {
      llamaCppBinaryPath: binaryPath,
      llamaCppBinaryStatus: code === "ENOENT" ? "missing" : "unreadable",
      llamaCppBinaryError: toErrorMessage(error),
    };
  }
}

async function collectGgufModelFileFormatPreflight(
  modelPath: string,
  strictFilesystem: boolean,
): Promise<Partial<DeploymentPreflight>> {
  if (!strictFilesystem) {
    return {};
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(modelPath, "r");
    const magic = Buffer.from(GGUF_MAGIC, "ascii");
    const buffer = Buffer.alloc(magic.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead < magic.length) {
      return {
        modelFileFormatStatus: "invalid",
        modelFileFormatError: `file is smaller than the ${GGUF_MAGIC} header`,
      };
    }

    if (!buffer.equals(magic)) {
      return {
        modelFileFormatStatus: "invalid",
        modelFileFormatError: `expected ${GGUF_MAGIC} magic header`,
      };
    }

    return { modelFileFormatStatus: "valid" };
  } catch (error) {
    return {
      modelFileFormatStatus: "unreadable",
      modelFileFormatError: toErrorMessage(error),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function collectLlamaCppBinaryProbePreflight(
  binaryPath: string,
): Promise<Partial<DeploymentPreflight>> {
  return await new Promise<Partial<DeploymentPreflight>>((resolve) => {
    execFile(
      binaryPath,
      ["--help"],
      {
        timeout: LLAMA_CPP_BINARY_PROBE_TIMEOUT_MS,
        maxBuffer: LLAMA_CPP_BINARY_PROBE_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();

        if (error) {
          resolve({
            llamaCppBinaryProbeStatus: "failed",
            llamaCppBinaryProbeError: output
              ? `${toErrorMessage(error)}; output: ${truncateRuntimeVersionOutput(output)}`
              : toErrorMessage(error),
          });
          return;
        }

        resolve({
          llamaCppBinaryProbeStatus: "ok",
        });
      },
    );
  });
}

async function collectSwapPreflight(
  hostFiles: DeploymentHostFilePaths = {},
): Promise<Partial<DeploymentPreflight>> {
  const swappinessPreflight = await collectSwappinessPreflight(hostFiles);

  try {
    const meminfo = await readTextFileBounded(
      hostFiles.meminfo ?? HOST_MEMINFO_PATH,
      MAX_HOST_MEMINFO_FILE_BYTES,
      "host meminfo",
    );
    const swapTotalMiB = parseSwapTotalMiB(meminfo);

    if (swapTotalMiB === undefined) {
      return {
        ...swappinessPreflight,
        swapStatus: "unreadable",
        swapError: "SwapTotal was not present in /proc/meminfo",
      };
    }

    return {
      ...swappinessPreflight,
      swapStatus: swapTotalMiB > 0 ? "available" : "missing",
      swapTotalMiB,
    };
  } catch (error) {
    return {
      ...swappinessPreflight,
      swapStatus: "unreadable",
      swapError: toErrorMessage(error),
    };
  }
}

async function collectSwappinessPreflight(
  hostFiles: DeploymentHostFilePaths = {},
): Promise<Partial<DeploymentPreflight>> {
  try {
    const contents = await readTextFileBounded(
      hostFiles.swappiness ?? HOST_SWAPPINESS_PATH,
      MAX_HOST_SWAPPINESS_FILE_BYTES,
      "host swappiness",
    );
    const swappiness = parseNonNegativeInteger(contents.trim());

    if (swappiness === undefined) {
      return {
        swappinessStatus: "unreadable",
        swappinessError: "vm.swappiness did not contain a non-negative integer",
      };
    }

    return {
      swappinessStatus: "available",
      swappiness,
    };
  } catch (error) {
    return {
      swappinessStatus: "unreadable",
      swappinessError: toErrorMessage(error),
    };
  }
}

async function collectDeploymentPreflight(
  config: RayConfig,
  options: {
    cwd: string;
    configPath?: string;
    memoryBudgetMiB?: number;
    runtimeBinary?: string;
    envFile?: string;
    user?: string;
    domain?: string;
    strictFilesystem?: boolean;
    nodeBinary?: string;
    hostFiles?: DeploymentHostFilePaths;
    inspectHostStorage?: boolean;
    caddyBinary?: string;
  },
): Promise<DeploymentPreflight> {
  const hostMemoryMiB = Math.max(1, Math.floor(totalmem() / BYTES_PER_MIB));
  const hostCpuCount = collectHostCpuCount();
  const hostArchitecture = process.arch;
  const systemdPreflight = await collectSystemdPreflight(options.strictFilesystem === true);
  const caddyBinary = options.caddyBinary ?? "caddy";
  const caddyPreflight = await collectCaddyPreflight(
    options.strictFilesystem === true,
    caddyBinary,
  );
  const caddySiteAddressPreflight =
    options.domain !== undefined ? { caddySiteAddress: options.domain } : {};
  const caddyConfigPreflight = await collectCaddyConfigPreflight(
    config,
    options.domain ?? "ray.local",
    options.strictFilesystem === true,
    caddyPreflight.caddyStatus,
    caddyBinary,
  );
  const envFilePreflight = await collectEnvFilePreflight(options.envFile);
  const serviceUserPreflight = await collectServiceUserPreflight(
    options.user,
    options.strictFilesystem === true,
    options.hostFiles,
  );
  const serviceUserIdentity =
    serviceUserPreflight.serviceUserStatus === "found" &&
    serviceUserPreflight.serviceUser !== undefined &&
    serviceUserPreflight.serviceUserUid !== undefined &&
    serviceUserPreflight.serviceUserGid !== undefined
      ? {
          name: serviceUserPreflight.serviceUser,
          uid: serviceUserPreflight.serviceUserUid,
          gid: serviceUserPreflight.serviceUserGid,
          groupIds: serviceUserPreflight.serviceUserGroupIds ?? [
            serviceUserPreflight.serviceUserGid,
          ],
        }
      : undefined;
  const configFilePreflight = await collectConfigFilePreflight(
    options.configPath,
    options.strictFilesystem === true,
    serviceUserIdentity,
  );
  const storagePreflight =
    options.strictFilesystem === true || options.inspectHostStorage !== false
      ? await collectAsyncQueueStoragePreflight(config, serviceUserIdentity)
      : {};
  const workingDirectoryPreflight = await collectWorkingDirectoryPreflight(
    options.cwd,
    options.strictFilesystem === true,
    serviceUserIdentity,
  );
  const gatewayEntrypointPreflight = await collectGatewayEntrypointPreflight(
    options.cwd,
    options.strictFilesystem === true,
    serviceUserIdentity,
  );
  const runtimeBinary =
    options.runtimeBinary ??
    options.nodeBinary ??
    (options.strictFilesystem === true ? DEFAULT_GATEWAY_RUNTIME_BINARY : undefined);
  const runtimePreflight = await collectGatewayRuntimePreflight(
    runtimeBinary,
    serviceUserIdentity,
    options.strictFilesystem === true,
  );
  const swapPreflight = await collectSwapPreflight(options.hostFiles);

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    const preflight: DeploymentPreflight = {
      hostMemoryMiB,
      ...(hostCpuCount !== undefined ? { hostCpuCount } : {}),
      hostArchitecture,
      ...storagePreflight,
      ...caddySiteAddressPreflight,
      ...systemdPreflight,
      ...caddyPreflight,
      ...caddyConfigPreflight,
      ...envFilePreflight,
      ...serviceUserPreflight,
      ...configFilePreflight,
      ...workingDirectoryPreflight,
      ...gatewayEntrypointPreflight,
      ...runtimePreflight,
      ...swapPreflight,
    };
    const systemdUnitPreflight = await collectSystemdUnitPreflight(
      config,
      preflight,
      {
        cwd: options.cwd,
        ...(options.configPath ? { configPath: options.configPath } : {}),
        ...(options.envFile ? { envFile: options.envFile } : {}),
        ...(runtimeBinary ? { runtimeBinary } : {}),
        ...(options.user ? { user: options.user } : {}),
        ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
        ...(options.strictFilesystem !== undefined
          ? { strictFilesystem: options.strictFilesystem }
          : {}),
      },
      systemdPreflight.systemdStatus,
    );

    return {
      ...preflight,
      ...systemdUnitPreflight,
    };
  }

  const launchProfile = config.model.adapter.launchProfile;
  const llamaBinaryPreflight = await collectLlamaCppBinaryPreflight(
    launchProfile,
    serviceUserIdentity,
    options.strictFilesystem === true,
  );
  const budget = resolveMemoryBudget({
    preset: launchProfile.preset,
    ...(options.memoryBudgetMiB !== undefined
      ? { overrideMemoryBudgetMiB: options.memoryBudgetMiB }
      : {}),
    hostMemoryMiB,
  });
  const preflight: DeploymentPreflight = {
    hostMemoryMiB,
    ...(hostCpuCount !== undefined ? { hostCpuCount } : {}),
    hostArchitecture,
    ...storagePreflight,
    ...caddySiteAddressPreflight,
    ...systemdPreflight,
    ...caddyPreflight,
    ...caddyConfigPreflight,
    ...envFilePreflight,
    ...serviceUserPreflight,
    ...configFilePreflight,
    ...workingDirectoryPreflight,
    ...gatewayEntrypointPreflight,
    ...runtimePreflight,
    ...llamaBinaryPreflight,
    ...swapPreflight,
    memoryBudgetMiB: budget.memoryBudgetMiB,
    memoryBudgetSource: budget.memoryBudgetSource,
    modelFilePath: launchProfile.modelPath,
  };
  const systemdUnitPreflight = await collectSystemdUnitPreflight(
    config,
    preflight,
    {
      cwd: options.cwd,
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.envFile ? { envFile: options.envFile } : {}),
      ...(runtimeBinary ? { runtimeBinary } : {}),
      ...(options.user ? { user: options.user } : {}),
      ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
      ...(options.strictFilesystem !== undefined
        ? { strictFilesystem: options.strictFilesystem }
        : {}),
    },
    systemdPreflight.systemdStatus,
  );
  const preflightWithSystemdUnits: DeploymentPreflight = {
    ...preflight,
    ...systemdUnitPreflight,
  };

  try {
    const fileStat = await stat(launchProfile.modelPath);
    if (!fileStat.isFile()) {
      return {
        ...preflightWithSystemdUnits,
        modelFileStatus: "unreadable",
        modelFileError: "not a regular file",
      };
    }

    const serviceUserAccess = serviceUserIdentity
      ? await verifyServiceUserPathAccess(launchProfile.modelPath, serviceUserIdentity, 0o4, "read")
      : undefined;
    const modelFileFormatPreflight = await collectGgufModelFileFormatPreflight(
      launchProfile.modelPath,
      options.strictFilesystem === true,
    );

    return {
      ...preflightWithSystemdUnits,
      modelFileBytes: fileStat.size,
      modelFileStatus: "found",
      ...modelFileFormatPreflight,
      ...(serviceUserAccess
        ? {
            modelFileAccessStatus: serviceUserAccess.status,
            ...(serviceUserAccess.error ? { modelFileAccessError: serviceUserAccess.error } : {}),
          }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissing =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";

    if (!options.strictFilesystem) {
      return preflightWithSystemdUnits;
    }

    return {
      ...preflightWithSystemdUnits,
      modelFileStatus: isMissing ? "missing" : "unreadable",
      modelFileError: message,
    };
  }
}
