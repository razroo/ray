import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SWAP_PATH = "/swapfile";
const DEFAULT_SWAP_SIZE_MIB = 1_024;
const DEFAULT_SWAPPINESS = 10;
const MAX_SWAP_SIZE_MIB = 65_536;
const MAX_SWAPPINESS = 200;
const MAX_CLI_ARGS = 8;
const MAX_CLI_ARG_BYTES = 4_096;

export interface SwapPlanArgs {
  path: string;
  sizeMiB: number;
  swappiness: number;
  json: boolean;
  help: boolean;
}

export interface SwapPlan {
  path: string;
  sizeMiB: number;
  swappiness: number;
  commands: string[];
}

const HELP = `Print a small-VPS swap-file plan for Ray llama.cpp deployments.

Usage:
  bun ./scripts/swap-plan.ts [options]

Options:
  --path <path>       Absolute swap file path. Default: ${DEFAULT_SWAP_PATH}
  --size-mib <n>      Swap file size in MiB. Default: ${DEFAULT_SWAP_SIZE_MIB}
  --swappiness <n>    Linux vm.swappiness value from 0 to ${MAX_SWAPPINESS}. Default: ${DEFAULT_SWAPPINESS}
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
    swappiness: DEFAULT_SWAPPINESS,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--path") {
      args.path = normalizeSwapPath(requireFlagValue(current, argv[index + 1]));
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
      index += 1;
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

  return args;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function createSwapPlan(
  options: { path?: string; sizeMiB?: number; swappiness?: number } = {},
): SwapPlan {
  const swapPath = normalizeSwapPath(options.path ?? DEFAULT_SWAP_PATH);
  const sizeMiB =
    options.sizeMiB === undefined
      ? DEFAULT_SWAP_SIZE_MIB
      : parseSwapSizeMiB(String(options.sizeMiB));
  const swappiness =
    options.swappiness === undefined
      ? DEFAULT_SWAPPINESS
      : parseSwappiness(String(options.swappiness));
  const quotedPath = shellQuote(swapPath);
  const fstabLine = `${swapPath} none swap sw 0 0`;
  const sysctlLine = `vm.swappiness=${swappiness}`;

  return {
    path: swapPath,
    sizeMiB,
    swappiness,
    commands: [
      `sudo test ! -e ${quotedPath} || { echo 'Swap file already exists: ${swapPath}' >&2; exit 1; }`,
      `if command -v fallocate >/dev/null 2>&1; then sudo fallocate -l ${sizeMiB}M ${quotedPath}; else sudo dd if=/dev/zero of=${quotedPath} bs=1M count=${sizeMiB} status=progress; fi`,
      `sudo chmod 600 ${quotedPath}`,
      `sudo mkswap ${quotedPath}`,
      `sudo swapon ${quotedPath}`,
      `sudo grep -Fq ${shellQuote(fstabLine)} /etc/fstab || printf '%s\\n' ${shellQuote(fstabLine)} | sudo tee -a /etc/fstab >/dev/null`,
      `printf '%s\\n' ${shellQuote(sysctlLine)} | sudo tee /etc/sysctl.d/99-ray-swap.conf >/dev/null`,
      `sudo sysctl ${shellQuote(sysctlLine)}`,
      "swapon --show",
    ],
  };
}

export function formatTextPlan(plan: SwapPlan): string {
  const lines = [
    "Ray small-VPS swap file plan:",
    `- swap file: ${plan.path}`,
    `- size: ${plan.sizeMiB} MiB`,
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

    const plan = createSwapPlan({
      path: args.path,
      sizeMiB: args.sizeMiB,
      swappiness: args.swappiness,
    });
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
