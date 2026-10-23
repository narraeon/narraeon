import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

import { WorldLedgerAuthority } from "../../src/runtime/world/WorldLedgerAuthority.ts";
import {
  appendTurn,
  forgetLedger,
  initializeLedger,
  rewindTo,
} from "../../src/runtime/world/WorldTurnLedger.ts";

// 注入点：在账本读取目录（读取视图的第二步）之前，由另一次回退发布新的端点。
// 这正是 readHead 的物理端点读取与视图解析之间的窗口（#94）。
const race = vi.hoisted(() => ({
  armed: false,
  inject: (): Promise<void> => Promise.resolve(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (race.armed && String(args[0]).endsWith(join("runtime", "turns"))) {
        race.armed = false;
        await race.inject();
      }
      return actual.readdir(...args);
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  race.armed = false;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("readHead 在端点读取与视图解析之间被回退时，返回一致的当前端点", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ledger-read-race-"));
  roots.push(root);
  await initializeLedger(root);
  for (const sequence of [1, 2]) {
    await appendTurn(root, {
      mode: "play",
      changes: [],
      payload: commitPayload(sequence),
    });
  }
  forgetLedger(root);

  race.inject = () => rewindTo(root, 1).then(() => undefined);
  race.armed = true;
  const head = await new WorldLedgerAuthority(root).readHead();

  expect(race.armed).toBe(false);
  // 回退发布了 commit:1 的新端点；读取只能得到它，或回退之前的正确解析，不能抛错。
  expect(head).toMatchObject({
    head: "commit:1",
    sequence: 1,
    operationId: "op-1",
  });
});

function commitPayload(sequence: number) {
  return {
    sequence,
    head: `commit:${sequence}`,
    operationId: `op-${sequence}`,
    parentHead: sequence === 1 ? "genesis" : `commit:${sequence - 1}`,
    mode: "play",
    historyAppend: [],
    stateChanges: [],
    nextAdditionalMaterials: [],
  };
}
