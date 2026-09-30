import { expect, test } from "vitest";
import { HistoryQuery } from "../../src/runtime/history/HistoryQuery.ts";

const messages = [
  {
    id: "message.genesis.narrator",
    role: "narrator" as const,
    isOpening: true,
    text: "开场白",
  },
  { id: "message.2.1.player", role: "player" as const, text: "那封信在哪里？" },
  {
    id: "message.9.1.narrator",
    role: "narrator" as const,
    text: "那封信被藏在码头。",
  },
  {
    id: "message.10.1.narrator",
    role: "narrator" as const,
    text: "  港口那封信仍在。\n\n",
  },
];

test("最新历史页按 Authority 顺序显示并可向前后无重复浏览", () => {
  const history = new HistoryQuery("world-a", messages);
  const page = history.list({ limit: 2 });
  expect(page).toMatchObject({
    ok: true,
    kind: "list",
    total: 4,
    messages: [
      {
        position: 3,
        role: "narrator",
        previous: "@history-message-message.2.1.player",
        next: "@history-message-message.10.1.narrator",
      },
      { position: 4, next: null },
    ],
    laterCursor: null,
  });
  if (!page.ok || page.kind !== "list") throw new Error("Expected list");
  const earlier = history.list({ cursor: page.earlierCursor });
  expect(earlier).toMatchObject({
    messages: [{ position: 1, isOpening: true }, { position: 2 }],
    earlierCursor: null,
  });
  if (!earlier.ok || earlier.kind !== "list") throw new Error("Expected list");
  expect(history.list({ cursor: earlier.laterCursor })).toMatchObject({
    messages: [{ position: 3 }, { position: 4 }],
  });
});

test("历史读取可从最近原文直达相邻窗口，保留空白及超长正文", () => {
  const long = " \n" + "远".repeat(50000) + "承诺\n\n ";
  const history = new HistoryQuery("world-a", [
    ...messages,
    { id: "message.15.2.player", role: "player", text: long },
  ]);
  expect(history.read({ latest: 2 })).toMatchObject({
    ok: true,
    kind: "read",
    messages: [
      { position: 4, text: "  港口那封信仍在。\n\n" },
      { position: 5, text: long },
    ],
    earlier: "@history-message-message.9.1.narrator",
    later: null,
  });
  expect(
    history.read({
      ref: "@history-message-message.9.1.narrator",
      before: 1,
      after: 1,
    }),
  ).toMatchObject({
    messages: [{ position: 2 }, { position: 3 }, { position: 4 }],
    earlier: "@history-message-message.genesis.narrator",
    later: "@history-message-message.15.2.player",
  });
  expect(history.read({ latest: 1, before: 0 })).toMatchObject({
    ok: false,
    code: "history_invalid_arguments",
  });
  expect(
    history.read({
      ref: "@history-message-message.9.1.narrator",
      before: 20,
      after: 1,
    }),
  ).toMatchObject({ ok: false, code: "history_invalid_arguments" });
});

test("多词搜索默认最新命中优先，all 限于同一消息，命中可直接完整读取", () => {
  const history = new HistoryQuery("world-a", messages);
  const found = history.search({ queries: ["那封信", "港口"], limit: 1 });
  expect(found).toMatchObject({
    ok: true,
    kind: "search",
    total: 4,
    matches: 3,
    range: { start: 1, end: 4 },
    order: "newest_first",
    messages: [
      {
        message: { position: 4 },
        hits: [
          { query: "那封信", count: 1 },
          { query: "港口", count: 1 },
        ],
      },
    ],
  });
  if (!found.ok || found.kind !== "search") throw new Error("Expected search");
  expect(history.search({ cursor: found.nextCursor })).toMatchObject({
    messages: [{ message: { position: 3 } }],
  });
  expect(
    history.read({ ref: found.messages[0]!.message.ref, before: 1 }),
  ).toMatchObject({ messages: [{ position: 3 }, { position: 4 }] });
  expect(
    history.search({ queries: ["那封信", "港口"], match: "all" }),
  ).toMatchObject({ matches: 1 });
  expect(
    history.search({ queries: ["在哪里", "码头"], match: "all" }),
  ).toMatchObject({ matches: 0 });
  expect(
    history.search({
      queries: ["那封信"],
      order: "oldest_first",
      after: "@history-message-message.2.1.player",
      before: "@history-message-message.10.1.narrator",
    }),
  ).toMatchObject({
    range: { start: 3, end: 3 },
    messages: [{ message: { position: 3 } }],
  });
});

test("规范化命中映射到原文，并优先展示长文后半段的其他查询词", () => {
  const text =
    "😀  ＡＢＣ e\u0301 ﬃ İ ΟΣ  " +
    "信".repeat(350) +
    "我承诺明天归还钥匙。" +
    "尾".repeat(200);
  const history = new HistoryQuery("world-a", [
    { id: "message.100.2.narrator", role: "narrator", text },
  ]);
  const found = history.search({
    queries: ["abc", "ＡＢＣ", "É", "ffi", "承诺"],
  });
  expect(found).toMatchObject({
    queries: ["abc", "É", "ffi", "承诺"],
    messages: [
      {
        hits: [
          { query: "abc", count: 1 },
          { query: "É", count: 1 },
          { query: "ffi", count: 1 },
          { query: "承诺", count: 1 },
        ],
        omittedMatches: false,
      },
    ],
  });
  if (!found.ok || found.kind !== "search") throw new Error("Expected search");
  const fragments = found.messages[0]!.fragments;
  expect(fragments).toHaveLength(2);
  expect(fragments[0]!.text).toContain("ＡＢＣ e\u0301 ﬃ İ ΟΣ");
  expect(fragments[1]!.text).toContain("我承诺明天归还钥匙。");
  expect(history.search({ queries: ["i\u0307", "ος"] })).toMatchObject({
    messages: [
      {
        hits: [
          { query: "i\u0307", count: 1 },
          { query: "ος", count: 1 },
        ],
      },
    ],
  });
});

test("快照 cursor 拒绝历史变更、世界/工具混用、参数混用和伪造", () => {
  const history = new HistoryQuery("world-a", messages);
  const page = history.list({ limit: 1 });
  if (!page.ok) throw new Error("Expected list");
  const cursor = page.earlierCursor;
  expect(new HistoryQuery("world-a", messages).list({ cursor })).toMatchObject({
    ok: true,
  });
  expect(
    new HistoryQuery("world-a", [
      ...messages,
      { id: "message.15.1.player", role: "player", text: "新行动" },
    ]).list({ cursor }),
  ).toMatchObject({ code: "history_changed" });
  expect(
    new HistoryQuery("world-a", messages.slice(0, 2)).list({ cursor }),
  ).toMatchObject({ code: "history_changed" });
  expect(new HistoryQuery("world-b", messages).list({ cursor })).toMatchObject({
    code: "history_invalid_cursor",
  });
  expect(history.search({ cursor })).toMatchObject({
    code: "history_invalid_cursor",
  });
  expect(history.list({ cursor, limit: 1 })).toMatchObject({
    code: "history_invalid_arguments",
  });
  expect(history.list({ cursor: `${cursor}broken` })).toMatchObject({
    code: "history_invalid_cursor",
  });
  expect(
    history.list({
      cursor: Buffer.from('{"offset":1,"scope":"old"}').toString("base64url"),
    }),
  ).toMatchObject({ code: "history_invalid_cursor" });
});

test("列表锚点是相邻区间，空窗口、边界及参数恢复明确", () => {
  const history = new HistoryQuery("world-a", messages);
  expect(
    history.list({
      before: "@history-message-message.10.1.narrator",
      limit: 1,
    }),
  ).toMatchObject({ messages: [{ position: 3 }] });
  expect(
    history.list({ after: "@history-message-message.2.1.player", limit: 1 }),
  ).toMatchObject({ messages: [{ position: 3 }] });
  expect(
    history.list({ before: "@history-message-message.genesis.narrator" }),
  ).toMatchObject({ messages: [], earlierCursor: null });
  expect(
    history.read({
      ref: "@history-message-message.genesis.narrator",
      before: 2,
      after: 1,
    }),
  ).toMatchObject({
    messages: [{ position: 1 }, { position: 2 }],
    earlier: null,
  });
  expect(
    history.read({ ref: "@history-message-message.999.1.player" }),
  ).toMatchObject({ code: "history_ref_not_in_current_timeline" });
  expect(new HistoryQuery("empty", []).read({ latest: 4 })).toMatchObject({
    messages: [],
    earlier: null,
    later: null,
  });
  expect(
    history.search({
      queries: ["信"],
      after: "@history-message-message.9.1.narrator",
      before: "@history-message-message.10.1.narrator",
    }),
  ).toMatchObject({ matches: 0, range: { start: null, end: null } });
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.2 },
    { before: messages[0]!.id, after: messages[1]!.id },
    { order: "newest_first" },
  ])
    expect(history.list(args)).toMatchObject({
      code: "history_invalid_arguments",
    });
  for (const args of [
    { queries: [] },
    { queries: [" "] },
    { queries: ["x".repeat(257)] },
    { queries: ["信"], limit: 51 },
    {
      queries: ["信"],
      after: "@history-message-message.10.1.narrator",
      before: "@history-message-message.2.1.player",
    },
  ])
    expect(history.search(args)).toMatchObject({
      code: "history_invalid_arguments",
    });
});

test("双向列表及两种搜索顺序多页无遗漏，同角色连续消息不按回合推算", () => {
  const history = new HistoryQuery("world-a", messages);
  let page = history.list({ limit: 1 });
  const backwards: number[] = [];
  while (page.ok) {
    backwards.push(...page.messages.map(({ position }) => position));
    if (page.earlierCursor === null) break;
    page = history.list({ cursor: page.earlierCursor });
  }
  expect(backwards).toEqual([4, 3, 2, 1]);
  page = history.list({
    before: "@history-message-message.2.1.player",
    limit: 1,
  });
  const forwards: number[] = [];
  while (page.ok) {
    forwards.push(...page.messages.map(({ position }) => position));
    if (page.laterCursor === null) break;
    page = history.list({ cursor: page.laterCursor });
  }
  expect(forwards).toEqual([1, 2, 3, 4]);
  for (const order of ["oldest_first", "newest_first"]) {
    let results = history.search({ queries: ["那封信"], limit: 1, order });
    const positions: number[] = [];
    while (results.ok) {
      positions.push(
        ...results.messages.map(({ message }) => message.position),
      );
      if (results.nextCursor === null) break;
      results = history.search({ cursor: results.nextCursor });
    }
    expect(positions).toEqual(order === "oldest_first" ? [2, 3, 4] : [4, 3, 2]);
  }
});

test("每词按非重叠字面计数，最多三个原文片段并明确未展示命中", () => {
  const text =
    "aaaa" +
    "界".repeat(200) +
    "aa" +
    "界".repeat(200) +
    "aa" +
    "界".repeat(200) +
    "aa";
  const history = new HistoryQuery("world-a", [
    { id: "message.1002.10.player", role: "player", text },
  ]);
  const found = history.search({ queries: ["aa"] });
  expect(found).toMatchObject({
    messages: [{ hits: [{ query: "aa", count: 5 }], omittedMatches: true }],
  });
  if (!found.ok) throw new Error("Expected search");
  expect(found.messages[0]!.fragments).toHaveLength(3);
  expect(found.messages[0]!.fragments[0]).toMatchObject({
    start: 1,
    end: 82,
    text: "aaaa" + "界".repeat(78),
  });
});

test("Runtime 进程重启后的 cursor 明确要求重新查询", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const history = new HistoryQuery("world-a", messages);
  const page = history.list({ limit: 1 });
  if (!page.ok) throw new Error("Expected list");
  const moduleUrl = new URL(
    "../../src/runtime/history/HistoryQuery.ts",
    import.meta.url,
  ).href;
  const script = `import { HistoryQuery } from ${JSON.stringify(moduleUrl)}; const history = new HistoryQuery("world-a", ${JSON.stringify(messages)}); console.log(JSON.stringify(history.list({cursor:process.argv[1]})));`;
  const result = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    page.earlierCursor!,
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    code: "history_invalid_cursor",
    recovery: expect.stringContaining(
      "Run the original query again",
    ) as unknown,
  });
});
