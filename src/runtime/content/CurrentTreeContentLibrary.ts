import { PackageScriptPermissions } from "../extension/PackageScriptPermissions.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { linkExclusive } from "../FileNativeExclusiveLink.ts";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";

import { portableContentTreePathKey } from "../../protocol/contentTree.ts";
import {
  assertSameGameplayMode,
  gameplayFile,
  gameplayPath,
  readGameplay,
  type Gameplay,
  type ResolutionScheme,
} from "../../protocol/gameplay.ts";
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
  schemaVersion: 2;
  localId: string;
  title: string;
}

interface LegacyStoredLocalMetadata {
  schemaVersion: 1;
  localId: string;
  name?: string;
}

interface StoredCurrentTree {
  schemaVersion: 1;
  files: ContentTreeFile[];
}

export interface EditableContentPackageSummary {
  gameplay: Gameplay;
  localId: string;
  title: string;
  status: "usable" | "needs_repair";
  documentCount: number;
  issueCount: number;
}

export interface EditableContentPackageDetail extends EditableContentPackageSummary {
  /** Digest of the whole current tree; a save must name the revision it was based on. */
  treeRevision: string;
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

export interface CurrentTreeReplaceOptions extends CurrentTreeMutationOptions {
  /** The `treeRevision` the caller's draft was opened from. */
  baseTreeRevision: string;
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
    super("The requested content package was not found");
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
    super("Another source-package save or model operation is still running");
    this.name = "CurrentTreeContentPackageBusyError";
  }
}

/**
 * The current tree changed after the caller's base revision. Nothing was
 * written; `current` is the tree the caller must reload before saving again.
 */
export class ContentTreeConflictError extends CurrentTreeContentLibraryError {
  readonly current: EditableContentPackageDetail;

  constructor(current: EditableContentPackageDetail) {
    super(
      "The content package changed after this draft was opened; load the latest tree before saving",
    );
    this.name = "ContentTreeConflictError";
    this.current = current;
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
  readonly #legacyLocksRoot: string;
  readonly #packagesRoot: string;
  readonly #stagingRoot: string;
  readonly #limits: ContentWorkspaceLimits;
  readonly #beforePackagePublish: (() => void | Promise<void>) | undefined;
  readonly #beforeCurrentTreeReplace: (() => void | Promise<void>) | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  #legacyLocksRemoval: Promise<void> | undefined;

  constructor(
    dataRoot: string,
    options: CurrentTreeContentLibraryOptions = {},
  ) {
    this.#legacyLocksRoot = join(dataRoot, "content", ".package-locks");
    this.#packagesRoot = join(dataRoot, "content", "packages");
    this.#stagingRoot = join(dataRoot, "content", ".package-staging");
    this.#limits = normalizeLimits(options.limits);
    this.#beforePackagePublish = options.beforePackagePublish;
    this.#beforeCurrentTreeReplace = options.beforeCurrentTreeReplace;
  }

  createPackage(input: {
    title: string;
    files?: readonly ContentTreeFile[];
  }): Promise<EditableContentPackageSummary> {
    return this.#mutate(async () => {
      const title = normalizePackageTitle(input.title);
      const normalized = normalizeCurrentContentTreeFiles(
        input.files ?? [],
        this.#limits,
      );
      const package_ = await this.#publishNewPackage(normalized, title);
      return packageSummary(package_);
    });
  }

  importPackage(
    input: { title: string; files: readonly ContentTreeFile[] },
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageDetail> {
    return this.#mutate(async () => {
      options.signal?.throwIfAborted();
      const title = normalizePackageTitle(input.title);
      const normalized = normalizeCurrentContentTreeFiles(
        input.files,
        this.#limits,
      );
      return this.#publishNewPackage(normalized, title, options.signal);
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
      return this.#publishNewPackage(
        source.files,
        source.title,
        options.signal,
      );
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
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          throw new CurrentTreeContentLibraryError(
            "Unable to delete the content package atomically",
            {
              cause: error,
            },
          );
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
      throw new CurrentTreeContentLibraryError(
        "Unable to list content packages",
        {
          cause: error,
        },
      );
    }
    const packages: EditableContentPackageSummary[] = [];
    for (const entry of entries.sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      if (!entry.isDirectory() || !localIdPattern.test(entry.name)) {
        throw new CurrentTreeContentLibraryError(
          "The content-package library contains an unrecognized entry",
        );
      }
      const detail = await this.readPackage(entry.name);
      packages.push(packageSummary(detail));
    }
    return packages;
  }

  async readScriptGrants(localId: string): Promise<string[]> {
    await this.readPackage(localId);
    return PackageScriptPermissions.read(this.#packageRoot(localId));
  }

  async scriptPermissions(
    localId: string,
    enabled?: boolean,
  ): Promise<{ enabled: boolean }> {
    const lease = await this.acquireOperationLease(localId, { wait: true });
    try {
      const root = this.#packageRoot(localId);
      if (enabled !== undefined)
        await PackageScriptPermissions.write(
          root,
          enabled
            ? PackageScriptPermissions.currentGrants(lease.package.files)
            : [],
        );
      return PackageScriptPermissions.status(
        lease.package.files,
        await PackageScriptPermissions.read(root),
      );
    } finally {
      lease.release();
    }
  }

  async readPackage(localId: string): Promise<EditableContentPackageDetail> {
    const snapshot = await this.#readPackageSnapshot(localId);
    if (snapshot.metadata.schemaVersion === 2) return snapshot.package;
    const lease = await this.acquireOperationLease(localId, { wait: true });
    try {
      await ensureStoredPackageTitle(
        this.#packageRoot(localId),
        localId,
        lease.package.title,
      );
      return structuredClone(lease.package);
    } finally {
      lease.release();
    }
  }

  async #readPackageSnapshot(localId: string): Promise<{
    metadata: StoredLocalMetadata | LegacyStoredLocalMetadata;
    package: EditableContentPackageDetail;
  }> {
    const packageRoot = this.#packageRoot(localId);
    const metadata = await readJsonFile(
      join(packageRoot, localMetadataFileName),
      () => new CurrentTreeContentPackageNotFoundError(),
      "The local content-package envelope is damaged",
    );
    if (!isStoredMetadata(metadata) || metadata.localId !== localId) {
      throw new CurrentTreeContentLibraryError(
        "The local content-package envelope is damaged",
      );
    }
    const storedTree = await readJsonFile(
      join(packageRoot, currentTreeFileName),
      () =>
        new CurrentTreeContentLibraryError(
          "The content package has no current tree",
        ),
      "The content package's current tree is damaged",
    );
    if (!isStoredCurrentTree(storedTree)) {
      throw new CurrentTreeContentLibraryError(
        "The content package's current tree is damaged",
      );
    }
    let files: ContentTreeFile[];
    try {
      files = normalizeCurrentContentTreeFiles(storedTree.files, this.#limits);
    } catch (error: unknown) {
      throw new CurrentTreeContentLibraryError(
        "The content package's current tree is damaged",
        {
          cause: error,
        },
      );
    }
    const inspection = inspectContentPackageCurrentTree(files);
    return {
      metadata,
      package: detail(
        localId,
        effectivePackageTitle(metadata, inspection),
        files,
        inspection,
      ),
    };
  }

  /**
   * Title a package in the local library. The title lives in the package's own
   * local shell, not in its content, so renaming never touches a document the
   * runtime reads during play.
   */
  renamePackage(
    localId: string,
    title: string,
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageSummary> {
    return this.#mutate(async () => {
      const normalizedTitle = normalizePackageTitle(title);
      const lease = await this.acquireOperationLease(localId, {
        wait: options.waitForLease !== false,
      });
      try {
        options.signal?.throwIfAborted();
        const packageRoot = this.#packageRoot(localId);
        const metadata = await readJsonFile(
          join(packageRoot, localMetadataFileName),
          () => new CurrentTreeContentPackageNotFoundError(),
          "The local content-package envelope is damaged",
        );
        if (!isStoredMetadata(metadata) || metadata.localId !== localId)
          throw new CurrentTreeContentLibraryError(
            "The local content-package envelope is damaged",
          );
        await writeStoredLocalMetadata(packageRoot, {
          schemaVersion: 2,
          localId,
          title: normalizedTitle,
        });
        return packageSummary(await this.readPackage(localId));
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Replace the whole tree only if it is still the revision the draft was
   * based on. The comparison runs under the package lease, so a publish that
   * landed after the draft opened cannot be overwritten.
   */
  replaceCurrentTree(
    localId: string,
    files: readonly ContentTreeFile[],
    options: CurrentTreeReplaceOptions,
  ): Promise<EditableContentPackageDetail> {
    return this.#mutate(async () => {
      const lease = await this.acquireOperationLease(localId, {
        wait: options.waitForLease !== false,
      });
      try {
        if (lease.package.treeRevision !== options.baseTreeRevision)
          throw new ContentTreeConflictError(lease.package);
        return await lease.replace(files, options);
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Change only the resolution scheme of a tabletop package. The edit reads the
   * tree under the same lease as ordinary saves, so it publishes atomically and
   * follows the same conflict rules.
   */
  setGameplayScheme(
    localId: string,
    scheme: ResolutionScheme,
    options: CurrentTreeMutationOptions = {},
  ): Promise<EditableContentPackageDetail> {
    return this.#mutate(async () => {
      const lease = await this.acquireOperationLease(localId, {
        wait: options.waitForLease !== false,
      });
      try {
        options.signal?.throwIfAborted();
        const current = lease.package;
        if (current.gameplay.mode !== "tabletop")
          throw new InvalidContentTreeError(
            "Only a tabletop content package has a resolution scheme / 只有跑团内容包有判定方案",
          );
        const replacement = gameplayFile({ mode: "tabletop", scheme });
        return await lease.replace(
          current.files.map((file) =>
            file.path === gameplayPath ? replacement : file,
          ),
          options,
        );
      } finally {
        lease.release();
      }
    });
  }

  async acquireOperationLease(
    localId: string,
    options: { wait?: boolean } = {},
  ): Promise<CurrentTreeContentPackageOperationLease> {
    const packageRoot = this.#packageRoot(localId);
    await this.#removeLegacyPackageLocks();
    await acquireInProcessPackageLease(packageRoot, options.wait === true);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseInProcessPackageLease(packageRoot);
    };
    try {
      const package_ = (await this.#readPackageSnapshot(localId)).package;
      return {
        package: structuredClone(package_),
        replace: async (files, options = {}) => {
          if (released) throw new CurrentTreeContentPackageBusyError();
          options.signal?.throwIfAborted();
          const normalized = normalizeCurrentContentTreeFiles(
            files,
            this.#limits,
          );
          assertGameplayModeUnchanged(package_.files, normalized);
          return this.#replaceNormalizedCurrentTree(
            localId,
            package_.title,
            normalized,
            options.signal,
          );
        },
        release,
      };
    } catch (error: unknown) {
      release();
      throw error;
    }
  }

  /**
   * Lock files written by versions that leased packages across processes. No
   * code reads them any more, so the first lease in a library removes them.
   */
  #removeLegacyPackageLocks(): Promise<void> {
    this.#legacyLocksRemoval ??= rm(this.#legacyLocksRoot, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    return this.#legacyLocksRemoval;
  }

  async #replaceNormalizedCurrentTree(
    localId: string,
    title: string,
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
      await ensureStoredPackageTitle(packageRoot, localId, title);
      await writeDurableNewFile(
        temporaryPath,
        serialize({
          schemaVersion: 1,
          files: normalized,
        } satisfies StoredCurrentTree),
      );
      signal?.throwIfAborted();
      await this.#beforeCurrentTreeReplace?.();
      signal?.throwIfAborted();
      await unlink(previousPath).catch((error: unknown) => {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
      });
      await linkExclusive(join(packageRoot, currentTreeFileName), previousPath);
      await rename(temporaryPath, join(packageRoot, currentTreeFileName));
      await unlink(previousPath).catch(() => undefined);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      let rollbackFailure: unknown;
      if (await pathExists(previousPath).catch(() => false)) {
        try {
          await rename(previousPath, join(packageRoot, currentTreeFileName));
        } catch (rollbackError: unknown) {
          rollbackFailure = rollbackError;
        }
      }
      if (rollbackFailure !== undefined) {
        throw new CurrentTreeContentLibraryError(
          "Unable to restore the content package's previous current tree",
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
        error instanceof Error
          ? error.message
          : "Unable to replace the content package's current tree atomically",
        { cause: error },
      );
    }
    return detail(
      localId,
      title,
      normalized,
      inspectContentPackageCurrentTree(normalized),
    );
  }

  async #publishNewPackage(
    normalized: ContentTreeFile[],
    title: string,
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
          schemaVersion: 2,
          localId,
          title,
        } satisfies StoredLocalMetadata),
      );
      await writeDurableNewFile(
        join(stagingPath, currentTreeFileName),
        serialize({
          schemaVersion: 1,
          files: normalized,
        } satisfies StoredCurrentTree),
      );
      signal?.throwIfAborted();
      await this.#beforePackagePublish?.();
      signal?.throwIfAborted();
      await rename(stagingPath, finalPath);
    } catch (error: unknown) {
      await rm(stagingPath, { force: true, recursive: true }).catch(
        () => undefined,
      );
      if (isAbortError(error)) throw error;
      throw new CurrentTreeContentLibraryError(
        "Unable to publish the content package atomically",
        {
          cause: error,
        },
      );
    }
    return detail(
      localId,
      title,
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
  title: string,
  files: readonly ContentTreeFile[],
  inspection: FileNativeContentInspection,
): EditableContentPackageDetail {
  return {
    ...summary(localId, title, readGameplay(files), inspection),
    treeRevision: treeRevisionOf(files),
    files: files.map((file) => ({ ...file })),
    documents: structuredClone(inspection.documents),
    issues: structuredClone(inspection.issues),
    opening: inspection.opening,
    control: structuredClone(inspection.control),
  };
}

/**
 * Digest of every file's path, encoding and contents, independent of file
 * order. Equal trees always share a revision; a tree that returns to earlier
 * content is equal to it, so a draft based on that content loses nothing.
 */
function treeRevisionOf(files: readonly ContentTreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    compareStrings(left.path, right.path),
  )) {
    hash.update(
      JSON.stringify([file.path, file.encoding ?? null, file.contents]),
    );
  }
  return hash.digest("hex");
}

function summary(
  localId: string,
  title: string,
  gameplay: Gameplay,
  inspection: FileNativeContentInspection,
): EditableContentPackageSummary {
  return {
    gameplay: { ...gameplay },
    localId,
    title,
    status: inspection.status,
    documentCount: inspection.documents.length,
    issueCount: inspection.issues.length,
  };
}

function packageSummary(
  package_: EditableContentPackageDetail,
): EditableContentPackageSummary {
  return {
    gameplay: { ...package_.gameplay },
    localId: package_.localId,
    title: package_.title,
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
    throw new InvalidContentTreeError(
      "The content package exceeds the file-count limit",
    );
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
      throw new InvalidContentTreeError(
        "Every content-package file must contain a path and text content",
      );
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
        `The current content tree does not allow manifest files: ${path}`,
      );
    }
    const portableKey = portableContentTreePathKey(path);
    if (portableKeys.has(portableKey)) {
      throw new InvalidContentTreeError(
        `The content tree contains a duplicate normalized path: ${path}`,
      );
    }
    portableKeys.add(portableKey);
    const bytes =
      file.encoding === "base64"
        ? decodeCanonicalBase64(file.contents, path).byteLength
        : Buffer.byteLength(file.contents, "utf8");
    if (bytes > limits.maxFileBytes) {
      throw new InvalidContentTreeError(
        `A content-package file exceeds the size limit: ${path}`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new InvalidContentTreeError(
        "The content package exceeds the total-size limit",
      );
    }
    normalized.push({
      path,
      contents: file.contents,
      ...(file.encoding === undefined ? {} : { encoding: file.encoding }),
    });
  }
  try {
    readGameplay(normalized);
  } catch (error: unknown) {
    throw new InvalidContentTreeError(
      error instanceof Error ? error.message : "Invalid gameplay identity",
    );
  }
  return normalized.sort((left, right) =>
    compareStrings(left.path, right.path),
  );
}

function assertGameplayModeUnchanged(
  before: readonly ContentTreeFile[],
  after: readonly ContentTreeFile[],
): void {
  try {
    assertSameGameplayMode(before, after);
  } catch (error: unknown) {
    throw new InvalidContentTreeError(
      error instanceof Error ? error.message : "Gameplay mode is fixed",
    );
  }
}

function decodeCanonicalBase64(contents: string, path: string): Buffer {
  if (
    contents.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      contents,
    )
  ) {
    throw new InvalidContentTreeError(
      `A binary content-package asset is not canonical Base64: ${path}`,
    );
  }
  const decoded = Buffer.from(contents, "base64");
  if (decoded.toString("base64") !== contents) {
    throw new InvalidContentTreeError(
      `A binary content-package asset is not canonical Base64: ${path}`,
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
    throw new InvalidContentTreeError(`Invalid content-tree path: ${value}`);
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
    throw new InvalidContentTreeError(`Invalid content-tree path: ${value}`);
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
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new TypeError("maxFileBytes must not exceed maxTotalBytes");
  }
  return limits;
}

async function ensureStoredPackageTitle(
  packageRoot: string,
  localId: string,
  title: string,
): Promise<void> {
  const metadata = await readJsonFile(
    join(packageRoot, localMetadataFileName),
    () => new CurrentTreeContentPackageNotFoundError(),
    "The local content-package envelope is damaged",
  );
  if (!isStoredMetadata(metadata) || metadata.localId !== localId)
    throw new CurrentTreeContentLibraryError(
      "The local content-package envelope is damaged",
    );
  if (metadata.schemaVersion === 2) {
    if (metadata.title !== title)
      throw new CurrentTreeContentLibraryError(
        "The content-package title changed while its current tree was locked",
      );
    return;
  }
  await writeStoredLocalMetadata(packageRoot, {
    schemaVersion: 2,
    localId,
    title,
  });
}

async function writeStoredLocalMetadata(
  packageRoot: string,
  metadata: StoredLocalMetadata,
): Promise<void> {
  const temporaryPath = join(packageRoot, `.local-${randomUUID()}.tmp`);
  try {
    await writeDurableNewFile(temporaryPath, serialize(metadata));
    await rename(temporaryPath, join(packageRoot, localMetadataFileName));
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeDurableNewFile(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
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

function isStoredMetadata(
  value: unknown,
): value is StoredLocalMetadata | LegacyStoredLocalMetadata {
  return isStoredLocalMetadata(value) || isLegacyStoredLocalMetadata(value);
}

function isStoredLocalMetadata(value: unknown): value is StoredLocalMetadata {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 3 &&
    value.schemaVersion === 2 &&
    typeof value.localId === "string" &&
    localIdPattern.test(value.localId) &&
    typeof value.title === "string" &&
    validPackageTitle(value.title)
  );
}

function isLegacyStoredLocalMetadata(
  value: unknown,
): value is LegacyStoredLocalMetadata {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === (value.name === undefined ? 2 : 3) &&
    value.schemaVersion === 1 &&
    typeof value.localId === "string" &&
    localIdPattern.test(value.localId) &&
    (value.name === undefined ||
      (typeof value.name === "string" && validPackageTitle(value.name)))
  );
}

function effectivePackageTitle(
  metadata: StoredLocalMetadata | LegacyStoredLocalMetadata,
  inspection: FileNativeContentInspection,
): string {
  if (metadata.schemaVersion === 2) return metadata.title;
  return metadata.name ?? legacyContentDerivedTitle(inspection);
}

function legacyContentDerivedTitle(
  inspection: FileNativeContentInspection,
): string {
  return (
    inspection.documents.find(({ id }) => id === "situation.current")?.title ??
    inspection.documents[0]?.title ??
    "Untitled content package"
  );
}

const packageTitlePattern = /^[^\r\n]{1,160}$/u;

function validPackageTitle(title: string): boolean {
  return packageTitlePattern.test(title);
}

function normalizePackageTitle(title: string): string {
  const normalized = title.trim();
  if (!validPackageTitle(normalized))
    throw new CurrentTreeContentLibraryError(
      "A content-package title must contain 1 to 160 characters and no line breaks",
    );
  return normalized;
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

const packageLeaseWaitMs = 10_000;

/**
 * Package leases held by this process, keyed by package root. A key is present
 * while its lease is held; its array queues waiters in arrival order, and a
 * release hands the lease straight to the first of them.
 */
const heldPackageLeases = new Map<string, PackageLeaseWaiter[]>();

interface PackageLeaseWaiter {
  grant(): void;
}

async function acquireInProcessPackageLease(
  packageRoot: string,
  wait: boolean,
): Promise<void> {
  const queue = heldPackageLeases.get(packageRoot);
  if (queue === undefined) {
    heldPackageLeases.set(packageRoot, []);
    return;
  }
  if (!wait) throw new CurrentTreeContentPackageBusyError();
  await new Promise<void>((resolve, reject) => {
    const waiter: PackageLeaseWaiter = {
      grant: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    const timer = setTimeout(() => {
      const index = queue.indexOf(waiter);
      if (index === -1) return;
      queue.splice(index, 1);
      reject(new CurrentTreeContentPackageBusyError());
    }, packageLeaseWaitMs);
    queue.push(waiter);
  });
}

function releaseInProcessPackageLease(packageRoot: string): void {
  const queue = heldPackageLeases.get(packageRoot);
  if (queue === undefined) return;
  const next = queue.shift();
  if (next === undefined) heldPackageLeases.delete(packageRoot);
  else next.grant();
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
