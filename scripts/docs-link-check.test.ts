import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectMarkdownPaths,
  formatTextSummary,
  parseArgs,
  runDocsLinkCheckCli,
  validateDocsLinks,
} from "./docs-link-check.ts";

const repoRoot = process.cwd();

test("parseArgs accepts strict docs link check options", () => {
  const args = parseArgs(["--cwd", "/srv/ray", "--json"]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed docs link check argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["README.md"]), /Unexpected positional argument/);
});

test("collectMarkdownPaths finds checked-in docs while skipping generated directories", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-doc-links-discovery-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "docs"), { recursive: true });
  await mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(tempDir, ".ray"), { recursive: true });
  await writeFile(path.join(tempDir, "README.md"), "# Root\n");
  await writeFile(path.join(tempDir, "docs", "guide.md"), "# Guide\n");
  await writeFile(path.join(tempDir, "node_modules", "pkg", "README.md"), "# Ignored\n");
  await writeFile(path.join(tempDir, ".ray", "generated.md"), "# Ignored\n");

  const docs = (await collectMarkdownPaths(tempDir)).map((filePath) =>
    path.relative(tempDir, filePath),
  );

  assert.deepEqual(docs, ["README.md", path.join("docs", "guide.md")]);
});

test("validateDocsLinks accepts current checked-in local Markdown links", async () => {
  const summary = await validateDocsLinks({ cwd: repoRoot });

  assert.equal(summary.ok, true);
  assert.ok(summary.docCount >= 10);
  assert.ok(summary.linkCount > 0);
  assert.equal(summary.errorCount, 0);
});

test("validateDocsLinks rejects excessive direct Markdown inputs before reading", async () => {
  await assert.rejects(
    () =>
      validateDocsLinks({
        cwd: repoRoot,
        markdownPaths: Array.from({ length: 513 }, (_value, index) => `/tmp/ray-doc-${index}.md`),
      }),
    /at most 512 Markdown files/,
  );
});

test("validateDocsLinks reports missing and escaping local links", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-doc-links-broken-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "docs"), { recursive: true });
  await writeFile(path.join(tempDir, "docs", "target.md"), "# Target\n");
  await writeFile(
    path.join(tempDir, "README.md"),
    [
      "# Root",
      "[ok](docs/target.md)",
      "[missing](docs/missing.md)",
      "[outside](../outside.md)",
      "[external](https://example.com/docs/missing.md)",
      "[anchor](#local-anchor)",
      "![ignored image](docs/missing-image.png)",
      "",
    ].join("\n"),
  );

  const summary = await validateDocsLinks({ cwd: tempDir });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(diagnostics.some((entry) => entry.code === "local_markdown_link_missing"));
  assert.ok(diagnostics.some((entry) => entry.code === "local_markdown_link_outside_repo"));
  assert.equal(diagnostics.length, 2);
});

test("validateDocsLinks rejects oversized Markdown inputs", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-doc-links-size-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const readmePath = path.join(tempDir, "README.md");
  await writeFile(readmePath, "x".repeat(512 * 1024 + 1));

  const summary = await validateDocsLinks({ cwd: tempDir, markdownPaths: [readmePath] });
  const diagnostic = summary.results
    .flatMap((result) => result.diagnostics)
    .find((entry) => entry.code === "markdown_invalid");

  assert.ok(diagnostic);
  assert.match(diagnostic.message, /Markdown file must be at most 524288 bytes/);
});

test("formatTextSummary prints operator-readable link results", async () => {
  const summary = await validateDocsLinks({
    cwd: repoRoot,
    markdownPaths: [path.join(repoRoot, "README.md")],
  });
  const text = formatTextSummary(repoRoot, summary);

  assert.match(text, /Checked 1 Markdown file/);
  assert.match(text, /README\.md/);
  assert.match(text, /Summary: docs=1/);
});

test("runDocsLinkCheckCli prints JSON coverage", async () => {
  let output = "";
  let errorOutput = "";
  const code = await runDocsLinkCheckCli(["--cwd", repoRoot, "--json"], {
    stdout: { write: (chunk: string) => void (output += chunk) },
    stderr: { write: (chunk: string) => void (errorOutput += chunk) },
  } as Pick<NodeJS.Process, "stdout" | "stderr">);

  assert.equal(code, 0);
  assert.equal(errorOutput, "");
  const parsed = JSON.parse(output) as {
    ok?: boolean;
    docCount?: number;
    linkCount?: number;
  };
  assert.equal(parsed.ok, true);
  assert.ok((parsed.docCount ?? 0) >= 10);
  assert.ok((parsed.linkCount ?? 0) > 0);
});
