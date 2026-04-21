import { loadAndDiagnoseDeployment, renderDeploymentBundle } from "./index.js";

type Command = "render" | "validate" | "doctor";

interface CliOptions {
  command: Command;
  cwd: string;
  configPath: string;
  user: string;
  domain: string;
  envFile?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  let command: Command = "render";
  let index = 0;

  if (argv[0] === "render" || argv[0] === "validate" || argv[0] === "doctor") {
    command = argv[0];
    index = 1;
  }

  const options: CliOptions = {
    command,
    cwd: process.cwd(),
    configPath: "./examples/config/ray.vps.json",
    user: "ray",
    domain: "ray.local",
  };

  for (; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (!next) {
      continue;
    }

    if (current === "--cwd") {
      options.cwd = next;
      index += 1;
      continue;
    }

    if (current === "--config") {
      options.configPath = next;
      index += 1;
      continue;
    }

    if (current === "--user") {
      options.user = next;
      index += 1;
      continue;
    }

    if (current === "--domain") {
      options.domain = next;
      index += 1;
      continue;
    }

    if (current === "--env-file") {
      options.envFile = next;
      index += 1;
    }
  }

  return options;
}

const options = parseCliArgs(process.argv.slice(2));

if (options.command === "render") {
  const bundle = await renderDeploymentBundle(options);

  console.log("# Ray systemd service\n");
  console.log(bundle.service);
  console.log("\n# Caddyfile\n");
  console.log(bundle.caddyfile);
  console.log("\n# Environment File Example\n");
  console.log(bundle.envFileExample);
  console.log("\n# Summary\n");
  console.log(JSON.stringify(bundle.summary, null, 2));
} else {
  const inspected = await loadAndDiagnoseDeployment(options);
  const hasErrors = inspected.diagnostics.some((diagnostic) => diagnostic.level === "error");

  console.log(JSON.stringify(
    {
      configPath: inspected.configPath,
      profile: inspected.config.profile,
      diagnostics: inspected.diagnostics,
    },
    null,
    2,
  ));

  if (options.command === "doctor" && hasErrors) {
    process.exit(1);
  }
}
