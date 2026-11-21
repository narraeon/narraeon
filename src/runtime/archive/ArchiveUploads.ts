import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { streamFile, WorldArchiveError } from "./WorldArchiveZip.ts";

export interface ArchiveUploadPolicy {
  totalBytes: number;
  maxUploads: number;
  ttlMs: number;
}

const defaultUploadPolicy: ArchiveUploadPolicy = {
  totalBytes: 2 * 1024 ** 3,
  maxUploads: 32,
  ttlMs: 60 * 60 * 1000,
};
const cleanupRetryMs = 60_000;

interface Upload {
  path: string;
  bytes: number;
  expiresAt?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export class ArchiveUploads {
  readonly #uploads = new Map<string, Upload>();
  readonly #root: string;
  readonly #maxFileBytes: number;
  readonly #policy: ArchiveUploadPolicy;
  #bytes = 0;

  constructor(
    root: string,
    maxFileBytes: number,
    policy: ArchiveUploadPolicy = defaultUploadPolicy,
  ) {
    this.#root = root;
    this.#maxFileBytes = maxFileBytes;
    this.#policy = policy;
  }

  async initialize(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
    for (const upload of this.#uploads.values())
      clearTimeout(upload.cleanupTimer);
    this.#uploads.clear();
    this.#bytes = 0;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  async store(source: Readable): Promise<{ uploadId: string }> {
    if (this.#uploads.size >= this.#policy.maxUploads)
      throw new WorldArchiveError(
        "limit_exceeded",
        "Too many pending archive uploads; import an uploaded ZIP or wait for unused uploads to expire",
      );

    const uploadId = randomUUID();
    const upload: Upload = {
      path: join(this.#root, `${uploadId}.zip`),
      bytes: 0,
    };
    this.#uploads.set(uploadId, upload);
    try {
      await streamFile(source, upload.path, this.#maxFileBytes, (bytes) => {
        if (this.#bytes + bytes > this.#policy.totalBytes)
          return new WorldArchiveError(
            "limit_exceeded",
            "Pending archive uploads are full; import an uploaded ZIP or wait for unused uploads to expire",
          );
        this.#bytes += bytes;
        upload.bytes += bytes;
        return undefined;
      });
      upload.expiresAt = Date.now() + this.#policy.ttlMs;
      this.#scheduleRemoval(uploadId, upload, this.#policy.ttlMs);
      return { uploadId };
    } catch (error) {
      await this.#remove(uploadId, upload).catch(() => undefined);
      throw error;
    }
  }

  claim(
    uploadId: string,
  ): { path: string; remove: () => Promise<void> } | undefined {
    const upload = this.#uploads.get(uploadId);
    if (upload?.expiresAt === undefined || upload.expiresAt <= Date.now())
      return undefined;
    // Exclusively transfer the ZIP to an import before its first disk access.
    delete upload.expiresAt;
    clearTimeout(upload.cleanupTimer);
    return { path: upload.path, remove: () => this.#remove(uploadId, upload) };
  }

  #scheduleRemoval(uploadId: string, upload: Upload, delay: number): void {
    upload.cleanupTimer = setTimeout(() => {
      void this.#remove(uploadId, upload).catch(() => undefined);
    }, delay);
    upload.cleanupTimer.unref();
  }

  async #remove(uploadId: string, upload: Upload): Promise<void> {
    delete upload.expiresAt;
    clearTimeout(upload.cleanupTimer);
    try {
      await rm(upload.path, { force: true });
    } catch (error) {
      // Keep charging the bytes until the file is gone, even if unlink fails.
      if (this.#uploads.has(uploadId))
        this.#scheduleRemoval(uploadId, upload, cleanupRetryMs);
      throw error;
    }
    if (this.#uploads.delete(uploadId)) this.#bytes -= upload.bytes;
  }
}
