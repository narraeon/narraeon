import { expect, test } from "vitest";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";

const history = [
  { path: "message.genesis.narrator", contents: "开场白" },
  { path: "message.2.1.player", contents: "我踹开门。" },
  {
    path: "message.10.1.narrator",
    contents: "\n 门没有打开。那封信仍在里面。 \n",
  },
  { path: "message.10.2.narrator", contents: "他低声说：那封信藏在码头。" },
];
const documents = new FileNativePlayDocuments({});
const call = (name: string, args: unknown) =>
  documents.execute({ id: name, name, arguments: args }, history);

test("生产历史搜索命中可直接读取完整前后文及相邻导航", () => {
  const found = call("history_search", { queries: ["那封信"], limit: 1 });
  expect(found.ok).toBe(true);
  expect(found.markdown).toContain("Order: newest_first");
  expect(found.markdown).toContain("position 4");
  const ref = /@history-message-[^\s]+/u.exec(found.markdown)?.[0];
  const read = call("history_read", { ref, before: 2 });
  expect(read.ok).toBe(true);
  expect(read.markdown).toContain(history[2]!.contents);
  expect(read.markdown).toContain(
    "earlier: @history-message-message.genesis.narrator",
  );
  expect(read.markdown.indexOf("我踹开门")).toBeLessThan(
    read.markdown.indexOf("门没有打开"),
  );
});

test("旧历史工具保留排序与单词查询，旧 cursor 提示重新查询", () => {
  const list = call("history_list", { order: "newest_first", limit: 1 });
  expect(list.ok).toBe(true);
  expect(list.markdown).toContain("- @history-message-message.10.2.narrator,");
  const search = call("context_search", {
    source: "history",
    query: "那封信",
    limit: 1,
  });
  expect(search.ok).toBe(true);
  expect(search.markdown).toContain("Order: oldest_first");
  expect(search.markdown).toContain("position 3");
  expect(search.markdown).not.toContain("position 4");
  const cursor = /Next-page cursor: (\S+)/u.exec(search.markdown)![1];
  expect(
    call("context_search", {
      source: "history",
      query: "那封信",
      limit: 1,
      cursor,
    }).markdown,
  ).toContain("position 4");
  expect(
    call("context_read", {
      ref: "@history-message-message.10.1.narrator",
      maxBytes: 1,
    }).markdown,
  ).toContain(history[2]!.contents);
  expect(
    call("history_list", { order: "newest_first", cursor: "old-offset-only" }),
  ).toMatchObject({ ok: false, failureKind: "protocol" });
  expect(
    call("history_list", { order: "newest_first", cursor: "old-offset-only" })
      .markdown,
  ).toContain("history_invalid_cursor");
});

test("生产新会话拒绝旧历史参数，世界作用域与 locale 进入实际执行", () => {
  const execute = (scope: string, name: string, args: unknown) =>
    documents.execute({ id: name, name, arguments: args }, history, {
      historyScope: scope,
      locale: "zh-CN",
      legacyHistoryTools: false,
    });
  const page = execute("world-a", "history_list", { limit: 1 });
  expect(page.markdown).toContain("位置 4");
  const cursor = /earlierCursor: (\S+)/u.exec(page.markdown)![1];
  expect(execute("world-b", "history_list", { cursor }).markdown).toContain(
    "history_invalid_cursor",
  );
  expect(execute("world-a", "history_search", { cursor }).markdown).toContain(
    "history_invalid_cursor",
  );
  expect(execute("world-a", "history_list", { order: "newest_first" }).ok).toBe(
    false,
  );
  expect(
    execute("world-a", "context_search", { source: "history", query: "信" }).ok,
  ).toBe(false);
  expect(
    execute("world-a", "context_read", {
      ref: "@history-message-message.10.1.narrator",
    }).ok,
  ).toBe(false);
});

test.each(["en", "zh-CN"] as const)(
  "旧会话历史回执只引导已声明的读取和搜索参数：%s",
  (locale) => {
    const execute = (name: string, args: unknown) =>
      documents.execute({ id: name, name, arguments: args }, history, {
        locale,
        legacyHistoryTools: true,
      });
    const read = execute("context_read", {
      ref: "@history-message-message.10.1.narrator",
    });
    expect(read.ok).toBe(true);
    expect(read.markdown).not.toContain("history_read");
    const neighbors = Array.from(
      read.markdown.matchAll(/context_read \{ref:"([^"]+)"\}/gu),
      (match) => match[1]!,
    );
    expect(neighbors).toEqual([
      "@history-message-message.2.1.player",
      "@history-message-message.10.2.narrator",
    ]);
    for (const ref of neighbors)
      expect(execute("context_read", { ref }).ok).toBe(true);
    const search = execute("context_search", {
      source: "history",
      query: "没有这个词",
    });
    expect(search.ok).toBe(true);
    expect(search.markdown).not.toContain("all");
    expect(search.markdown).toContain("query");
  },
);
