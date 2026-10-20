import { constants } from "node:fs";
import { copyFile, link } from "node:fs/promises";

// Error codes that mean "hard links are unavailable here". Android app directories
// return EACCES for link(), so that code is included.
const linkFallbackCodes = new Set(["EPERM", "EACCES", "ENOTSUP", "EXDEV"]);

/**
 * Creates target as a new name for source, failing with EEXIST when target already
 * exists. Uses a hard link where the filesystem allows it. Otherwise falls back to an
 * exclusive byte copy, which also fails with EEXIST.
 *
 * Creation is exclusive in both paths. Content visibility is atomic only on the
 * hard-link path: on the copy path a concurrent reader could in principle see a
 * partially written target. This is acceptable under ADR-0044's single-process and
 * per-world serial assumptions, because callers hold a process-local lock and
 * readers only open targets after the creating call returns.
 */
export async function linkExclusive(
  source: string,
  target: string,
): Promise<void> {
  const injectedErrorCode = process.env.NARRAEON_INTERNAL_TEST_LINK_ERROR_CODE;
  try {
    if (injectedErrorCode !== undefined) {
      const error = new Error(
        `${injectedErrorCode}: injected hard link failure`,
      ) as NodeJS.ErrnoException;
      error.code = injectedErrorCode;
      throw error;
    }
    await link(source, target);
  } catch (error: unknown) {
    if (!isFallbackError(error)) throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

function isFallbackError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    linkFallbackCodes.has(error.code)
  );
}
