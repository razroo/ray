import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { listTarballEntries } from "./pack-check.mjs";

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function createTar(
  entries: Array<{ name: string; contents?: string; typeflag?: string; linkName?: string }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(" ", 148, 156);
    header.write(entry.typeflag ?? "0", 156, 1, "ascii");
    if (entry.linkName) {
      header.write(entry.linkName, 157, 100, "utf8");
    }
    header.write("ustar", 257, 5, "ascii");
    header.write("00", 263, 2, "ascii");

    let checksum = 0;
    for (const value of header) {
      checksum += value;
    }
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);
    blocks.push(contents);
    const remainder = contents.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }

  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test("listTarballEntries reads bounded npm package entries", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(
    tarballPath,
    gzipSync(
      createTar([
        { name: "package/package.json", contents: "{}" },
        { name: "package/dist/index.js", contents: "export {};" },
      ]),
    ),
  );

  assert.deepEqual(await listTarballEntries(tarballPath), [
    "package/package.json",
    "package/dist/index.js",
  ]);
});

test("listTarballEntries rejects oversized pack artifacts before reading", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-size-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(tarballPath, Buffer.alloc(128));

  await assert.rejects(
    () => listTarballEntries(tarballPath, { maxTarballBytes: 64 }),
    /Pack tarball must be at most 64 bytes/,
  );
});

test("listTarballEntries rejects excessive tar entries", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-entries-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(
    tarballPath,
    gzipSync(
      createTar([{ name: "package/a.js" }, { name: "package/b.js" }, { name: "package/c.js" }]),
    ),
  );

  await assert.rejects(
    () => listTarballEntries(tarballPath, { maxEntries: 2 }),
    /Pack tarball must contain at most 2 entries/,
  );
});

test("listTarballEntries rejects unsafe tar entry paths", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-paths-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");

  for (const entryName of [
    "../package.json",
    "/package/package.json",
    "package/../package.json",
    "package\\package.json",
    "package/\npackage.json",
  ]) {
    await writeFile(tarballPath, gzipSync(createTar([{ name: entryName, contents: "{}" }])));

    await assert.rejects(
      () => listTarballEntries(tarballPath),
      /Pack tarball contains an unsafe entry path/,
    );
  }
});

test("listTarballEntries rejects corrupt tar headers", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-checksum-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  const tar = createTar([{ name: "package/package.json", contents: "{}" }]);
  tar[0] = "P".charCodeAt(0);
  await writeFile(tarballPath, gzipSync(tar));

  await assert.rejects(
    () => listTarballEntries(tarballPath),
    /Pack tarball contains an invalid header checksum/,
  );
});

test("listTarballEntries rejects unsafe tar entry types", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-types-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");

  for (const entry of [
    { name: "package/external", typeflag: "1", linkName: "../outside" },
    { name: "package/external", typeflag: "2", linkName: "/etc/passwd" },
    { name: "package/null", typeflag: "3" },
  ]) {
    await writeFile(tarballPath, gzipSync(createTar([entry])));

    await assert.rejects(
      () => listTarballEntries(tarballPath),
      /Pack tarball contains an unsafe (hard link|symbolic link|device) entry/,
    );
  }
});
