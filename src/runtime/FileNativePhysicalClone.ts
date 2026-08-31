import { constants } from "node:fs";
import { copyFile, link, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const hardlinkFallbackCodes = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "EMLINK",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
]);
const reflinkFallbackCodes = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "ENOSYS",
]);

export interface FileNativePhysicalCloneInput {
  source: string;
  target: string;
  immutable: boolean;
  onTargetExists?: (source: string, target: string) => Promise<void>;
}

/**
 * Retains one file without aliasing mutable bytes. Immutable files prefer a
 * hard link; every other case walks reflink -> exclusive byte copy.
 */
export async function cloneFilePhysically(
  input: FileNativePhysicalCloneInput,
): Promise<void> {
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  const strategy = process.env.NARRAEON_INTERNAL_TEST_CLONE_STRATEGY;
  if (input.immutable && strategy !== "reflink" && strategy !== "copy") {
    try {
      await link(input.source, input.target);
      return;
    } catch (error: unknown) {
      if (await acceptExistingTarget(error, input)) return;
      if (!isFallbackError(error, hardlinkFallbackCodes)) throw error;
    }
  }
  if (strategy !== "copy") {
    try {
      await copyFileAsReflink(input.source, input.target);
      return;
    } catch (error: unknown) {
      if (await acceptExistingTarget(error, input)) return;
      if (!isFallbackError(error, reflinkFallbackCodes)) throw error;
    }
  }
  try {
    await copyFile(input.source, input.target, constants.COPYFILE_EXCL);
  } catch (error: unknown) {
    if (await acceptExistingTarget(error, input)) return;
    throw error;
  }
}

async function copyFileAsReflink(
  source: string,
  target: string,
): Promise<void> {
  const injectedErrorCode =
    process.env.NARRAEON_INTERNAL_TEST_REFLINK_ERROR_CODE;
  if (injectedErrorCode !== undefined) {
    const error = new Error(
      `${injectedErrorCode}: injected copy-on-write clone failure`,
    ) as NodeJS.ErrnoException;
    error.code = injectedErrorCode;
    error.path = source;
    error.syscall = "copyfile";
    throw error;
  }
  await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
}

async function acceptExistingTarget(
  error: unknown,
  input: FileNativePhysicalCloneInput,
): Promise<boolean> {
  if (
    !isNodeError(error) ||
    error.code !== "EEXIST" ||
    input.onTargetExists === undefined
  )
    return false;
  await input.onTargetExists(input.source, input.target);
  return true;
}

function isFallbackError(
  error: unknown,
  acceptedCodes: ReadonlySet<string>,
): boolean {
  return isNodeError(error) && acceptedCodes.has(error.code ?? "");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
