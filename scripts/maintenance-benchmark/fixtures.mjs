import { createCipheriv, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import { rpcBody } from "./common.mjs";

const KiB = 1024;
const MiB = 1024 * KiB;
export const archiveSizes = ["small", "large-compressible", "large-dense"];

function document(index, contents) {
  return {
    path: `world/logbook/record-${index}.md`,
    contents: `---
$document:
  id: logbook.record-${index}
  ref: logbook-record-${index}
  title: Logbook ${index}
  summary: A synthetic dock record.
  aliases: []
---
# Logbook ${index}

Revision marker 0.

${contents}
`,
  };
}

export const editedDocument = "state/logbook/record-0.md";

export function revisionFiles(size) {
  const count = size === "small" ? 4 : 32;
  const bytesPerFile = size === "small" ? 4 * KiB : 256 * KiB;
  const line = "The keeper lists vessels, checked lamps and borrowed keys.\n";
  const contents = line.repeat(Math.floor(bytesPerFile / line.length));
  return [
    ...minimalFileNativeContentScaffold("en"),
    ...Array.from({ length: count }, (_, index) => document(index, contents)),
  ];
}

function archiveFiles(size) {
  const count = size === "small" ? 4 : 24;
  const bytesPerFile = size === "small" ? 4 * KiB : MiB;
  const uniqueBytes = size === "large-compressible" ? 128 * KiB : bytesPerFile;
  // Deterministic inert text. The large fixtures keep expanded size constant
  // while varying how much text the ZIP can compress.
  const key = createHash("sha256").update("narraeon-343-fixture").digest();
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
  return [
    ...minimalFileNativeContentScaffold("en"),
    ...Array.from({ length: count }, (_, index) => {
      const unique = cipher
        .update(Buffer.alloc((uniqueBytes * 3) / 4))
        .toString("base64");
      const text = unique.padEnd(bytesPerFile, "A");
      const lines = text.match(/.{1,1000}/gu).join("\n");
      return document(index, "\x60\x60\x60text\n" + lines + "\n\x60\x60\x60");
    }),
  ];
}

export function fileVolume(files) {
  return files.reduce(
    (total, { contents }) => total + Buffer.byteLength(contents),
    0,
  );
}

export async function buildArchives(root) {
  await mkdir(root);
  const workloads = {};
  for (const size of archiveSizes) {
    const files = archiveFiles(size);
    const zip = new ZipFile();
    for (const { path, contents } of files)
      zip.addBuffer(Buffer.from(contents), path, {
        mtime: new Date("2026-01-01T00:00:00Z"),
      });
    zip.end();
    const archive = await Array.fromAsync(zip.outputStream);
    const buffer = Buffer.concat(archive);
    const body = rpcBody({
      type: "content.import",
      archiveBase64: buffer.toString("base64"),
      title: `Benchmark ${size}`,
    });
    await writeFile(join(root, `${size}.zip`), buffer);
    await writeFile(join(root, `${size}.rpc.json`), body);
    workloads[size] = {
      files: files.length,
      expandedUtf8Bytes: fileVolume(files),
      zipBytes: buffer.byteLength,
      rpcJsonBytes: body.byteLength,
      treeFingerprint: contentTreeFingerprint(files),
    };
  }
  return workloads;
}
