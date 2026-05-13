import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SWAP_PATH = "/swapfile";
const DEFAULT_SWAP_SIZE_MIB = 1_024;
const DEFAULT_MIN_FREE_AFTER_MIB = 512;
const DEFAULT_SWAPPINESS = 10;
const MAX_SWAP_SIZE_MIB = 65_536;
const MAX_MIN_FREE_AFTER_MIB = 65_536;
const MAX_SWAPPINESS = 200;
const MAX_CLI_ARGS = 10;
const MAX_CLI_ARG_BYTES = 4_096;
const MIN_CREATE_TIMEOUT_SECONDS = 300;
const MAX_CREATE_TIMEOUT_SECONDS = 7_200;
const CREATE_TIMEOUT_MIB_PER_SECOND = 8;
const QUICK_TIMEOUT_SECONDS = 60;
const INSPECT_TIMEOUT_SECONDS = 30;

export interface SwapPlanArgs {
  path: string;
  sizeMiB: number;
  minFreeAfterMiB: number;
  swappiness: number;
  sysctlOnly: boolean;
  json: boolean;
  help: boolean;
}

export interface SwapPlan {
  path: string;
  sizeMiB: number;
  minFreeAfterMiB: number;
  swappiness: number;
  sysctlOnly: boolean;
  commands: string[];
}

const HELP = `Print a small-VPS swap-file plan for Ray llama.cpp deployments.

Usage:
  bun ./scripts/swap-plan.ts [options]

Options:
  --path <path>       Absolute swap file path. Default: ${DEFAULT_SWAP_PATH}
  --size-mib <n>      Swap file size in MiB. Default: ${DEFAULT_SWAP_SIZE_MIB}
  --min-free-after-mib <n>
                      Required free MiB left on the swap parent filesystem. Default: ${DEFAULT_MIN_FREE_AFTER_MIB}
  --swappiness <n>    Linux vm.swappiness value from 0 to ${MAX_SWAPPINESS}. Default: ${DEFAULT_SWAPPINESS}
  --sysctl-only       Print only vm.swappiness persistence/apply commands; do not touch swap files.
  --json              Print machine-readable plan JSON.
  -h, --help          Show this help.
`;

function assertArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_CLI_ARG_BYTES} bytes`);
    }
  }
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function normalizeSwapPath(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error("swap path must be a non-empty absolute path without surrounding whitespace");
  }

  if (/[\0\r\n\s]/.test(value)) {
    throw new Error("swap path must not contain whitespace or control characters");
  }

  if (!path.posix.isAbsolute(value)) {
    throw new Error("swap path must be absolute");
  }

  const normalized = path.posix.normalize(value);
  if (normalized === "/" || normalized.endsWith("/")) {
    throw new Error("swap path must point to a file, not a directory");
  }

  return normalized;
}

function parseSwapSizeMiB(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (
    !/^[1-9][0-9]*$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_SWAP_SIZE_MIB
  ) {
    throw new Error(`swap size must be an integer from 1 to ${MAX_SWAP_SIZE_MIB} MiB`);
  }

  return parsed;
}

function parseMinFreeAfterMiB(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (
    !/^(?:0|[1-9][0-9]*)$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_MIN_FREE_AFTER_MIB
  ) {
    throw new Error(
      `minimum free-after-swap headroom must be an integer from 0 to ${MAX_MIN_FREE_AFTER_MIB} MiB`,
    );
  }

  return parsed;
}

function parseSwappiness(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (
    !/^(?:0|[1-9][0-9]*)$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_SWAPPINESS
  ) {
    throw new Error(`swappiness must be an integer from 0 to ${MAX_SWAPPINESS}`);
  }

  return parsed;
}

export function parseArgs(argv: string[]): SwapPlanArgs {
  assertArgv(argv);

  const args: SwapPlanArgs = {
    path: DEFAULT_SWAP_PATH,
    sizeMiB: DEFAULT_SWAP_SIZE_MIB,
    minFreeAfterMiB: DEFAULT_MIN_FREE_AFTER_MIB,
    swappiness: DEFAULT_SWAPPINESS,
    sysctlOnly: false,
    json: false,
    help: false,
  };
  let pathProvided = false;
  let sizeMiBProvided = false;
  let minFreeAfterMiBProvided = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--path") {
      args.path = normalizeSwapPath(requireFlagValue(current, argv[index + 1]));
      pathProvided = true;
      index += 1;
      continue;
    }

    if (current === "--swappiness") {
      args.swappiness = parseSwappiness(requireFlagValue(current, argv[index + 1]));
      index += 1;
      continue;
    }

    if (current === "--size-mib") {
      args.sizeMiB = parseSwapSizeMiB(requireFlagValue(current, argv[index + 1]));
      sizeMiBProvided = true;
      index += 1;
      continue;
    }

    if (current === "--min-free-after-mib") {
      args.minFreeAfterMiB = parseMinFreeAfterMiB(requireFlagValue(current, argv[index + 1]));
      minFreeAfterMiBProvided = true;
      index += 1;
      continue;
    }

    if (current === "--sysctl-only") {
      args.sysctlOnly = true;
      continue;
    }

    if (current === "--json") {
      args.json = true;
      continue;
    }

    if (current === "-h" || current === "--help") {
      args.help = true;
      continue;
    }

    if (current?.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }

    throw new Error(`Unexpected positional argument: ${current ?? ""}`);
  }

  if (args.sysctlOnly && pathProvided) {
    throw new Error("--path cannot be used with --sysctl-only");
  }

  if (args.sysctlOnly && sizeMiBProvided) {
    throw new Error("--size-mib cannot be used with --sysctl-only");
  }

  if (args.sysctlOnly && minFreeAfterMiBProvided) {
    throw new Error("--min-free-after-mib cannot be used with --sysctl-only");
  }

  return args;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function calculateCreateTimeoutSeconds(sizeMiB: number): number {
  return Math.min(
    MAX_CREATE_TIMEOUT_SECONDS,
    Math.max(MIN_CREATE_TIMEOUT_SECONDS, Math.ceil(sizeMiB / CREATE_TIMEOUT_MIB_PER_SECOND)),
  );
}

function buildDiskHeadroomCommand(
  swapPath: string,
  sizeMiB: number,
  minFreeAfterMiB: number,
): string {
  const parent = path.posix.dirname(swapPath);
  const requiredMiB = sizeMiB + minFreeAfterMiB;
  const script = [
    `parent=${shellQuote(parent)}`,
    `required_mib=${requiredMiB}`,
    `test -d "$parent" || { echo "Swap parent directory does not exist: $parent" >&2; exit 1; }`,
    `available_mib=$(df -Pm "$parent" | awk 'NR==2 {print $4}')`,
    `case "$available_mib" in ''|*[!0-9]*) echo "Could not read free MiB for $parent" >&2; exit 1;; esac`,
    `if [ "$available_mib" -lt "$required_mib" ]; then echo "Need at least ${requiredMiB} MiB free on $parent before creating Ray swap (${sizeMiB} MiB swap + ${minFreeAfterMiB} MiB headroom); found $available_mib MiB" >&2; exit 1; fi`,
  ].join("; ");

  return `timeout ${INSPECT_TIMEOUT_SECONDS}s sh -c ${shellQuote(script)}`;
}

export function createSwapPlan(
  options: {
    path?: string;
    sizeMiB?: number;
    minFreeAfterMiB?: number;
    swappiness?: number;
    sysctlOnly?: boolean;
  } = {},
): SwapPlan {
  const sysctlOnly = options.sysctlOnly ?? false;
  if (sysctlOnly && options.path !== undefined) {
    throw new Error("path cannot be used with sysctlOnly");
  }
  if (sysctlOnly && options.sizeMiB !== undefined) {
    throw new Error("sizeMiB cannot be used with sysctlOnly");
  }
  if (sysctlOnly && options.minFreeAfterMiB !== undefined) {
    throw new Error("minFreeAfterMiB cannot be used with sysctlOnly");
  }

  const swapPath = normalizeSwapPath(options.path ?? DEFAULT_SWAP_PATH);
  const sizeMiB =
    options.sizeMiB === undefined
      ? DEFAULT_SWAP_SIZE_MIB
      : parseSwapSizeMiB(String(options.sizeMiB));
  const minFreeAfterMiB =
    options.minFreeAfterMiB === undefined
      ? DEFAULT_MIN_FREE_AFTER_MIB
      : parseMinFreeAfterMiB(String(options.minFreeAfterMiB));
  const swappiness =
    options.swappiness === undefined
      ? DEFAULT_SWAPPINESS
      : parseSwappiness(String(options.swappiness));
  const quotedPath = shellQuote(swapPath);
  const fstabLine = `${swapPath} none swap sw 0 0`;
  const sysctlLine = `vm.swappiness=${swappiness}`;
  const createTimeoutSeconds = calculateCreateTimeoutSeconds(sizeMiB);
  const sysctlCommands = [
    `printf '%s\\n' ${shellQuote(sysctlLine)} | timeout ${QUICK_TIMEOUT_SECONDS}s sudo tee /etc/sysctl.d/99-ray-swap.conf >/dev/null`,
    `timeout ${QUICK_TIMEOUT_SECONDS}s sudo sysctl ${shellQuote(sysctlLine)}`,
    `timeout ${INSPECT_TIMEOUT_SECONDS}s sh -c ${shellQuote(
      `test "$(cat /proc/sys/vm/swappiness)" = "${swappiness}"`,
    )}`,
  ];

  return {
    path: swapPath,
    sizeMiB,
    minFreeAfterMiB,
    swappiness,
    sysctlOnly,
    commands: sysctlOnly
      ? sysctlCommands
      : [
          buildDiskHeadroomCommand(swapPath, sizeMiB, minFreeAfterMiB),
          `timeout ${INSPECT_TIMEOUT_SECONDS}s sudo test ! -e ${quotedPath}; status=$?; if [ "$status" -eq 1 ]; then echo 'Swap file already exists: ${swapPath}' >&2; exit 1; elif [ "$status" -ne 0 ]; then exit "$status"; fi`,
          `if command -v fallocate >/dev/null 2>&1; then timeout ${createTimeoutSeconds}s sudo fallocate -l ${sizeMiB}M ${quotedPath}; else timeout ${createTimeoutSeconds}s sudo dd if=/dev/zero of=${quotedPath} bs=1M count=${sizeMiB} status=progress; fi`,
          `timeout ${QUICK_TIMEOUT_SECONDS}s sudo chmod 600 ${quotedPath}`,
          `timeout ${QUICK_TIMEOUT_SECONDS}s sudo mkswap ${quotedPath}`,
          `timeout ${QUICK_TIMEOUT_SECONDS}s sudo swapon ${quotedPath}`,
          `timeout ${INSPECT_TIMEOUT_SECONDS}s sudo grep -Fq ${shellQuote(fstabLine)} /etc/fstab; status=$?; if [ "$status" -eq 0 ]; then :; elif [ "$status" -eq 1 ]; then printf '%s\\n' ${shellQuote(fstabLine)} | timeout ${QUICK_TIMEOUT_SECONDS}s sudo tee -a /etc/fstab >/dev/null; else exit "$status"; fi`,
          ...sysctlCommands,
          `timeout ${INSPECT_TIMEOUT_SECONDS}s swapon --show`,
        ],
  };
}

export function formatTextPlan(plan: SwapPlan): string {
  const lines = plan.sysctlOnly
    ? [
        "Ray small-VPS swappiness plan:",
        `- vm.swappiness: ${plan.swappiness}`,
        "",
        "Run on the VPS:",
        ...plan.commands,
        "",
        "Then run doctor again before sustained llama.cpp inference.",
      ]
    : [
        "Ray small-VPS swap file plan:",
        `- swap file: ${plan.path}`,
        `- size: ${plan.sizeMiB} MiB`,
        `- minimum free after swap: ${plan.minFreeAfterMiB} MiB`,
        `- vm.swappiness: ${plan.swappiness}`,
        "",
        "Run on the VPS:",
        ...plan.commands,
        "",
        "Then run doctor again before sustained llama.cpp inference.",
      ];

  return lines.join("\n");
}

export async function runSwapPlanCli(
  argv = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.help) {
      io.stdout.write(HELP);
      return 0;
    }

    const plan = createSwapPlan(
      args.sysctlOnly
        ? {
            swappiness: args.swappiness,
            sysctlOnly: true,
          }
        : {
            path: args.path,
            sizeMiB: args.sizeMiB,
            minFreeAfterMiB: args.minFreeAfterMiB,
            swappiness: args.swappiness,
          },
    );
    const output = args.json ? JSON.stringify(plan, null, 2) : formatTextPlan(plan);
    io.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSwapPlanCli();
}
