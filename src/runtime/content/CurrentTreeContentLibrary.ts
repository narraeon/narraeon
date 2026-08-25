import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import {
  link,
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";

import { portableContentTreePathKey } from "../../protocol/contentTree.ts";
import {
  defaultContentWorkspaceLimits,
  type ContentWorkspaceLimits,
} from "./ContentLimits.ts";
import type { ContentTreeFile } from "./ContentTreeFile.ts";
import {
  type FileNativeContentDocument,
  type FileNativeContentInspection,
  type FileNativeContentIssue,
  inspectContentPackageCurrentTree,
  isContentPackageWorldDocumentPath,
  worldDocumentTextRequirement,
} from "./FileNativeContentTree.ts";

const localIdPattern =
  /^package-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localMetadataFileName = "local.json";
const currentTreeFileName = "current-tree.json";
const currentTreePreviousFileName = ".current-tree.previous.json";
const defaultLimits = defaultContentWorkspaceLimits;

interface StoredLocalMetadata {
  schemaVersion: 1;
  localId: string;
  /**
   * Author-chosen library name. Absent means the display name is still derived
   * from the package contents, which is the right default for a fresh package
   * and for everything imported before renaming existed.
   */
  name?: string;
}

interface StoredCurrentTree {
  schemaVersion: 1;
  files: ContentTreeFile[];
}

interface CurrentTreeContentPackageLockMarker {
  schemaVersion: 1;
  pid: number;
  token: string;
}

export interface EditableContentPackageSummary {
  localId: string;
  displayName: string;
  status: "usable" | "needs_repair";
  documentCount: number;
  issueCount: number;
}

export interface EditableContentPackageDetail extends EditableContentPackageSummary {
  files: ContentTreeFile[];
  documents: FileNativeContentDocument[];
  issues: FileNativeContentIssue[];
  opening: FileNativeContentInspection["opening"];
  control: FileNativeContentInspection["control"];
}

export interface CurrentTreeContentLibraryOptions {
  limits?: Partial<ContentWorkspaceLimits>;
  beforePackagePublish?: () => void | Promise<void>;
  beforeCurrentTreeReplace?: () => void | Promise<void>;
}

export interface CurrentTreeMutationOptions {
  signal?: AbortSignal;
  waitForLease?: boolean;
}

export interface CurrentTreeContentPackageOperationLease {
  package: EditableContentPackageDetail;
  replace(
    files: readonly ContentTreeFile[],
    options?: CurrentTreeMutationOptions,
  ): Promise<EditableContentPackageDetail>;
  release(): void;
}

export class CurrentTreeContentPackageNotFoundError extends Error {
  constructor() {
    super("没有找到指定内容包");
    this.name = "CurrentTreeContentPackageNotFoundError";
  }
}

export class CurrentTreeContentLibraryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CurrentTreeContentLibraryError";
  }
}

export class CurrentTreeContentPackageBusyError extends CurrentTreeContentLibraryError {
  constructor() {
    super("另一个源内容包保存或模型 operation 正在进行");
    this.name = "CurrentTreeContentPackageBusyError";
  }
}

export class InvalidContentTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContentTreeError";
  }
}

/**
 * Persists one logical current tree per local package. The tree is stored as a
 * single replaceable envelope so saving cannot expose half of two file sets.
 */
export class CurrentTreeContentLibrary {
  readonly #locksRoot: string;
  readonly #packagesRoot: string;
  readonly #stagingRoot: string;
  readonly #limits: ContentWorkspaceLimits;
  readonly #beforePackagePublish: (() => void | Promise<void>) | undefined;
  readonly #beforeCurrentTreeReplace: (() => void | Promise<void>) | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    dataRoot: string,
    options: CurrentTreeContentLibraryOptions = {},
  ) {
    this.#locksRoot = join(dataRoot, "content", ".package-locks");
    this.#packagesRoot = join(dataRoot, "content", "packages");
    this.#stagingRoot = join(dataRoot, "content", ".package-staging");
    this.#limits = normalizeLimits(options.limits);
    this.#beforePackagePublish = options.beforePackagePublish;
    this.#beforeCurrentTreeReplace = options.beforeCurrentTreeReplace;
  }

  createPackage(
    files: readonly ContentTreeFile[] = [],
  ): Promise<EditableContentPackageSummary> {
    return this.#mutate(async () => {
      const normalized = normalizeCurrentContentTreeFiles(files, this.#limits);
      const package_ = await this.#publishNewPackage(normalized);
      return packageSummary(package_);
    });
  }

  importPackage(
    files: readonly ContentTreeFile[],
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageDetail> {
    return this.#mutate(async () => {
      options.signal?.throwIfAborted();
      const normalized = normalizeCurrentContentTreeFiles(files, this.#limits);
      return this.#publishNewPackage(normalized, options.signal);
    });
  }

  copyPackage(
    localId: string,
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageDetail> {
    return this.#mutate(async () => {
      options.signal?.throwIfAborted();
      const source = await this.readPackage(localId);
      options.signal?.throwIfAborted();
      return this.#publishNewPackage(source.files, options.signal);
    });
  }

  deletePackage(
    localId: string,
    options: CurrentTreeMutationOptions = {},
  ): Promise<void> {
    return this.#mutate(async () => {
      const lease = await this.acquireOperationLease(localId, {
        wait: options.waitForLease !== false,
      });
      try {
        options.signal?.throwIfAborted();
        await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
        const tombstonePath = join(
          this.#stagingRoot,
          `.deleted-${localId}-${randomUUID()}`,
        );
        try {
          options.signal?.throwIfAborted();
          await rename(this.#packageRoot(localId), tombstonePath);
          await syncDirectory(this.#packagesRoot);
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          throw new CurrentTreeContentLibraryError("无法原子删除内容包", {
            cause: error,
          });
        }
        await rm(tombstonePath, { force: true, recursive: true }).catch(
          () => undefined,
        );
      } finally {
        lease.release();
      }
    });
  }

  async listPackages(): Promise<EditableContentPackageSummary[]> {
    let entries;
    try {
      entries = await readdir(this.#packagesRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return [];
      }
      throw new CurrentTreeContentLibraryError("无法列出内容包", {
        cause: error,
      });
    }
    const packages: EditableContentPackageSummary[] = [];
    for (const entry of entries.sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      if (!entry.isDirectory() || !localIdPattern.test(entry.name)) {
        throw new CurrentTreeContentLibraryError("内容包库包含无法识别的条目");
      }
      const detail = await this.readPackage(entry.name);
      packages.push(packageSummary(detail));
    }
    return packages;
  }

  async readPackage(localId: string): Promise<EditableContentPackageDetail> {
    const packageRoot = this.#packageRoot(localId);
    const metadata = await readJsonFile(
      join(packageRoot, localMetadataFileName),
      () => new CurrentTreeContentPackageNotFoundError(),
      "内容包本地外壳损坏",
    );
    if (!isStoredMetadata(metadata) || metadata.localId !== localId) {
      throw new CurrentTreeContentLibraryError("内容包本地外壳损坏");
    }
    const storedTree = await readJsonFile(
      join(packageRoot, currentTreeFileName),
      () => new CurrentTreeContentLibraryError("内容包缺少当前树"),
      "内容包当前树损坏",
    );
    if (!isStoredCurrentTree(storedTree)) {
      throw new CurrentTreeContentLibraryError("内容包当前树损坏");
    }
    let files: ContentTreeFile[];
    try {
      files = normalizeCurrentContentTreeFiles(storedTree.files, this.#limits);
    } catch (error: unknown) {
      throw new CurrentTreeContentLibraryError("内容包当前树损坏", {
        cause: error,
      });
    }
    return detail(
      localId,
      files,
      inspectContentPackageCurrentTree(files),
      metadata.name,
    );
  }

  /**
   * Name a package in the local library. The name lives in the package's own
   * local shell, not in its content, so renaming never touches a document the
   * runtime reads during play.
   */
  renamePackage(
    localId: string,
    name: string,
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageSummary> {
    return this.#mutate(async () => {
      const trimmed = name.trim();
      if (!validPackageName(trimmed))
        throw new CurrentTreeContentLibraryError(
          "内容包名称必须是 1 到 160 个字符，且不含换行",
        );
      const lease = await this.acquireOperationLease(localId, {
        wait: options.waitForLease !== false,
      });
      try {
        options.signal?.throwIfAborted();
        const packageRoot = this.#packageRoot(localId);
        const metadata = await readJsonFile(
          join(packageRoot, localMetadataFileName),
          () => new CurrentTreeContentPackageNotFoundError(),
          "内容包本地外壳损坏",
        );
        if (!isStoredMetadata(metadata) || metadata.localId !== localId)
          throw new CurrentTreeContentLibraryError("内容包本地外壳损坏");
        const temporaryPath = join(packageRoot, `.local-${randomUUID()}.tmp`);
        try {
          await writeDurableNewFile(
            temporaryPath,
            serialize({
              schemaVersion: 1,
              localId,
              name: trimmed,
            } satisfies StoredLocalMetadata),
          );
          await rename(temporaryPath, join(packageRoot, localMetadataFileName));
          await syncDirectory(packageRoot);
        } catch (error: unknown) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
        return packageSummary(await this.readPackage(localId));
      } finally {
        lease.release();
      }
    });
  }

  replaceCurrentTree(
    localId: string,
    files: readonly ContentTreeFile[],
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageDetail> {
    return this.#mutate(async () => {
      const lease = await this.acquireOperationLease(localId, {
        wait: options.waitForLease !== false,
      });
      try {
        return await lease.replace(files, options);
      } finally {
        lease.release();
      }
    });
  }

  async acquireOperationLease(
    localId: string,
    options: { wait?: boolean } = {},
  ): Promise<CurrentTreeContentPackageOperationLease> {
    this.#packageRoot(localId);
    await mkdir(this.#locksRoot, { recursive: true, mode: 0o700 });
    const lockPath = this.#packageLockPath(localId);
    const reclaimPath = this.#packageReclaimPath(localId);
    await clearDeadPackageLockMarker(reclaimPath);
    if (await pathExists(reclaimPath)) {
      throw new CurrentTreeContentPackageBusyError();
    }

    const marker = createPackageLockMarker();
    const temporaryPath = join(
      this.#locksRoot,
      `.${localId}.${marker.token}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporaryPath, lockPath);
      } catch (error: unknown) {
        if (!isNodeErrorCode(error, "EEXIST")) throw error;
        if (options.wait === true) {
          await this.#waitForPackageLock(lockPath, reclaimPath, temporaryPath);
        } else if (
          !(await this.#tryReplaceDeadPackageLock(
            lockPath,
            reclaimPath,
            temporaryPath,
          ))
        ) {
          throw new CurrentTreeContentPackageBusyError();
        }
      }
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (error instanceof CurrentTreeContentPackageBusyError) throw error;
      throw new CurrentTreeContentLibraryError("无法取得源内容包保存 owner", {
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }

    let released = false;
    try {
      const package_ = await this.readPackage(localId);
      return {
        package: structuredClone(package_),
        replace: async (files, options = {}) => {
          if (released) throw new CurrentTreeContentPackageBusyError();
          options.signal?.throwIfAborted();
          const normalized = normalizeCurrentContentTreeFiles(
            files,
            this.#limits,
          );
          return this.#replaceNormalizedCurrentTree(
            localId,
            normalized,
            options.signal,
          );
        },
        release: () => {
          if (released) return;
          released = true;
          releasePackageOperationLockSync(lockPath, marker.token);
        },
      };
    } catch (error: unknown) {
      releasePackageOperationLockSync(lockPath, marker.token);
      throw error;
    }
  }

  async #replaceNormalizedCurrentTree(
    localId: string,
    normalized: ContentTreeFile[],
    signal?: AbortSignal,
  ): Promise<EditableContentPackageDetail> {
    const packageRoot = this.#packageRoot(localId);
    const temporaryPath = join(
      packageRoot,
      `.current-tree-${randomUUID()}.tmp`,
    );
    const previousPath = join(packageRoot, currentTreePreviousFileName);
    try {
      signal?.throwIfAborted();
      await writeDurableNewFile(
        temporaryPath,
        serialize({
          schemaVersion: 1,
          files: normalized,
        } satisfies StoredCurrentTree),
      );
      await crashProcessAtCurrentTreeEdge("after_current_tree_staging");
      signal?.throwIfAborted();
      await this.#beforeCurrentTreeReplace?.();
      signal?.throwIfAborted();
      await unlink(previousPath).catch((error: unknown) => {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
      });
      await link(join(packageRoot, currentTreeFileName), previousPath);
      await syncDirectory(packageRoot);
      await rename(temporaryPath, join(packageRoot, currentTreeFileName));
      await syncDirectory(packageRoot);
      await crashProcessAtCurrentTreeEdge("after_current_tree_replace");
      failCurrentTreeAfterReplaceForTest();
      await unlink(previousPath).catch(() => undefined);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      let rollbackFailure: unknown;
      if (await pathExists(previousPath).catch(() => false)) {
        try {
          await rename(previousPath, join(packageRoot, currentTreeFileName));
          await syncDirectory(packageRoot);
        } catch (rollbackError: unknown) {
          rollbackFailure = rollbackError;
        }
      }
      if (rollbackFailure !== undefined) {
        throw new CurrentTreeContentLibraryError(
          "无法恢复修改前的内容包当前树",
          {
            cause:
              rollbackFailure instanceof Error ? rollbackFailure : undefined,
          },
        );
      }
      if (error instanceof InvalidContentTreeError || isAbortError(error)) {
        throw error;
      }
      throw new CurrentTreeContentLibraryError(
        error instanceof Error ? error.message : "无法原子替换内容包当前树",
        { cause: error },
      );
    }
    return detail(
      localId,
      normalized,
      inspectContentPackageCurrentTree(normalized),
    );
  }

  async #publishNewPackage(
    normalized: ContentTreeFile[],
    signal?: AbortSignal,
  ): Promise<EditableContentPackageDetail> {
    const localId = `package-${randomUUID()}`;
    const stagingPath = join(this.#stagingRoot, localId);
    const finalPath = join(this.#packagesRoot, localId);
    await Promise.all([
      mkdir(this.#packagesRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 }),
    ]);
    try {
      signal?.throwIfAborted();
      await mkdir(stagingPath, { mode: 0o700 });
      await writeDurableNewFile(
        join(stagingPath, localMetadataFileName),
        serialize({
          schemaVersion: 1,
          localId,
        } satisfies StoredLocalMetadata),
      );
      await writeDurableNewFile(
        join(stagingPath, currentTreeFileName),
        serialize({
          schemaVersion: 1,
          files: normalized,
        } satisfies StoredCurrentTree),
      );
      await syncDirectory(stagingPath);
      await crashProcessAtCurrentTreeEdge("after_package_staging");
      signal?.throwIfAborted();
      await this.#beforePackagePublish?.();
      signal?.throwIfAborted();
      await rename(stagingPath, finalPath);
      await syncDirectory(this.#packagesRoot);
      await crashProcessAtCurrentTreeEdge("after_package_publish");
    } catch (error: unknown) {
      await rm(stagingPath, { force: true, recursive: true }).catch(
        () => undefined,
      );
      if (isAbortError(error)) throw error;
      throw new CurrentTreeContentLibraryError("无法原子发布内容包", {
        cause: error,
      });
    }
    return detail(
      localId,
      normalized,
      inspectContentPackageCurrentTree(normalized),
    );
  }

  #packageRoot(localId: string): string {
    if (!localIdPattern.test(localId)) {
      throw new CurrentTreeContentPackageNotFoundError();
    }
    return join(this.#packagesRoot, localId);
  }

  #packageLockPath(localId: string): string {
    return join(this.#locksRoot, `${localId}.mutation`);
  }

  #packageReclaimPath(localId: string): string {
    return join(this.#locksRoot, `${localId}.reclaim`);
  }

  async #tryReplaceDeadPackageLock(
    lockPath: string,
    reclaimPath: string,
    replacementPath: string,
  ): Promise<boolean> {
    const current = await readPackageLockMarker(lockPath);
    if (current === null || isProcessAlive(current.pid)) return false;

    const reclaim = createPackageLockMarker();
    const temporaryPath = join(
      this.#locksRoot,
      `.reclaim.${reclaim.token}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(reclaim)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, reclaimPath);
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      if (isNodeErrorCode(error, "EEXIST")) return false;
      throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    try {
      const verified = await readPackageLockMarker(lockPath);
      if (verified?.token !== current.token || isProcessAlive(current.pid)) {
        return false;
      }
      await unlink(lockPath).catch((error: unknown) => {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
      });
      await link(replacementPath, lockPath);
      return true;
    } finally {
      const owner = await readPackageLockMarker(reclaimPath);
      if (owner?.token === reclaim.token) {
        await unlink(reclaimPath).catch(() => undefined);
      }
    }
  }

  async #waitForPackageLock(
    lockPath: string,
    reclaimPath: string,
    replacementPath: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (
        (await this.#tryReplaceDeadPackageLock(
          lockPath,
          reclaimPath,
          replacementPath,
        )) ||
        (await link(replacementPath, lockPath)
          .then(() => true)
          .catch((error: unknown) => {
            if (isNodeErrorCode(error, "EEXIST")) return false;
            throw error;
          }))
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new CurrentTreeContentPackageBusyError();
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

function detail(
  localId: string,
  files: readonly ContentTreeFile[],
  inspection: FileNativeContentInspection,
  name?: string,
): EditableContentPackageDetail {
  return {
    ...summary(localId, inspection, name),
    files: files.map((file) => ({ ...file })),
    documents: structuredClone(inspection.documents),
    issues: structuredClone(inspection.issues),
    opening: inspection.opening,
    control: structuredClone(inspection.control),
  };
}

function summary(
  localId: string,
  inspection: FileNativeContentInspection,
  name?: string,
): EditableContentPackageSummary {
  return {
    localId,
    // An author-chosen name wins; without one the name still tracks whatever
    // the package currently contains.
    displayName: name ?? inspection.displayName,
    status: inspection.status,
    documentCount: inspection.documents.length,
    issueCount: inspection.issues.length,
  };
}

function packageSummary(
  package_: EditableContentPackageDetail,
): EditableContentPackageSummary {
  return {
    localId: package_.localId,
    displayName: package_.displayName,
    status: package_.status,
    documentCount: package_.documentCount,
    issueCount: package_.issueCount,
  };
}

export function normalizeCurrentContentTreeFiles(
  files: readonly ContentTreeFile[],
  limits: ContentWorkspaceLimits = defaultLimits,
): ContentTreeFile[] {
  if (files.length > limits.maxFiles) {
    throw new InvalidContentTreeError("内容包文件数量超过上限");
  }
  const normalized: ContentTreeFile[] = [];
  const portableKeys = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      typeof file.contents !== "string" ||
      (file.encoding !== undefined && file.encoding !== "base64")
    ) {
      throw new InvalidContentTreeError("内容包文件必须包含路径和文本内容");
    }
    const path = normalizeContentTreePath(file.path);
    if (
      isContentPackageWorldDocumentPath(path) &&
      file.encoding !== undefined
    ) {
      throw new InvalidContentTreeError(worldDocumentTextRequirement(path));
    }
    const leaf = basename(path).toLocaleLowerCase("en-US");
    if (leaf === "manifest.json" || leaf.endsWith(".package.json")) {
      throw new InvalidContentTreeError(
        `当前内容树不允许 manifest 文件：${path}`,
      );
    }
    const portableKey = portableContentTreePathKey(path);
    if (portableKeys.has(portableKey)) {
      throw new InvalidContentTreeError(`内容树包含重复规范化路径：${path}`);
    }
    portableKeys.add(portableKey);
    const bytes =
      file.encoding === "base64"
        ? decodeCanonicalBase64(file.contents, path).byteLength
        : Buffer.byteLength(file.contents, "utf8");
    if (bytes > limits.maxFileBytes) {
      throw new InvalidContentTreeError(`内容包单文件大小超过上限：${path}`);
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new InvalidContentTreeError("内容包总大小超过上限");
    }
    normalized.push({
      path,
      contents: file.contents,
      ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
    });
  }
  return normalized.sort((left, right) =>
    compareStrings(left.path, right.path),
  );
}

function decodeCanonicalBase64(contents: string, path: string): Buffer {
  if (
    contents.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      contents,
    )
  ) {
    throw new InvalidContentTreeError(
      `内容包二进制资源不是规范 Base64：${path}`,
    );
  }
  const decoded = Buffer.from(contents, "base64");
  if (decoded.toString("base64") !== contents) {
    throw new InvalidContentTreeError(
      `内容包二进制资源不是规范 Base64：${path}`,
    );
  }
  return decoded;
}

function normalizeContentTreePath(value: string): string {
  if (
    value.length === 0 ||
    [...value].length > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new InvalidContentTreeError(`内容树路径无效：${value}`);
  }
  const normalized = posix.normalize(value.normalize("NFC"));
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    Buffer.byteLength(normalized, "utf8") > 240 ||
    segments.length > 16 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 80 ||
        containsControlCharacter(segment),
    )
  ) {
    throw new InvalidContentTreeError(`内容树路径无效：${value}`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
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

async function writeDurableNewFile(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonFile(
  path: string,
  missing: () => Error,
  invalidMessage: string,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw missing();
    }
    throw new CurrentTreeContentLibraryError(invalidMessage, { cause: error });
  }
}

function isStoredMetadata(value: unknown): value is StoredLocalMetadata {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === (value.name === undefined ? 2 : 3) &&
    value.schemaVersion === 1 &&
    typeof value.localId === "string" &&
    localIdPattern.test(value.localId) &&
    (value.name === undefined ||
      (typeof value.name === "string" && validPackageName(value.name)))
  );
}

const packageNamePattern = /^[^\r\n]{1,160}$/u;

function validPackageName(name: string): boolean {
  return packageNamePattern.test(name);
}

function isStoredCurrentTree(value: unknown): value is StoredCurrentTree {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    value.schemaVersion === 1 &&
    Array.isArray(value.files)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createPackageLockMarker(): CurrentTreeContentPackageLockMarker {
  return { schemaVersion: 1, pid: process.pid, token: randomUUID() };
}

async function readPackageLockMarker(
  path: string,
): Promise<CurrentTreeContentPackageLockMarker | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsePackageLockMarker(value);
  } catch {
    return null;
  }
}

function parsePackageLockMarker(
  value: unknown,
): CurrentTreeContentPackageLockMarker | null {
  if (
    isPlainObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string" &&
    /^[0-9a-f-]{36}$/u.test(value.token)
  ) {
    return { schemaVersion: 1, pid: value.pid, token: value.token };
  }
  return null;
}

function releasePackageOperationLockSync(path: string, token: string): void {
  try {
    const current = parsePackageLockMarker(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    if (current?.token === token) unlinkSync(path);
  } catch (error: unknown) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
}

async function clearDeadPackageLockMarker(path: string): Promise<void> {
  const marker = await readPackageLockMarker(path);
  if (
    (marker !== null && !isProcessAlive(marker.pid)) ||
    (marker === null && (await pathExists(path)))
  ) {
    await unlink(path).catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeErrorCode(error, "ESRCH");
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

async function crashProcessAtCurrentTreeEdge(
  edge:
    | "after_current_tree_replace"
    | "after_current_tree_staging"
    | "after_package_publish"
    | "after_package_staging",
): Promise<void> {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_CURRENT_TREE_EDGE !== edge
  ) {
    return;
  }
  process.kill(process.pid, "SIGKILL");
  await new Promise<never>(() => undefined);
}

function failCurrentTreeAfterReplaceForTest(): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.NARRAEON_INTERNAL_TEST_FAIL_AFTER_CURRENT_TREE_REPLACE === "1"
  ) {
    throw new Error("simulated failure after current tree replace");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
