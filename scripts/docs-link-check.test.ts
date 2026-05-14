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
  assert.throws(
    () => parseArgs(["--cwd", " /srv/ray"]),
    /--cwd must be a path without surrounding whitespace/,
  );
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

test("collectMarkdownPaths rejects malformed direct roots before reading directories", async () => {
  await assert.rejects(
    () => collectMarkdownPaths(" /srv/ray"),
    /cwd must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () => collectMarkdownPaths(`/${"a".repeat(4096)}`),
    /cwd must be at most 4096 bytes/,
  );
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

test("validateDocsLinks rejects malformed direct options before reading", async () => {
  await assert.rejects(
    () => validateDocsLinks(null as never),
    /docs link check options must be an object/,
  );

  await assert.rejects(
    () =>
      validateDocsLinks({
        cwd: repoRoot,
        markdownPaths: null,
      } as never),
    /markdownPaths must be an array when provided/,
  );
});

test("validateDocsLinks rejects malformed direct Markdown paths before reading", async () => {
  await assert.rejects(
    () =>
      validateDocsLinks({
        cwd: repoRoot,
        markdownPaths: ["README.md\n"],
      }),
    /markdownPaths\[0\] must not contain control characters/,
  );
  await assert.rejects(
    () =>
      validateDocsLinks({
        cwd: repoRoot,
        markdownPaths: [`/${"a".repeat(4096)}`],
      }),
    /markdownPaths\[0\] must be at most 4096 bytes/,
  );
  await assert.rejects(
    () =>
      validateDocsLinks({
        cwd: repoRoot,
        markdownPaths: [path.join(path.dirname(repoRoot), "outside.md")],
      }),
    /markdownPaths\[0\] must stay inside cwd/,
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
      "[same-anchor](#root)",
      "[target-anchor](docs/target.md#target)",
      "[missing-anchor](docs/target.md#missing-section)",
      "[missing](docs/missing.md)",
      "[outside](../outside.md)",
      "[external](https://example.com/docs/missing.md)",
      "[anchor](#root)",
      "![ignored image](docs/missing-image.png)",
      "",
    ].join("\n"),
  );

  const summary = await validateDocsLinks({ cwd: tempDir });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(diagnostics.some((entry) => entry.code === "local_markdown_link_missing"));
  assert.ok(diagnostics.some((entry) => entry.code === "local_markdown_anchor_missing"));
  assert.ok(diagnostics.some((entry) => entry.code === "local_markdown_link_outside_repo"));
  assert.equal(diagnostics.length, 3);
});

test("validateDocsLinks accepts encoded local Markdown anchors", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-doc-links-anchors-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(path.join(tempDir, "README.md"), "# Root Section\n[ok](#Root%20Section)\n");

  const summary = await validateDocsLinks({ cwd: tempDir });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
});

test("validateDocsLinks rejects encoded control characters in local targets", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-doc-links-target-controls-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "docs"), { recursive: true });
  await writeFile(path.join(tempDir, "docs", "target.md"), "# Target\n");
  await writeFile(path.join(tempDir, "README.md"), "# Root\n[bad](docs/target.md%0Aevil)\n");

  const summary = await validateDocsLinks({ cwd: tempDir });
  const diagnostic = summary.results
    .flatMap((result) => result.diagnostics)
    .find((entry) => entry.code === "local_markdown_link_invalid");

  assert.equal(summary.ok, false);
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /must not contain control characters/);
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

test("runDocsLinkCheckCli rejects malformed direct io before parsing", async () => {
  await assert.rejects(
    () => runDocsLinkCheckCli([], null as never),
    /docs link check io must be an object/,
  );

  await assert.rejects(
    () =>
      runDocsLinkCheckCli(["--help"], {
        stdout: {},
        stderr: {
          write() {
            return true;
          },
        },
      } as never),
    /docs link check io\.stdout\.write must be a function/,
  );

  await assert.rejects(
    () =>
      runDocsLinkCheckCli(["--unknown"], {
        stdout: {
          write() {
            return true;
          },
        },
        stderr: {},
      } as never),
    /docs link check io\.stderr\.write must be a function/,
  );
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
