import { renderDeploymentBundle } from "./index.js";

interface CliOptions {
  cwd: string;
  configPath: string;
  user: string;
  domain: string;
  envFile?: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    cwd: process.cwd(),
    configPath: "./examples/config/ray.vps.json",
    user: "ray",
    domain: "ray.local",
  };

  for (let index = 0; index < argv.length; index += 1) {
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
const bundle = await renderDeploymentBundle(options);

console.log("# Ray systemd service\n");
console.log(bundle.service);
console.log("\n# Caddyfile\n");
console.log(bundle.caddyfile);
console.log("\n# Summary\n");
console.log(JSON.stringify(bundle.summary, null, 2));

