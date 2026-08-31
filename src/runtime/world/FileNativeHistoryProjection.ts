import { createHash } from "node:crypto";

import type { ContentTreeFile } from "../content/ContentTreeFile.ts";

export interface FileNativeHistoryProjectionMessage {
  messageId: string;
  role: "player" | "narrator";
  exactText: string;
}

export function fileNativeHistoryMessageIdFromProjectionPath(
  path: string,
): string | null {
  const match = /^(\d{8})-(\d+)-(player|narrator)-[a-f0-9]{12}\.md$/u.exec(
    path,
  );
  if (match === null) return null;
  const sequence = Number.parseInt(match[1]!, 10);
  const index = Number.parseInt(match[2]!, 10);
  const role = match[3]!;
  return sequence === 0
    ? index === 1 && role === "narrator"
      ? "message.genesis.narrator"
      : `message.genesis.${String(index)}.${role}`
    : `message.${String(sequence)}.${String(index)}.${role}`;
}

export function projectFileNativeHistorySurface(
  messages: readonly FileNativeHistoryProjectionMessage[],
  invalidIdentity: (messageId: string) => never,
): ContentTreeFile[] {
  return messages.map((message) => {
    const genesis =
      /(?:^|\.)message\.genesis(?:\.([1-9][0-9]*))?\.(player|narrator)$/u.exec(
        message.messageId,
      );
    const committed =
      /(?:^|\.)message\.([1-9][0-9]*)\.([1-9][0-9]*)\.(player|narrator)$/u.exec(
        message.messageId,
      );
    const sequence =
      genesis !== null ? 0 : Number.parseInt(committed?.[1] ?? "", 10);
    const index =
      genesis !== null
        ? Number.parseInt(genesis[1] ?? "1", 10)
        : Number.parseInt(committed?.[2] ?? "", 10);
    const role = genesis?.[2] ?? committed?.[3];
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(index) ||
      index < 1 ||
      role !== message.role
    )
      return invalidIdentity(message.messageId);
    const suffix = createHash("sha256")
      .update(message.messageId)
      .digest("hex")
      .slice(0, 12);
    return {
      path: `${String(sequence).padStart(8, "0")}-${String(index).padStart(2, "0")}-${message.role}-${suffix}.md`,
      contents: message.exactText,
    };
  });
}
