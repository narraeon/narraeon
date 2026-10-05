import { expect, test } from "vitest";
import { parse } from "yaml";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import {
  captureNarrativeOrigin,
  narrativeBackground,
} from "../../src/runtime/history/HistoryBackground.ts";
import { HistoryQuery } from "../../src/runtime/history/HistoryQuery.ts";
import {
  renderHistoryMessage,
  renderHistoryResult,
  renderHistoryBackground,
} from "../../src/runtime/history/HistoryRendering.ts";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";

function snapshot(body: string, markdown = false, binding = "@bound") {
  return WorldDocumentStore.open({
    layout: "world_state",
    files: [
      {
        path: "control/frame.yaml",
        contents: `bindings:\n  currentSituation: ${JSON.stringify(binding)}\n`,
      },
      {
        path: `state/arbitrary.${markdown ? "md" : "yaml"}`,
        contents: markdown
          ? "---\n$document:\n  id: situation.bound\n  ref: bound\n  title: Scene\n  summary: Scene\n  aliases: []\n---\n# Scene\n\n## 背景\nDay one"
          : "$document:\n  id: situation.bound\n  ref: bound\n  title: Scene\n  summary: Scene\n  aliases: []\n" +
            body,
      },
      {
        path: "state/current-situation.yaml",
        contents:
          "$document:\n  id: decoy\n  ref: decoy\n  title: 当前情境\n  summary: decoy\n  aliases: []\n背景: filename decoy\n",
      },
    ],
  });
}

test.each([
  "",
  "背景: null",
  '背景: "  "',
  "背景: {}",
  "背景: []",
  "background: ignored\n其他:\n  背景: nested",
  "背 景: ignored",
])("空值、缺失与非精确字段没有背景：%s", (body) => {
  expect(captureNarrativeOrigin(snapshot(body), 1).value).toBeNull();
});

test.each([
  "0",
  "false",
  '"文本"',
  '"第一行\\n\\n"',
  '{备注: "第一行\\n\\n"}',
  "{时间: 第一天, 地点: 客栈, 嵌套: [null, {}, [], false, 0]}",
  "[第一天, {地点: 客栈}, null]",
])("背景保留完整 YAML 值：%s", (source) => {
  const origin = captureNarrativeOrigin(
    snapshot(`背景: ${source}\n其他: ${"长兄弟内容".repeat(1000)}\n`),
    4,
  );
  expect(parse(origin.value!)).toEqual(parse(source));
  expect(origin.value).not.toContain("长兄弟内容");
  expect(origin.documentId).toBe("situation.bound");
});

test("Markdown 不推断标题；旧精确 ID 绑定与显式引用只投影句柄", () => {
  expect(captureNarrativeOrigin(snapshot("", true), 1).value).toBeNull();
  const origin = captureNarrativeOrigin(
    snapshot("背景: {$ref: decoy}\n", false, "situation.bound"),
    1,
  );
  expect(parse(origin.value!)).toEqual({ $ref: "@decoy" });
  expect(origin.value).not.toContain("filename decoy");
  expect(
    narrativeBackground(undefined, snapshot("背景: 已变化")),
  ).toBeUndefined();
});

test.each(["en", "zh-CN"] as const)(
  "前后背景、单端缺失与相同值在所有工具独立展示：%s",
  (locale) => {
    const before = captureNarrativeOrigin(
      snapshot("背景: {时间: 第一天, 地点: 客栈}"),
      1,
    );
    for (const after of [
      "背景: {时间: 第二天, 地点: 山门}",
      "背景: null",
      "背景: {时间: 第一天, 地点: 客栈}",
    ]) {
      const background = narrativeBackground(before, snapshot(after))!;
      const input = {
        id: "message.2.1.narrator",
        role: "narrator" as const,
        text: "  明天到这里。\n\n",
        background,
      };
      const query = new HistoryQuery("world", [input]);
      const full = renderHistoryMessage(query.messages[0]!, locale);
      expect(full).toContain(input.text);
      expect(full.indexOf(before.value!)).toBeLessThan(
        full.indexOf(
          locale === "zh-CN" ? "[原文开始]" : "[Original text begins]",
        ),
      );
      if (
        background.kind === "narrative" &&
        background.after === background.before
      ) {
        expect(full.split(before.value!).length - 1).toBe(1);
      } else {
        expect(full).toContain(
          locale === "zh-CN" ? "推进前背景" : "Background before advancement",
        );
        expect(full).toContain(
          locale === "zh-CN" ? "推进后背景" : "Background after advancement",
        );
        if (background.kind === "narrative" && background.after === null)
          expect(full).toContain(
            locale === "zh-CN" ? "未记录" : "not recorded",
          );
      }
      for (const [name, args] of [
        ["history_read", { latest: 1 }],
        ["history_list", {}],
        ["history_search", { queries: ["明天"] }],
      ] as const) {
        const result = new FileNativePlayDocuments({}).execute(
          { id: name, name, arguments: args },
          [{ path: input.id, contents: input.text, background }],
          { locale },
        );
        expect(result.ok).toBe(true);
        expect(result.markdown).toContain(before.value!);
      }
      expect(
        renderHistoryResult(query.read({ latest: 1 }), locale).markdown,
      ).toContain(full);
    }
    const noBefore = captureNarrativeOrigin(snapshot(""), 1);
    expect(narrativeBackground(noBefore, snapshot("背景: false"))).toEqual({
      kind: "narrative",
      before: null,
      after: "false",
    });
    expect(narrativeBackground(noBefore, snapshot(""))).toBeUndefined();
  },
);

test("搜索偏移与长度仅来自原文，背景纳入游标快照", () => {
  const plain = [
    { id: "message.1.1.player", role: "player" as const, text: "明天的约定。" },
    {
      id: "message.2.1.narrator",
      role: "narrator" as const,
      text: "后天到这里。",
    },
  ];
  const enriched = plain.map((message) => ({
    ...message,
    background: {
      kind: "snapshot" as const,
      value: "时间: 第一天\n地点: 客栈",
    },
  }));
  const query = new HistoryQuery("world", enriched);
  expect(query.search({ queries: ["客栈"] })).toMatchObject({ matches: 0 });
  const stripped = new HistoryQuery("world", plain).search({ queries: ["天"] });
  const found = query.search({ queries: ["天"] });
  if (!found.ok || !stripped.ok) throw new Error("search failed");
  expect(found.messages.map(({ fragments }) => fragments)).toEqual(
    stripped.messages.map(({ fragments }) => fragments),
  );
  expect(query.messages.map(({ length }) => length)).toEqual(
    plain.map(({ text }) => Array.from(text).length),
  );
  const page = query.list({ limit: 1 });
  if (!page.ok) throw new Error("list failed");
  expect(
    new HistoryQuery("world", enriched).list({ cursor: page.earlierCursor }),
  ).toMatchObject({ ok: true });
  expect(
    new HistoryQuery("world", plain).list({ cursor: page.earlierCursor }),
  ).toMatchObject({ ok: false, code: "history_changed" });
});

test("映射顺序变化仍只展示一份背景，查询快照不随调用方对象变动", () => {
  const before = "时间: 第一天\n地点: 客栈";
  const after = "地点: 客栈\n时间: 第一天";
  const rendered = renderHistoryBackground(
    { kind: "narrative", before, after },
    "zh-CN",
  );
  expect(rendered).toContain(before);
  expect(rendered).not.toContain(after);
  expect(rendered).not.toContain("推进前背景");
  const input = {
    id: "message.1.1.player",
    role: "player" as const,
    text: "明天见。",
    background: { kind: "snapshot" as const, value: before },
  };
  const query = new HistoryQuery("world", [input]);
  input.background.value = "时间: 第十天";
  expect(query.messages[0]?.background).toEqual({
    kind: "snapshot",
    value: before,
  });
});
