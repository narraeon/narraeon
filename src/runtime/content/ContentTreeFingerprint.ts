import { createHash } from "node:crypto";

import type { ContentTreeFile } from "./ContentTreeFile.ts";

/** Stable identity for one complete portable content tree revision. */
export function contentTreeFingerprint(
  files: readonly ContentTreeFile[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .map(({ path, contents, encoding }) => ({
            path,
            contents,
            ...(encoding === undefined ? {} : { encoding }),
          }))
          .sort((left, right) =>
            left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
          ),
      ),
    )
    .digest("hex");
}
