import { isAbsolute, win32 } from "node:path";
import { inflateRawSync } from "node:zlib";

import { portableContentTreePathKey } from "../../protocol/contentTree.ts";
import {
  defaultContentWorkspaceLimits,
  maximumPortableContentArchiveBytes,
  type ContentWorkspaceLimits,
} from "./ContentLimits.ts";
import {
  CurrentTreeContentLibrary,
  type CurrentTreeContentPackageOperationLease,
  type CurrentTreeContentLibraryOptions,
  InvalidContentTreeError,
} from "./CurrentTreeContentLibrary.ts";
import type { ContentTreeFile } from "./ContentTreeFile.ts";
import {
  inspectContentPackageCurrentTree,
  isContentPackageWorldDocumentPath,
  worldDocumentTextRequirement,
} from "./FileNativeContentTree.ts";
export {
  CurrentTreeContentPackageBusyError,
  CurrentTreeContentLibraryError,
  CurrentTreeContentPackageNotFoundError,
  InvalidContentTreeError,
} from "./CurrentTreeContentLibrary.ts";
export type {
  CurrentTreeContentPackageOperationLease,
  EditableContentPackageDetail,
  EditableContentPackageSummary,
} from "./CurrentTreeContentLibrary.ts";
export type { ContentTreeFile } from "./ContentTreeFile.ts";
export type { ContentWorkspaceLimits } from "./ContentLimits.ts";

const portableTreeUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const zipPathUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const defaultLimits = defaultContentWorkspaceLimits;

export interface ContentWorkspaceOperationOptions {
  signal?: AbortSignal;
  waitForLease?: boolean;
}

export interface PortableContentPackageExport {
  fileName: string;
  archive: Buffer;
}

export type ContentPackageImportErrorCode =
  "invalid_zip" | "limit_exceeded" | "unsafe_path" | "unsupported_file_type";

export class ContentPackageImportError extends Error {
  readonly code: ContentPackageImportErrorCode;

  constructor(code: ContentPackageImportErrorCode, message: string) {
    super(message);
    this.name = "ContentPackageImportError";
    this.code = code;
  }
}

interface PackageFile {
  path: string;
  contents: Buffer;
}

export class ContentWorkspace {
  readonly #currentTreeLibrary: CurrentTreeContentLibrary;
  readonly #limits: ContentWorkspaceLimits;
  readonly #beforePortableContentExport:
    (() => void | Promise<void>) | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    dataRoot: string,
    options: {
      limits?: Partial<ContentWorkspaceLimits>;
      currentTree?: Omit<CurrentTreeContentLibraryOptions, "limits">;
      beforePortableContentExport?: () => void | Promise<void>;
    } = {},
  ) {
    this.#limits = normalizeLimits(options.limits);
    this.#beforePortableContentExport = options.beforePortableContentExport;
    this.#currentTreeLibrary = new CurrentTreeContentLibrary(dataRoot, {
      limits: this.#limits,
      ...options.currentTree,
    });
  }

  createCurrentTreeContentPackage() {
    return this.#currentTreeLibrary.createPackage(
      minimalFileNativeContentScaffold(),
    );
  }

  listCurrentTreeContentPackages() {
    return this.#currentTreeLibrary.listPackages();
  }

  readCurrentTreeContentPackage(localId: string) {
    return this.#currentTreeLibrary.readPackage(localId);
  }

  beginCurrentTreeContentPackageOperation(
    localId: string,
  ): Promise<CurrentTreeContentPackageOperationLease> {
    return this.#currentTreeLibrary.acquireOperationLease(localId);
  }

  inspectCurrentTreeContentPackage(files: readonly ContentTreeFile[]) {
    return inspectContentPackageCurrentTree(files);
  }

  replaceCurrentTreeContentPackage(
    localId: string,
    files: readonly ContentTreeFile[],
    options: ContentWorkspaceOperationOptions = {},
  ) {
    return this.#currentTreeLibrary.replaceCurrentTree(localId, files, options);
  }

  importPortableContentPackageArchive(
    archive: Buffer,
    options: ContentWorkspaceOperationOptions = {},
  ) {
    return this.#mutate(async () => {
      const files = readPortableContentArchive(
        archive,
        this.#limits,
        options.signal,
      );
      options.signal?.throwIfAborted();
      const currentTree = files.map(toCurrentTreeFile);
      return this.#currentTreeLibrary.importPackage(
        currentTree,
        options.signal === undefined ? {} : { signal: options.signal },
      );
    });
  }

  copyCurrentTreeContentPackage(
    localId: string,
    options: ContentWorkspaceOperationOptions = {},
  ) {
    return this.#mutate(() =>
      this.#currentTreeLibrary.copyPackage(
        localId,
        options.signal === undefined ? {} : { signal: options.signal },
      ),
    );
  }

  deleteCurrentTreeContentPackage(
    localId: string,
    options: ContentWorkspaceOperationOptions = {},
  ) {
    return this.#mutate(() =>
      this.#currentTreeLibrary.deletePackage(localId, options),
    );
  }

  renameCurrentTreeContentPackage(
    localId: string,
    name: string,
    options: ContentWorkspaceOperationOptions = {},
  ) {
    return this.#mutate(() =>
      this.#currentTreeLibrary.renamePackage(localId, name, options),
    );
  }

  exportCurrentTreeContentPackage(
    localId: string,
    options: ContentWorkspaceOperationOptions = {},
  ): Promise<PortableContentPackageExport> {
    return this.#mutate(async () => {
      options.signal?.throwIfAborted();
      const package_ = await this.#currentTreeLibrary.readPackage(localId);
      if (package_.status !== "usable") {
        throw new InvalidContentTreeError(
          "只有完整有效的内容包才能导出；请先修复全部校验问题",
        );
      }
      await this.#beforePortableContentExport?.();
      options.signal?.throwIfAborted();
      const archive = createPortableContentArchive(package_.files);
      await crashProcessAtPortableContentExportEdge("after_archive_created");
      options.signal?.throwIfAborted();
      return {
        fileName: `${portableArchiveBaseName(package_.displayName)}.zip`,
        archive,
      };
    });
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: () => void = () => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/**
 * A new package is immediately valid and editable. These files are a protocol
 * scaffold, not a sample story: an authoring model replaces the placeholders
 * and extends the tree without first having to reconstruct hidden control
 * formats from diagnostics.
 */
export function minimalFileNativeContentScaffold(): ContentTreeFile[] {
  return [
    {
      path: "opening.md",
      contents: `你站在一个尚待创作的世界入口，眼前的地点、人物与局面仍等待作者补全。风从没有名字的方向吹过来，一个还没有面孔的人正朝你走近，脚步声一下比一下清楚，最后停在你面前。
`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.current
  ref: current-situation
  title: 待创作世界
  summary: 当前正在发生且接下来不能忘记的短期局面。
  aliases: []
地点: 未设定
在场: []
正在发生: 未设定
短期连续性: []
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 24, required: false }
  - slot: { kind: catalog, directory: locations, maxEntries: 24, required: false }
  - slot: { kind: catalog, directory: items, maxEntries: 24, required: false }
  - slot: { kind: catalog, directory: rules, maxEntries: 24, required: false }
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`,
    },
    {
      path: "control/blocks/world.md",
      contents: `<!-- 本文件只写这个世界特有的规则。通用裁决与状态维护判据由主持预设提供，每条游玩调用链都会加载，不要在这里重复。 -->

# 本世界的题材与专属规则

## 题材与边界

（待创作：这个世界的题材、基调，以及可以发生和不该发生的事。）

## 本世界的文档与保存位置

（待创作：这个世界有哪些文档类型，某类结果该写进哪一份。例如「人物的修为变化写入该人物文档的『修为』字段」。未在这里列出的按通用判据处理。）

## 专属规则

（待创作：只有这个世界成立的语义规则，例如修为顺序、关系或货币的含义。若该规则已是独立世界文档，这里只需指出该去看哪一份。）
`,
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1
views: []
`,
    },
  ];
}

function readPortableContentArchive(
  archive: Buffer,
  limits: ContentWorkspaceLimits,
  signal: AbortSignal | undefined,
): PackageFile[] {
  signal?.throwIfAborted();
  if (archive.byteLength > maximumPortableContentArchiveBytes(limits)) {
    throw new ContentPackageImportError(
      "limit_exceeded",
      "zip 内容包自身大小超过安全上限",
    );
  }
  try {
    const files = parseZipArchive(archive, limits);
    signal?.throwIfAborted();
    return files;
  } catch (error: unknown) {
    if (error instanceof ContentPackageImportError || isAbortError(error)) {
      throw error;
    }
    throw new ContentPackageImportError(
      "invalid_zip",
      "zip 内容包结构无效或已损坏",
    );
  }
}

function parseZipArchive(
  archive: Buffer,
  limits: ContentWorkspaceLimits,
): PackageFile[] {
  const endRecords = findZipEndRecords(archive);
  if (endRecords.length !== 1) {
    throw invalidZip("zip 包含 ambiguous EOCD");
  }
  return parseZipArchiveAtEnd(archive, limits, endRecords[0]!);
}

function createPortableContentArchive(
  files: readonly ContentTreeFile[],
): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const file of [...files].sort((left, right) =>
    compareStrings(left.path, right.path),
  )) {
    const path = Buffer.from(file.path, "utf8");
    const contents =
      file.encoding === "base64"
        ? Buffer.from(file.contents, "base64")
        : Buffer.from(file.contents, "utf8");
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.byteLength, 18);
    localHeader.writeUInt32LE(contents.byteLength, 22);
    localHeader.writeUInt16LE(path.byteLength, 26);
    const localRecord = Buffer.concat([localHeader, path, contents]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.byteLength, 20);
    centralHeader.writeUInt32LE(contents.byteLength, 24);
    centralHeader.writeUInt16LE(path.byteLength, 28);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, path]));
    localOffset += localRecord.byteLength;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function portableArchiveBaseName(displayName: string): string {
  const normalized = displayName
    .normalize("NFKC")
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
    .replaceAll(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 80);
  return normalized.length === 0 ? "内容包" : normalized;
}

function parseZipArchiveAtEnd(
  archive: Buffer,
  limits: ContentWorkspaceLimits,
  endOffset: number,
): PackageFile[] {
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralBytes = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw invalidZip("不支持多磁盘 zip 内容包");
  }
  if (
    totalEntries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw invalidZip("V1 不支持 ZIP64 内容包");
  }
  const centralEnd = centralOffset + centralBytes;
  if (centralEnd > endOffset || centralEnd < centralOffset) {
    throw invalidZip("zip 中央目录越界");
  }

  const files: PackageFile[] = [];
  const normalizedPathKeys = new Set<string>();
  const dataRanges: { start: number; end: number }[] = [];
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    assertBufferRange(archive, cursor, 46, "zip 中央目录条目不完整");
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw invalidZip("zip 中央目录签名无效");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const uncompressedBytes = archive.readUInt32LE(cursor + 24);
    const pathBytes = archive.readUInt16LE(cursor + 28);
    const extraBytes = archive.readUInt16LE(cursor + 30);
    const commentBytes = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordBytes = 46 + pathBytes + extraBytes + commentBytes;
    assertBufferRange(archive, cursor, recordBytes, "zip 中央目录条目越界");
    if (cursor + recordBytes > centralEnd) {
      throw invalidZip("zip 中央目录条目超出声明范围");
    }
    const rawPath = decodeZipPath(
      archive.subarray(cursor + 46, cursor + 46 + pathBytes),
    );
    const normalizedPath = normalizePackagePath(rawPath);
    const normalizedPathKey = portableContentTreePathKey(normalizedPath);
    if (normalizedPathKeys.has(normalizedPathKey)) {
      throw new ContentPackageImportError(
        "unsafe_path",
        `zip 内容包包含重复规范化路径：${normalizedPath}`,
      );
    }
    normalizedPathKeys.add(normalizedPathKey);
    if (startDisk !== 0) {
      throw invalidZip("zip 条目引用了其他磁盘");
    }
    if ((flags & 0x2041) !== 0) {
      throw invalidZip("zip 内容包不得包含加密条目");
    }
    if (method !== 0 && method !== 8) {
      throw invalidZip(`zip 条目使用不支持的压缩方法：${normalizedPath}`);
    }

    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    const directoryByMode = unixType === 0x4000;
    const directoryByName = rawPath.endsWith("/");
    const directoryByDosAttribute = (externalAttributes & 0x10) !== 0;
    const isDirectory =
      directoryByMode || directoryByName || directoryByDosAttribute;
    if ((externalAttributes & 0x08) !== 0) {
      throw new ContentPackageImportError(
        "unsupported_file_type",
        `zip 内容包不得包含卷标条目：${normalizedPath}`,
      );
    }
    if (unixType === 0xa000) {
      throw new ContentPackageImportError(
        "unsupported_file_type",
        `zip 内容包不得包含符号链接：${normalizedPath}`,
      );
    }
    if (unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000) {
      throw new ContentPackageImportError(
        "unsupported_file_type",
        `zip 内容包不得包含特殊文件：${normalizedPath}`,
      );
    }
    if (isDirectory) {
      if (compressedBytes !== 0 || uncompressedBytes !== 0) {
        throw invalidZip(`zip 目录条目不得携带内容：${normalizedPath}`);
      }
      cursor += recordBytes;
      continue;
    }

    if (files.length + 1 > limits.maxFiles) {
      throw new ContentPackageImportError(
        "limit_exceeded",
        "内容包文件数量超过上限",
      );
    }
    if (uncompressedBytes > limits.maxFileBytes) {
      throw new ContentPackageImportError(
        "limit_exceeded",
        `内容包单文件大小超过上限：${normalizedPath}`,
      );
    }
    totalBytes += uncompressedBytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ContentPackageImportError(
        "limit_exceeded",
        "内容包总解包大小超过上限",
      );
    }

    assertBufferRange(archive, localOffset, 30, "zip 本地条目不完整");
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalidZip("zip 本地条目签名无效");
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localPathBytes = archive.readUInt16LE(localOffset + 26);
    const localExtraBytes = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localPathBytes + localExtraBytes;
    const dataEnd = dataStart + compressedBytes;
    assertBufferRange(
      archive,
      localOffset,
      30 + localPathBytes + localExtraBytes + compressedBytes,
      "zip 本地条目数据越界",
    );
    if (dataEnd > centralOffset) {
      throw invalidZip("zip 本地条目覆盖中央目录");
    }
    if (
      localFlags !== flags ||
      localMethod !== method ||
      decodeZipPath(
        archive.subarray(localOffset + 30, localOffset + 30 + localPathBytes),
      ) !== rawPath
    ) {
      throw invalidZip("zip 本地条目与中央目录不一致");
    }
    if (
      dataRanges.some(
        (range) => localOffset < range.end && dataEnd > range.start,
      )
    ) {
      throw invalidZip("zip 条目数据范围重叠");
    }
    dataRanges.push({ start: localOffset, end: dataEnd });
    const compressed = archive.subarray(dataStart, dataEnd);
    let contents: Buffer;
    if (method === 0) {
      if (compressedBytes !== uncompressedBytes) {
        throw invalidZip(`zip store 条目大小不一致：${normalizedPath}`);
      }
      contents = Buffer.from(compressed);
    } else {
      try {
        contents = inflateRawSync(compressed, {
          maxOutputLength: limits.maxFileBytes + 1,
        });
      } catch {
        throw invalidZip(`zip deflate 条目无法解压：${normalizedPath}`);
      }
    }
    if (
      contents.byteLength !== uncompressedBytes ||
      crc32(contents) !== expectedCrc
    ) {
      throw invalidZip(`zip 条目大小或 CRC 校验失败：${normalizedPath}`);
    }
    files.push({ path: normalizedPath, contents });
    cursor += recordBytes;
  }
  if (cursor !== centralEnd) {
    throw invalidZip("zip 中央目录大小与条目不一致");
  }
  return files;
}

function findZipEndRecords(archive: Buffer): number[] {
  const minimumEndBytes = 22;
  if (archive.byteLength < minimumEndBytes) {
    throw invalidZip("zip 文件过短");
  }
  const earliest = Math.max(0, archive.byteLength - 65_557);
  const candidates: number[] = [];
  for (
    let offset = archive.byteLength - minimumEndBytes;
    offset >= earliest;
    offset -= 1
  ) {
    const centralBytes = archive.readUInt32LE(offset + 12);
    const centralOffset = archive.readUInt32LE(offset + 16);
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + minimumEndBytes + archive.readUInt16LE(offset + 20) ===
        archive.byteLength &&
      centralOffset + centralBytes === offset
    ) {
      candidates.push(offset);
    }
  }
  if (candidates.length === 0) {
    throw invalidZip("zip 缺少中央目录结束记录");
  }
  return candidates;
}

function decodeZipPath(contents: Buffer): string {
  try {
    return zipPathUtf8Decoder.decode(contents);
  } catch {
    throw invalidZip("zip 条目路径不是合法 UTF-8");
  }
}

function assertBufferRange(
  buffer: Buffer,
  offset: number,
  bytes: number,
  message: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(bytes) ||
    offset < 0 ||
    bytes < 0 ||
    offset + bytes > buffer.byteLength ||
    offset + bytes < offset
  ) {
    throw invalidZip(message);
  }
}

function invalidZip(message: string): ContentPackageImportError {
  return new ContentPackageImportError("invalid_zip", message);
}

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function toCurrentTreeFile(file: PackageFile): ContentTreeFile {
  try {
    return {
      path: file.path,
      contents: portableTreeUtf8Decoder.decode(file.contents),
    };
  } catch {
    if (isContentPackageWorldDocumentPath(file.path)) {
      throw new ContentPackageImportError(
        "unsupported_file_type",
        worldDocumentTextRequirement(file.path),
      );
    }
    return {
      path: file.path,
      contents: file.contents.toString("base64"),
      encoding: "base64",
    };
  }
}

function normalizePackagePath(input: string): string {
  if (
    input.length === 0 ||
    input.includes("\0") ||
    isAbsolute(input) ||
    win32.isAbsolute(input)
  ) {
    throw new ContentPackageImportError(
      "unsafe_path",
      "内容包路径必须是非空相对路径",
    );
  }
  const segments = input.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ContentPackageImportError(
      "unsafe_path",
      "内容包路径不得包含父级穿越",
    );
  }
  const normalizedSegments = segments
    .filter((segment) => segment.length > 0 && segment !== ".")
    .map((segment) => segment.normalize("NFC"));
  if (normalizedSegments.length === 0) {
    throw new ContentPackageImportError(
      "unsafe_path",
      "内容包路径规范化后不能为空",
    );
  }
  for (const segment of normalizedSegments) {
    assertPortablePathSegment(segment);
  }
  const normalized = normalizedSegments.join("/");
  if (Buffer.byteLength(normalized, "utf8") > 4_096) {
    throw new ContentPackageImportError(
      "unsafe_path",
      "内容包路径长度超过安全上限",
    );
  }
  return normalized;
}

function assertPortablePathSegment(segment: string): void {
  if (
    Buffer.byteLength(segment, "utf8") > 255 ||
    hasUnsafePortableCharacter(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ")
  ) {
    throw new ContentPackageImportError(
      "unsafe_path",
      "内容包路径包含跨平台不安全的名称",
    );
  }
  const baseName = segment.split(".", 1)[0]?.toUpperCase();
  if (
    baseName !== undefined &&
    /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(baseName)
  ) {
    throw new ContentPackageImportError(
      "unsafe_path",
      "内容包路径使用了保留设备名",
    );
  }
}

function hasUnsafePortableCharacter(segment: string): boolean {
  return [...segment].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      '<>:"|?*'.includes(character)
    );
  });
}

function normalizeLimits(
  input: Partial<ContentWorkspaceLimits> | undefined,
): ContentWorkspaceLimits {
  const limits = { ...defaultLimits, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} 必须是正安全整数`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new TypeError("maxFileBytes 不得超过 maxTotalBytes");
  }
  return limits;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function crashProcessAtPortableContentExportEdge(
  edge: "after_archive_created",
): Promise<void> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_PORTABLE_CONTENT_EXPORT_EDGE !==
      edge
  ) {
    return;
  }
  process.kill(process.pid, "SIGKILL");
  await new Promise<never>(() => undefined);
}
