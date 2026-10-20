import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  worldArchiveFormat,
  worldArchiveLimits,
  type WorldArchiveDownload,
} from "../../protocol/worldArchives.ts";
import { FileNativeArtifactStore } from "../artifact/FileNativeArtifactStore.ts";
import { PlayCallChain } from "../play/PlayCallChain.ts";
import { FileNativePromptCompiler } from "../prompt/FileNativePromptCompiler.ts";
import { WorldLedgerAuthority } from "../world/WorldLedgerAuthority.ts";
import {
  FileNativeWorldStore,
  type FileNativeWorldSummary,
} from "../world/FileNativeWorldStore.ts";
import {
  archivePath,
  extractArchive,
  inventory,
  streamFile,
  writeArchive,
  WorldArchiveError,
  type ArchiveFile,
  type ArchiveLimits,
} from "./WorldArchiveZip.ts";

interface Manifest {
  format: typeof worldArchiveFormat;
  appVersion: string;
  exportedAt: string;
  worldName: string;
  archivedWorldId: string;
  head: string;
  files: ArchiveFile[];
}

export class WorldArchives {
  readonly #dataRoot: string;
  readonly #root: string;
  readonly #limits: ArchiveLimits;
  readonly #worlds: FileNativeWorldStore;
  readonly #chains: PlayCallChain;
  #appVersion = "";
  constructor(input: {
    dataRoot: string;
    worlds: FileNativeWorldStore;
    chains: PlayCallChain;
    limits?: ArchiveLimits;
  }) {
    this.#dataRoot = resolve(input.dataRoot);
    this.#root = join(this.#dataRoot, "world-archives");
    this.#worlds = input.worlds;
    this.#chains = input.chains;
    this.#limits = input.limits ?? worldArchiveLimits;
  }

  async initialize(): Promise<void> {
    this.#appVersion = await appVersion();
    const worldsRoot = join(this.#dataRoot, "worlds-file-native");
    const staged = await readdir(worldsRoot).catch(() => []);
    for (const operationId of await readdir(
      join(this.#root, "quarantine"),
    ).catch(() => [])) {
      const worldId = `world-${createHash("sha256").update(`import:${operationId}`).digest("hex").slice(0, 24)}`;
      for (const entry of staged)
        if (entry.startsWith(`.staging-${worldId}-`))
          await rm(join(worldsRoot, entry), { recursive: true, force: true });
    }
    for (const name of ["uploads", "quarantine", "exports"]) {
      await rm(join(this.#root, name), { recursive: true, force: true });
      await mkdir(join(this.#root, name), { recursive: true, mode: 0o700 });
    }
  }

  async upload(source: Readable): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    const path = this.#uploadPath(uploadId);
    try {
      await streamFile(source, path, this.#limits.archiveBytes);
      return { uploadId };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async exportWorld(input: {
    worldId: string;
    operationId: string;
  }): Promise<WorldArchiveDownload> {
    identity(input.operationId);
    return this.#worlds.withArchiveExport(input.worldId, async () => {
      const root = join(this.#root, "exports", input.operationId);
      await rm(root, { recursive: true, force: true });
      try {
        const source = await this.#worlds.readWorldSummary(input.worldId);
        if (!source)
          throw new WorldArchiveError(
            "invalid_archive",
            "World does not exist",
          );
        const fork = await this.#chains.deriveWorld({
          operationId: input.operationId,
          sourceWorldId: input.worldId,
          sourceHead: "current",
          hostPresetId: "world-archive",
          targetName: source.title,
          publish: false,
          targetWorldRoot: join(root, "world"),
          resetPackageScriptPermissions: true,
          retainCompleteTimeline: true,
        });
        // A fork may create a local display cache; it is outside the portable closure.
        await rm(join(fork.worldRoot, "runtime", "activity.json"), {
          force: true,
        });
        const files = await inventory(fork.worldRoot);
        const manifest: Manifest = {
          format: worldArchiveFormat,
          appVersion: this.#appVersion || (await appVersion()),
          exportedAt: new Date().toISOString(),
          worldName: source.title,
          archivedWorldId: fork.world.worldId,
          head: (await new WorldLedgerAuthority(fork.worldRoot).readHead())
            .head,
          files,
        };
        await durableJson(join(root, "narraeon-world.json"), manifest);
        const bytes = await writeArchive(
          root,
          files,
          join(root, "archive.zip"),
          this.#limits,
        );
        const fileName = `${archiveBaseName(source.title)}.narraeon-world.zip`;
        const result = { archiveId: input.operationId, fileName, bytes };
        await durableJson(join(root, "download.json"), result);
        const expiry = setTimeout(
          () => {
            void stat(join(root, "download.json"))
              .then((value) => {
                if (Date.now() - value.mtimeMs >= 60 * 60 * 1000)
                  return rm(root, { recursive: true, force: true });
              })
              .catch(() => undefined);
          },
          60 * 60 * 1000,
        );
        expiry.unref();
        return result;
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async download(archiveId: string): Promise<{
    metadata: WorldArchiveDownload;
    stream: Readable;
    cleanup: () => Promise<void>;
  }> {
    identity(archiveId);
    const root = join(this.#root, "exports", archiveId);
    const metadata = JSON.parse(
      await readFile(join(root, "download.json"), "utf8"),
    ) as WorldArchiveDownload;
    if (
      Date.now() - (await stat(join(root, "download.json"))).mtimeMs >=
      60 * 60 * 1000
    ) {
      await rm(root, { recursive: true, force: true });
      throw new WorldArchiveError(
        "invalid_archive",
        "The download has expired; export the world again",
      );
    }
    return {
      metadata,
      stream: createReadStream(join(root, "archive.zip")),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  async importWorld(input: {
    operationId: string;
    uploadId: string;
  }): Promise<{ outcome: "imported"; world: FileNativeWorldSummary }> {
    identity(input.operationId);
    identity(input.uploadId);
    const digest = createHash("sha256")
      .update(`import:${input.operationId}`)
      .digest("hex")
      .slice(0, 24);
    return this.#worlds.operations.withExclusiveWorldStateMutation(
      `archive-import-${digest}`,
      async () => {
        const worldId = `world-${digest}`;
        const targetRoot = join(this.#dataRoot, "worlds-file-native", worldId);
        const quarantine = join(this.#root, "quarantine", input.operationId);
        const upload = this.#uploadPath(input.uploadId);
        try {
          // Publication is the durable commit point. A process may exit before writing its receipt or cleaning the upload.
          let published: {
            worldId: string;
            title: string;
            operationId: string;
          } | null = null;
          try {
            published = JSON.parse(
              await readFile(join(targetRoot, "publication.json"), "utf8"),
            ) as { worldId: string; title: string; operationId: string };
          } catch (error) {
            if (!missing(error)) throw error;
          }
          if (published) {
            if (
              published.operationId !== input.operationId ||
              published.worldId !== worldId
            )
              throw new WorldArchiveError(
                "integrity_failed",
                "Import publication does not match its operation",
              );
            await this.#worlds.ensureCurrentStorage(worldId);
            const world = await this.#worlds.readWorldSummary(worldId);
            return { outcome: "imported", world };
          }
          await rm(quarantine, { recursive: true, force: true });
          const worldsRoot = join(this.#dataRoot, "worlds-file-native");
          for (const entry of await readdir(worldsRoot).catch(() => []))
            if (entry.startsWith(`.staging-${worldId}-`))
              await rm(join(worldsRoot, entry), {
                recursive: true,
                force: true,
              });
          const extracted = join(quarantine, "extracted");
          await mkdir(extracted, { recursive: true, mode: 0o700 });
          let actual: Map<string, ArchiveFile>;
          try {
            actual = await extractArchive(upload, extracted, this.#limits);
          } catch (error) {
            if (missing(error))
              throw new WorldArchiveError(
                "invalid_archive",
                "Upload is missing; upload the ZIP again",
              );
            throw error;
          }
          if (!actual.has("narraeon-world.json"))
            throw new WorldArchiveError(
              "invalid_archive",
              "Archive manifest is missing",
            );
          let value: unknown;
          try {
            value = JSON.parse(
              await readFile(join(extracted, "narraeon-world.json"), "utf8"),
            );
          } catch (error) {
            throw new WorldArchiveError(
              "invalid_archive",
              "Archive manifest is invalid",
              { cause: error },
            );
          }
          const manifest = validateManifest(value, this.#limits);
          if (actual.size !== manifest.files.length + 1)
            throw new WorldArchiveError(
              "integrity_failed",
              "Archive contains extra or missing files",
            );
          for (const file of manifest.files) {
            const found = actual.get(file.path);
            if (file.bytes !== found?.bytes || file.sha256 !== found?.sha256)
              throw new WorldArchiveError(
                "integrity_failed",
                "Archive file digest does not match its manifest",
              );
          }
          const sourceRoot = join(
            quarantine,
            "worlds-file-native",
            manifest.archivedWorldId,
          );
          await mkdir(dirname(sourceRoot), { recursive: true });
          try {
            await rename(join(extracted, "world"), sourceRoot);
          } catch (error) {
            if (missing(error))
              throw new WorldArchiveError(
                "invalid_archive",
                "Archive world directory is missing",
              );
            throw error;
          }
          // Discard any incoming machine-local display cache before storage migration or reads.
          await rm(join(sourceRoot, "runtime", "activity.json"), {
            force: true,
          });
          const sourceWorlds = new FileNativeWorldStore(quarantine);
          try {
            const publication = JSON.parse(
              await readFile(join(sourceRoot, "publication.json"), "utf8"),
            ) as { worldId: string };
            if (publication?.worldId !== manifest.archivedWorldId)
              throw new Error("Archive world identity mismatch");
            await sourceWorlds.ensureCurrentStorage(manifest.archivedWorldId);
            // 结构校验：端点与清单一致，账本能倒推回 genesis；投影在分叉时重建。
            const authority = new WorldLedgerAuthority(sourceRoot);
            const head = await authority.readHead();
            if (head.head !== manifest.head)
              throw new Error("Archive head mismatch");
            await authority.verifyStructure();
          } catch (error) {
            throw new WorldArchiveError(
              "integrity_failed",
              "Archive Authority failed its complete audit",
              { cause: error },
            );
          }
          const sourceChains = new PlayCallChain(
            sourceWorlds,
            new FileNativePromptCompiler(),
            new FileNativeArtifactStore(quarantine),
          );
          let result;
          try {
            result = await sourceChains.deriveWorld({
              operationId: input.operationId,
              sourceWorldId: manifest.archivedWorldId,
              sourceHead: manifest.head,
              hostPresetId: "world-archive",
              targetDataRoot: this.#dataRoot,
              targetName: manifest.worldName,
              identityPrefix: "import",
              resetPackageScriptPermissions: true,
              retainCompleteTimeline: true,
            });
          } catch (error) {
            throw new WorldArchiveError(
              "integrity_failed",
              "Archive world closure cannot be restored",
              { cause: error },
            );
          }
          return { outcome: "imported", world: result.world };
        } finally {
          await rm(quarantine, { recursive: true, force: true });
          await rm(upload, { force: true });
          const worldsRoot = join(this.#dataRoot, "worlds-file-native");
          for (const entry of await readdir(worldsRoot).catch(() => []))
            if (entry.startsWith(`.staging-${worldId}-`))
              await rm(join(worldsRoot, entry), {
                recursive: true,
                force: true,
              });
        }
      },
    );
  }
  #uploadPath(uploadId: string): string {
    return join(this.#root, "uploads", `${uploadId}.zip`);
  }
}

function validateManifest(value: unknown, limits: ArchiveLimits): Manifest {
  if (!record(value))
    throw new WorldArchiveError(
      "invalid_archive",
      "Archive manifest must be an object",
    );
  if (value.format !== worldArchiveFormat)
    throw new WorldArchiveError(
      "unsupported_format",
      "Unsupported world archive format",
    );
  if (
    Object.keys(value).sort().join() !==
      [
        "format",
        "appVersion",
        "exportedAt",
        "worldName",
        "archivedWorldId",
        "head",
        "files",
      ]
        .sort()
        .join() ||
    typeof value.appVersion !== "string" ||
    typeof value.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    typeof value.worldName !== "string" ||
    value.worldName.trim() === "" ||
    Array.from(value.worldName).length > 160 ||
    value.worldName.includes("\r") ||
    value.worldName.includes("\n") ||
    value.worldName.includes(String.fromCharCode(0)) ||
    typeof value.archivedWorldId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value.archivedWorldId) ||
    typeof value.head !== "string" ||
    !/^(genesis|commit:[1-9][0-9]*)$/u.test(value.head) ||
    !Array.isArray(value.files)
  )
    throw new WorldArchiveError(
      "invalid_archive",
      "Archive manifest has invalid fields",
    );
  const seen = new Set<string>();
  if (value.files.length + 1 > limits.entries)
    throw new WorldArchiveError("limit_exceeded", "Too many archive files");
  for (const file of value.files) {
    if (
      !record(file) ||
      Object.keys(file).sort().join() !== "bytes,path,sha256" ||
      typeof file.path !== "string" ||
      !file.path.startsWith("world/") ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new WorldArchiveError(
        "invalid_archive",
        "Invalid archive file manifest",
      );
    archivePath(file.path);
    const key = file.path.normalize("NFKC").toLowerCase();
    if (seen.has(key))
      throw new WorldArchiveError("unsafe_path", "Duplicate manifest path");
    seen.add(key);
  }
  return value as unknown as Manifest;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identity(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value))
    throw new WorldArchiveError(
      "unsafe_path",
      "Invalid archive operation identity",
    );
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function archiveBaseName(name: string): string {
  return (
    name
      .normalize("NFKC")
      .replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
      .replaceAll(/^[.-]+|[.-]+$/gu, "")
      .slice(0, 80) || "world"
  );
}
async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}
async function appVersion(): Promise<string> {
  let directory = import.meta.dirname;
  for (;;) {
    try {
      const value = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ) as { name: string; version: string };
      if (value.name === "narraeon") return value.version;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Application version is unavailable");
    directory = parent;
  }
}
