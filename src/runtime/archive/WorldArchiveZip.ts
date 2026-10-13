import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import type {
  worldArchiveLimits,
  WorldArchiveErrorCode,
} from "../../protocol/worldArchives.ts";

export class WorldArchiveError extends Error {
  readonly code: WorldArchiveErrorCode;
  constructor(
    code: WorldArchiveErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = "WorldArchiveError";
  }
}
export interface ArchiveFile {
  path: string;
  bytes: number;
  sha256: string;
}
export type ArchiveLimits = typeof worldArchiveLimits;

export function archivePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > 4096 ||
    path.includes("\\") ||
    Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        '<>:"|?*'.includes(character),
    ) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          Buffer.byteLength(part, "utf8") > 255 ||
          /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(
            part.split(".", 1)[0]!.toUpperCase(),
          ),
      )
  )
    throw new WorldArchiveError(
      "unsafe_path",
      "The archive contains an unsafe path",
    );
}

/** No whole-file buffers: hash, limit and persist in the same backpressured pipeline. */
export async function streamFile(
  source: Readable,
  destination: string,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  let bytes = 0;
  const hash = createHash("sha256");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        callback(
          new WorldArchiveError(
            "limit_exceeded",
            "The archive exceeds its size limit",
          ),
        );
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  await pipeline(
    source,
    counter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  return { bytes, sha256: hash.digest("hex") };
}

export async function inventory(
  root: string,
  prefix = "world",
): Promise<ArchiveFile[]> {
  const result: ArchiveFile[] = [];
  async function visit(directory: string, path: string): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(directory, entry.name);
      const relative = `${path}/${entry.name}`;
      archivePath(relative);
      if (entry.isDirectory()) await visit(full, relative);
      else if (entry.isFile()) {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(full)) {
          const buffer: unknown = chunk;
          if (!Buffer.isBuffer(buffer))
            throw new Error("Archive file stream must be binary");
          bytes += buffer.length;
          hash.update(buffer);
        }
        result.push({ path: relative, bytes, sha256: hash.digest("hex") });
      } else
        throw new WorldArchiveError(
          "unsafe_path",
          "Only files and directories may be archived",
        );
    }
  }
  await visit(root, prefix);
  return result;
}

export async function writeArchive(
  root: string,
  files: ArchiveFile[],
  destination: string,
  limits: ArchiveLimits,
): Promise<number> {
  const manifestBytes = (await stat(join(root, "narraeon-world.json"))).size;
  if (
    manifestBytes > limits.entryBytes ||
    files.length + 1 > limits.entries ||
    files.some((file) => file.bytes > limits.entryBytes) ||
    files.reduce((sum, file) => sum + file.bytes, manifestBytes) >
      limits.extractedBytes
  )
    throw new WorldArchiveError(
      "limit_exceeded",
      "The world exceeds archive limits",
    );
  const zip = new yazl.ZipFile();
  const output = streamFile(
    zip.outputStream as Readable,
    destination,
    limits.archiveBytes,
  );
  zip.on("error", (error: Error) =>
    (zip.outputStream as Readable).destroy(error),
  );
  zip.addFile(join(root, "narraeon-world.json"), "narraeon-world.json");
  for (const file of files) zip.addFile(join(root, file.path), file.path);
  zip.end();
  return (await output).bytes;
}

export async function extractArchive(
  archive: string,
  destination: string,
  limits: ArchiveLimits,
): Promise<Map<string, ArchiveFile>> {
  if ((await stat(archive)).size > limits.archiveBytes)
    throw new WorldArchiveError(
      "limit_exceeded",
      "The ZIP exceeds its size limit",
    );
  let zip: yauzl.ZipFile;
  try {
    zip = await new Promise((resolve, reject) =>
      yauzl.open(
        archive,
        { lazyEntries: true, decodeStrings: false, validateEntrySizes: true },
        (error, value) => (error ? reject(error) : resolve(value)),
      ),
    );
  } catch (error) {
    throw new WorldArchiveError("invalid_archive", "Invalid ZIP archive", {
      cause: error,
    });
  }
  const files = new Map<string, ArchiveFile>();
  const paths = new Map<
    string,
    { path: string; directory: boolean; explicit: boolean }
  >();
  let total = 0;
  let count = 0;
  const register = (path: string, directory: boolean, explicit: boolean) => {
    const key = path.normalize("NFKC").toLowerCase();
    const previous = paths.get(key);
    if (
      previous &&
      (previous.path !== path ||
        previous.directory !== directory ||
        (explicit && previous.explicit))
    )
      throw new WorldArchiveError(
        "unsafe_path",
        "Duplicate or conflicting archive paths",
      );
    paths.set(key, {
      path,
      directory,
      explicit: explicit || previous?.explicit === true,
    });
  };
  try {
    if (zip.entryCount > limits.entries)
      throw new WorldArchiveError("limit_exceeded", "Too many ZIP entries");
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          if (++count > limits.entries)
            throw new WorldArchiveError(
              "limit_exceeded",
              "Too many ZIP entries",
            );
          let raw: string;
          try {
            raw = new TextDecoder("utf-8", { fatal: true }).decode(
              entry.fileNameRaw,
            );
          } catch {
            throw new WorldArchiveError(
              "unsafe_path",
              "ZIP paths must be UTF-8",
            );
          }
          const directory = raw.endsWith("/");
          const path = directory ? raw.slice(0, -1) : raw;
          archivePath(path);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            (mode !== 0 && mode !== (directory ? 0o040000 : 0o100000)) ||
            ((entry.externalFileAttributes & 0x10) !== 0 && !directory)
          )
            throw new WorldArchiveError(
              "unsafe_path",
              "Only regular ZIP files and directories are allowed",
            );
          if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod))
            throw new WorldArchiveError(
              "invalid_archive",
              "Unsupported ZIP encoding",
            );
          const segments = path.split("/");
          for (let index = 1; index < segments.length; index++)
            register(segments.slice(0, index).join("/"), true, false);
          register(path, directory, true);
          if (
            path !== "world" &&
            !path.startsWith("world/") &&
            path !== "narraeon-world.json"
          )
            throw new WorldArchiveError(
              "invalid_archive",
              "Unexpected archive entry",
            );
          if (
            (path === "world" && !directory) ||
            (path === "narraeon-world.json" && directory)
          )
            throw new WorldArchiveError(
              "invalid_archive",
              "Invalid archive layout",
            );

          if (
            entry.uncompressedSize > limits.entryBytes ||
            total + entry.uncompressedSize > limits.extractedBytes
          )
            throw new WorldArchiveError(
              "limit_exceeded",
              "Extracted ZIP exceeds its size limit",
            );
          if (directory) {
            if (entry.uncompressedSize !== 0)
              throw new WorldArchiveError(
                "invalid_archive",
                "ZIP directory contains data",
              );
            await mkdir(join(destination, path), {
              recursive: true,
              mode: 0o700,
            });
          } else {
            const stream = await new Promise<Readable>(
              (resolveStream, rejectStream) =>
                zip.openReadStream(entry, (error, value) =>
                  error ? rejectStream(error) : resolveStream(value),
                ),
            );
            const result = await streamFile(
              stream,
              join(destination, path),
              Math.min(limits.entryBytes, limits.extractedBytes - total),
            );
            if (result.bytes !== entry.uncompressedSize)
              throw new WorldArchiveError(
                "integrity_failed",
                "ZIP entry size does not match",
              );
            total += result.bytes;
            files.set(path, { path, ...result });
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    return files;
  } catch (error) {
    if (error instanceof WorldArchiveError) throw error;
    throw new WorldArchiveError("invalid_archive", "Invalid ZIP archive", {
      cause: error,
    });
  } finally {
    zip.close();
  }
}
