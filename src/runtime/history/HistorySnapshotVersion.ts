import { createHash } from "node:crypto";
import type { HistoryMessageInput } from "./HistoryQuery.ts";

/** Fold immutable messages in timeline order so appends only hash new text. */
export function appendHistoryVersion(
  previous: string,
  messages: readonly HistoryMessageInput[],
): string {
  let version = previous;
  for (const { id, role, isOpening, text, background } of messages)
    version = createHash("sha256")
      .update(version)
      .update(
        JSON.stringify([
          id,
          role,
          isOpening === true,
          text,
          background ?? null,
        ]),
      )
      .digest("hex");
  return version;
}
