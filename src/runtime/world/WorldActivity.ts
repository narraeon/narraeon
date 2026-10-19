import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FileNativeAuthorityV3 } from "./FileNativeAuthorityV3.ts";
import { fileNativeHistoryMessageIdFromProjectionPath } from "./FileNativeHistoryProjection.ts";

export interface WorldActivity {
  schemaVersion: 1;
  head: string;
  lastActivityAt: number | null;
  excerpt: string | null;
  playerTurns: number;
}

export type WorldActivitySummary = Pick<
  WorldActivity,
  "lastActivityAt" | "excerpt" | "playerTurns"
>;

/** Read only the small head/cache on a hit; repair misses from the local projection. */
export async function readWorldActivity(
  root: string,
  serializeRebuild: (
    rebuild: () => Promise<WorldActivity>,
  ) => Promise<WorldActivity> = (rebuild) => rebuild(),
): Promise<WorldActivity> {
  const head = await currentHead(root);
  const cached = await readCache(root);
  if (cached?.head === head) return cached;
  return serializeRebuild(async () => {
    const latestHead = await currentHead(root);
    const latestCache = await readCache(root);
    if (latestCache?.head === latestHead) return latestCache;
    const empty: WorldActivity = {
      schemaVersion: 1,
      head: latestHead,
      lastActivityAt: null,
      excerpt: null,
      playerTurns: 0,
    };
    // An accepted endpoint may still be awaiting recovery. Never label its old
    // materialized history as a valid cache for the new endpoint.
    const materialized = await readJson(
      join(root, "runtime/materialized-head.json"),
    );
    if (!isRecord(materialized) || materialized.head !== latestHead)
      return empty;
    const entries = await readdir(join(root, "history"), {
      withFileTypes: true,
    });
    const messages = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        path: entry.name,
        id: fileNativeHistoryMessageIdFromProjectionPath(entry.name),
      }))
      .filter((message) => message.id !== null)
      .sort((left, right) => {
        const a = left.path.split("-");
        const b = right.path.split("-");
        return Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]);
      });
    const narrator = messages.findLast(({ id }) => id!.endsWith(".narrator"));
    const activity: WorldActivity = {
      ...empty,
      excerpt:
        narrator === undefined
          ? null
          : excerpt(
              await readFile(join(root, "history", narrator.path), "utf8"),
            ),
      playerTurns: messages.filter(({ id }) => id!.endsWith(".player")).length,
    };
    await publishCache(root, activity);
    return activity;
  });
}

/** Best effort: activity is never part of accepting or recovering Authority. */
export async function updateWorldActivity(
  root: string,
  head: string,
  history: readonly { role: "player" | "narrator"; exactText: string }[],
  lastActivityAt: number | null,
): Promise<void> {
  const narrator = history.findLast(({ role }) => role === "narrator");
  // Recovery cannot reconstruct a clock time, but can retain a matching cache.
  const previous = lastActivityAt === null ? await readCache(root) : null;
  await publishCache(root, {
    schemaVersion: 1,
    head,
    lastActivityAt:
      lastActivityAt ??
      (previous?.head === head ? previous.lastActivityAt : null),
    excerpt: narrator === undefined ? null : excerpt(narrator.exactText),
    playerTurns: history.filter(({ role }) => role === "player").length,
  });
}

function excerpt(text: string): string | null {
  const singleLine = text.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
  return singleLine === ""
    ? null
    : Array.from(singleLine).slice(0, 80).join("");
}

async function currentHead(root: string): Promise<string> {
  try {
    return (await new FileNativeAuthorityV3(root).readHead()).head;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    // Listing a released layout must not trigger an Authority migration/replay.
    const checkpoint = await readJson(
      join(root, "runtime/materialized-head.json"),
    );
    return isRecord(checkpoint) && typeof checkpoint.head === "string"
      ? checkpoint.head
      : "genesis";
  }
}

async function readCache(root: string): Promise<WorldActivity | null> {
  const value = await readJson(join(root, "runtime/activity.json")).catch(
    () => null,
  );
  return isRecord(value) &&
    Object.keys(value).length === 5 &&
    value.schemaVersion === 1 &&
    typeof value.head === "string" &&
    /^(?:genesis|commit:[1-9][0-9]*)$/u.test(value.head) &&
    (value.lastActivityAt === null ||
      (typeof value.lastActivityAt === "number" &&
        Number.isSafeInteger(value.lastActivityAt) &&
        value.lastActivityAt >= 0 &&
        Number.isFinite(new Date(value.lastActivityAt).valueOf()))) &&
    (value.excerpt === null ||
      (typeof value.excerpt === "string" &&
        Array.from(value.excerpt).length <= 80 &&
        !/[\r\n\u2028\u2029]/u.test(value.excerpt))) &&
    typeof value.playerTurns === "number" &&
    Number.isSafeInteger(value.playerTurns) &&
    value.playerTurns >= 0
    ? (value as unknown as WorldActivity)
    : null;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function publishCache(
  root: string,
  activity: WorldActivity,
): Promise<void> {
  const path = join(root, "runtime/activity.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(activity)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error: unknown) {
    console.warn("Could not write world activity cache", root, error);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
