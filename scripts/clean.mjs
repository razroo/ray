import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const removableNames = new Set(["dist"]);
const removableSuffixes = [".tsbuildinfo"];
const skipNames = new Set([".git", "node_modules"]);

async function walk(current) {
  const entries = await fs.readdir(current, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      if (skipNames.has(entry.name)) {
        return;
      }

      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (removableNames.has(entry.name)) {
          await fs.rm(absolutePath, { recursive: true, force: true });
          return;
        }

        await walk(absolutePath);
        return;
      }

      if (removableSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
        await fs.rm(absolutePath, { force: true });
      }
    }),
  );
}

await walk(root);

