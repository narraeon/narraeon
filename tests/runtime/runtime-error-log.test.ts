import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  FileNativeRuntimeErrorLog,
  type RuntimeErrorRecord,
} from "../../src/runtime/RuntimeErrorLog.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function readRecords(root: string) {
  const files = await readdir(root);
  const lines = await Promise.all(
    files.map((file) => readFile(join(root, file), "utf8")),
  );
  return lines
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RuntimeErrorRecord);
}

test("请求失败记录完整 cause 链与请求标识，但不记录玩家原文", async () => {
  const root = join(
    await mkdtemp(join(tmpdir(), "narraeon-runtime-error-log-")),
    "runtime-errors",
  );
  roots.push(join(root, ".."));
  const log = new FileNativeRuntimeErrorLog(root);
  const cause = Object.assign(
    new Error("The parent endpoint of the play operation has changed"),
    { name: "FileNativeWorldCreationError", code: "operation_conflict" },
  );

  await log.recordRequestFailure(
    {
      type: "play.chain.revise-player",
      worldId: "world-one",
      chainId: "chain-one",
      eventId: 3,
      replacementText: "Private player text.",
      continuation: "continue_context",
    },
    new Error("Regeneration failed", { cause }),
  );
  await log.recordPlayInterruption(
    {
      type: "play.chain.append",
      worldId: "world-one",
      chainId: "chain-one",
      exchangeId: "exchange-one",
      playerText: "Private player text.",
    },
    { message: "Provider timed out", kind: "retryable" },
  );

  const records = await readRecords(root);
  expect(JSON.stringify(records)).not.toContain("Private player text.");
  expect(records).toMatchObject([
    {
      kind: "request_failed",
      requestType: "play.chain.revise-player",
      request: {
        worldId: "world-one",
        chainId: "chain-one",
        eventId: 3,
        continuation: "continue_context",
      },
      error: { name: "Error", message: "Regeneration failed" },
      causes: [
        {
          name: "FileNativeWorldCreationError",
          code: "operation_conflict",
          message: "The parent endpoint of the play operation has changed",
        },
      ],
    },
    {
      kind: "play_interrupted",
      requestType: "play.chain.append",
      request: {
        worldId: "world-one",
        chainId: "chain-one",
        exchangeId: "exchange-one",
      },
      error: {
        name: "PlayCallInterrupted",
        message: "Provider timed out",
        code: "retryable",
      },
    },
  ]);
  expect(records[0]?.causes?.[0]?.stack).toContain(
    "FileNativeWorldCreationError",
  );
});

test("日志目录不可写时不影响调用方", async () => {
  const log = new FileNativeRuntimeErrorLog("/dev/null/runtime-errors");
  await expect(
    log.recordRequestFailure({ type: "workspace.read" }, new Error("boom")),
  ).resolves.toBeUndefined();
});
