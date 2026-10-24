import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyChanges,
  appendTurn,
  beginTurn,
  commitTurnHead,
  forgetLedger,
  initializeLedger,
  listTurns,
  readFileAt,
  readHead,
  readTreeAt,
  recoverIncomplete,
  rewindTo,
  WorldTurnLedgerError,
} from "../../src/runtime/world/WorldTurnLedger.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "world-turn-ledger-"));
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(join(root, "state/a.yaml"), "v0-a\n");
  await writeFile(join(root, "state/b.md"), "v0-b\n");
  await initializeLedger(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function snapshot(): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const path of [
    "state/a.yaml",
    "state/b.md",
    "state/c.md",
    "history/0001-01-player-x.md",
  ]) {
    result[path] = await readFile(join(root, path), "utf8").catch(() => null);
  }
  return result;
}

describe("world turn ledger", () => {
  test("appends turns and reads any reachable endpoint", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [
        { path: "state/a.yaml", content: "v1-a\n" },
        { path: "history/0001-01-player-x.md", content: "player\n" },
      ],
    });
    await appendTurn(root, {
      mode: "play",
      changes: [
        { path: "state/a.yaml", content: "v2-a\n" },
        { path: "state/c.md", content: "new\n" },
      ],
    });

    expect(await readHead(root)).toBe(2);
    expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([
      1, 2,
    ]);
    expect(await readFileAt(root, 0, "state/a.yaml")).toBe("v0-a\n");
    expect(await readFileAt(root, 0, "state/c.md")).toBeNull();
    expect(await readFileAt(root, 1, "state/a.yaml")).toBe("v1-a\n");
    expect(await readFileAt(root, 1, "history/0001-01-player-x.md")).toBe(
      "player\n",
    );
    expect(await readFileAt(root, 1, "state/c.md")).toBeNull();
    expect(await readFileAt(root, 2, "state/a.yaml")).toBe("v2-a\n");
    expect(await readFileAt(root, 2, "state/c.md")).toBe("new\n");

    const tree = await readTreeAt(root, 1, ["state", "history"]);
    expect(Object.fromEntries(tree)).toEqual({
      "state/a.yaml": "v1-a\n",
      "state/b.md": "v0-b\n",
      "history/0001-01-player-x.md": "player\n",
    });
  });

  test("a crash after each step of a turn restores the state before it", async () => {
    const before = await snapshot();
    const changes = [
      { path: "state/a.yaml", content: "next-a\n" },
      { path: "state/c.md", content: "created\n" },
      { path: "state/b.md", content: null },
    ];

    // 写入轮记录后崩溃
    await beginTurn(root, { mode: "play", changes });
    expect(await recoverIncomplete(root)).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await readHead(root)).toBe(0);
    expect(await listTurns(root)).toEqual([]);

    // 只替换了一部分文件后崩溃
    await beginTurn(root, { mode: "play", changes });
    await applyChanges(root, changes.slice(0, 2));
    expect(await recoverIncomplete(root)).toBe(true);
    expect(await snapshot()).toEqual(before);

    // 全部文件替换完成、但端点尚未发布时崩溃
    const record = await beginTurn(root, { mode: "play", changes });
    await applyChanges(root, changes);
    expect(await recoverIncomplete(root)).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(await readHead(root)).toBe(0);
    expect(record.sequence).toBe(1);

    // 端点已发布：重新加载后状态即推进后的状态
    const next = await beginTurn(root, { mode: "play", changes });
    await applyChanges(root, changes);
    await commitTurnHead(root, next);
    expect(await recoverIncomplete(root)).toBe(false);
    expect(await readHead(root)).toBe(1);
    expect(await readFile(join(root, "state/a.yaml"), "utf8")).toBe("next-a\n");
  });

  test("rewindTo restores the state of the target turn and drops later turns", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });
    const atOne = await snapshot();
    await appendTurn(root, {
      mode: "play",
      changes: [
        { path: "state/a.yaml", content: "v2-a\n" },
        { path: "state/c.md", content: "later\n" },
        { path: "history/0001-01-player-x.md", content: "player\n" },
      ],
    });
    await appendTurn(root, {
      mode: "correction",
      changes: [{ path: "state/b.md", content: "fixed\n" }],
    });

    const rewound = await rewindTo(root, 1);
    expect(rewound).not.toBeNull();
    expect(rewound?.mode).toBe("rewind");
    expect(rewound?.restoresSequence).toBe(1);
    expect(await snapshot()).toEqual(atOne);

    // 新轮号大于旧端点（4），且 2、3 不再可达
    expect(await readHead(root)).toBe(4);
    expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([
      1, 4,
    ]);
    await expect(readFileAt(root, 2, "state/a.yaml")).rejects.toMatchObject({
      code: "discarded",
    });

    // 回退后的历史仍可读，并能继续追加
    expect(await readFileAt(root, 1, "state/a.yaml")).toBe("v1-a\n");
    expect(await readFileAt(root, 0, "state/a.yaml")).toBe("v0-a\n");
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v5-a\n" }],
    });
    expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([
      1, 4, 5,
    ]);
    expect(await readFileAt(root, 1, "state/a.yaml")).toBe("v1-a\n");
    expect(await readFileAt(root, 4, "state/a.yaml")).toBe("v1-a\n");
  });

  test("rewindTo also removes runtime files written by discarded turns", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [
        { path: "runtime/history-backgrounds/0001.json", content: "{}\n" },
      ],
    });
    await appendTurn(root, {
      mode: "play",
      changes: [
        { path: "runtime/history-backgrounds/0002.json", content: "{}\n" },
      ],
    });
    await rewindTo(root, 1);
    await expect(
      readFile(join(root, "runtime/history-backgrounds/0002.json"), "utf8"),
    ).rejects.toThrow();
    expect(
      await readFile(
        join(root, "runtime/history-backgrounds/0001.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    await expect(
      readFile(join(root, "runtime/turns/00000002.json")),
    ).rejects.toThrow();
  });

  test("rewinding to the current endpoint is a no-op", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });
    expect(await rewindTo(root, 1)).toBeNull();
    expect(await readHead(root)).toBe(1);
  });

  test("discarded turns stay invisible before their records are cleaned up", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v2-a\n" }],
    });
    // 模拟回退已发布端点、但丢弃记录尚未清理时崩溃
    await appendTurn(root, {
      mode: "rewind",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
      restoresSequence: 1,
    });

    expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([
      1, 3,
    ]);
    expect(await readFileAt(root, 1, "state/a.yaml")).toBe("v1-a\n");
    expect(await readFileAt(root, 3, "state/a.yaml")).toBe("v1-a\n");
    await expect(readFileAt(root, 2, "state/a.yaml")).rejects.toBeInstanceOf(
      WorldTurnLedgerError,
    );

    await recoverIncomplete(root);
    await expect(
      readFile(join(root, "runtime/turns/00000002.json")),
    ).rejects.toThrow();
    expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([
      1, 3,
    ]);
  });
});

describe("world turn ledger view cache", () => {
  test("reuses the view for the same endpoint and refreshes after appendTurn", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });
    expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([1]);

    // 同一端点的第二次读取不再读取轮目录：把目录移开，视图仍然可读。
    const turns = join(root, "runtime", "turns");
    const moved = join(root, "runtime", "turns-away");
    await rename(turns, moved);
    try {
      expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([1]);
      expect(await readFileAt(root, 1, "state/a.yaml")).toBe("v1-a\n");

      await rename(moved, turns);
      await appendTurn(root, {
        mode: "play",
        changes: [{ path: "state/a.yaml", content: "v2-a\n" }],
      });
      expect((await listTurns(root)).map((turn) => turn.sequence)).toEqual([
        1, 2,
      ]);
      expect(await readFileAt(root, 2, "state/a.yaml")).toBe("v2-a\n");
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  });

  test("forgetLedger makes the next read come from disk", async () => {
    await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });
    expect((await listTurns(root)).length).toBe(1);

    const turns = join(root, "runtime", "turns");
    const moved = join(root, "runtime", "turns-away");
    await rename(turns, moved);
    try {
      forgetLedger(root);
      await expect(listTurns(root)).rejects.toMatchObject({
        code: "missing_record",
      });
    } finally {
      await rename(moved, turns);
    }
    // 上面的失败读取已经按残缺目录填充了视图，恢复目录后需要再次失效。
    forgetLedger(root);
    expect((await listTurns(root)).length).toBe(1);
  });

  test("a new turn first recovers an unfinished turn left at head + 1", async () => {
    // 同一进程里上一轮只替换了文件、没有发布端点：新一轮不能把半写入的文件当作前像。
    await beginTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "half-a\n" }],
    });
    await applyChanges(root, [{ path: "state/a.yaml", content: "half-a\n" }]);

    const record = await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });

    expect(record.sequence).toBe(1);
    expect(record.files).toEqual([{ path: "state/a.yaml", before: "v0-a\n" }]);
    expect(await readFileAt(root, 0, "state/a.yaml")).toBe("v0-a\n");
    expect(await readFile(join(root, "state/a.yaml"), "utf8")).toBe("v1-a\n");
  });

  test("a failed in-process advance rolls back its turn before the error propagates", async () => {
    const locked = join(root, "state", "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    try {
      const before = await snapshot();
      // a.yaml 先被替换，写入 state/locked/ 时失败（EACCES）。
      await expect(
        appendTurn(root, {
          mode: "play",
          changes: [
            { path: "state/a.yaml", content: "next-a\n" },
            { path: "state/locked/new.md", content: "blocked\n" },
          ],
        }),
      ).rejects.toMatchObject({ code: "EACCES" });

      expect(await snapshot()).toEqual(before);
      expect(await readHead(root)).toBe(0);
      expect(await listTurns(root)).toEqual([]);
      expect(await readdir(join(root, "runtime", "turns"))).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
    }

    // 回滚之后下一次推进正常，序号从 1 开始。
    const record = await appendTurn(root, {
      mode: "play",
      changes: [{ path: "state/a.yaml", content: "v1-a\n" }],
    });
    expect(record.sequence).toBe(1);
    expect(await readHead(root)).toBe(1);
  });
});
