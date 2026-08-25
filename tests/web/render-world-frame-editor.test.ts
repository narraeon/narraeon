// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { parse } from "yaml";
import { afterEach, describe, expect, test, vi, type Mock } from "vitest";

import type { ContentTreeFile } from "../../src/protocol/v1.ts";
import { WorldFrameEditor } from "../../src/web/WorldFrameEditor.tsx";

afterEach(cleanup);

describe("世界提示框架可视化编辑器", () => {
  test("新增最近叙事插槽并调整条数，YAML 里落成 history slot", () => {
    const changed = vi.fn<(contents: string) => void>();
    render(
      createElement(FrameHarness, {
        initialContents: frame(),
        files: files(),
        onContentsChange: changed,
        onSave: vi.fn(),
      }),
    );

    fireEvent.change(screen.getByLabelText("新增材料类型"), {
      target: { value: "history" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新增材料插槽" }));

    const added = latestFrame(changed).context.at(-2)?.slot;
    expect(added).toEqual({ kind: "history", recent: 2 });

    // 条数可调，且不带 required——history 不接受它。
    fireEvent.change(screen.getByLabelText("带上最近几条 3"), {
      target: { value: "5" },
    });
    expect(latestFrame(changed).context.at(-2)?.slot).toEqual({
      kind: "history",
      recent: 5,
    });
    expect(screen.queryByLabelText("缺失时阻止请求 3")).toBeNull();
  });

  test("编辑当前情境绑定、指令顺序与确定性材料插槽", () => {
    const changed = vi.fn<(contents: string) => void>();
    const onSave = vi.fn();
    render(
      createElement(FrameHarness, {
        initialContents: frame(),
        files: files(),
        onContentsChange: changed,
        onSave,
      }),
    );

    expect(screen.getByRole("heading", { name: "世界提示框架" })).toBeTruthy();
    expect(screen.getByLabelText("世界提示框架流程").textContent).toContain(
      "author_instruction",
    );
    expect(screen.getByText("从上到下就是实际注入顺序")).toBeTruthy();
    // 这份 fixture 的 frame 存的是 id；编辑器要认出它指向哪份文档，否则选择框
    // 读起来像“没选”，一保存就把绑定丢了。写回时统一成作者可见的 @短引用。
    expect(screen.getByLabelText<HTMLSelectElement>("当前情境文档").value).toBe(
      "@current-situation",
    );

    fireEvent.change(screen.getByLabelText("当前情境文档"), {
      target: { value: "@situation-alternate" },
    });
    expect(latestFrame(changed).bindings.currentSituation).toBe(
      "@situation-alternate",
    );

    fireEvent.click(screen.getByRole("button", { name: "下移 世界风格" }));
    expect(
      latestFrame(changed).instructions.map(({ markdown }) => markdown),
    ).toEqual(["blocks/state.md", "blocks/style.md"]);

    const directory = screen.getByLabelText<HTMLSelectElement>("目录 2");
    expect(directory.tagName).toBe("SELECT");
    expect(Array.from(directory.options, ({ text }) => text)).toContain(
      "world/locations/ — 1 份文档",
    );
    fireEvent.change(directory, { target: { value: "locations" } });
    expect(latestFrame(changed).context[1]?.slot.directory).toBe("locations");

    fireEvent.change(screen.getByLabelText("最多目录项 2"), {
      target: { value: "12" },
    });
    expect(latestFrame(changed).context[1]?.slot.maxEntries).toBe(12);

    fireEvent.click(screen.getByRole("button", { name: "新增材料插槽" }));
    fireEvent.change(screen.getByLabelText("文档 3"), {
      target: { value: "@character-qinlong" },
    });
    fireEvent.click(screen.getByLabelText("缺失时阻止请求 3"));
    const added = latestFrame(changed).context[2]?.slot;
    expect(added).toMatchObject({
      kind: "document",
      document: "@character-qinlong",
      required: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "下移材料 1" }));
    expect(latestFrame(changed).context.map(({ slot }) => slot.kind)).toEqual([
      "catalog",
      "current_situation",
      "document",
      "additional_materials",
    ]);

    fireEvent.keyDown(screen.getByLabelText("当前情境文档"), {
      key: "s",
      ctrlKey: true,
    });
    expect(onSave).toHaveBeenCalledOnce();
  });

  test("目录与显式引用来源只从内容包中的实际关联目标选择", () => {
    const changed = vi.fn<(contents: string) => void>();
    render(
      createElement(FrameHarness, {
        initialContents: frame(),
        files: files(),
        onContentsChange: changed,
        onSave: vi.fn(),
      }),
    );

    fireEvent.change(screen.getByLabelText("新增材料类型"), {
      target: { value: "reference_targets" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新增材料插槽" }));

    const source = screen.getByLabelText<HTMLSelectElement>("来源 YAML 文件 3");
    const sourceOptions = Array.from(source.options, ({ text }) => text);
    expect(sourceOptions).toContain(
      "world/characters/qinlong.yaml — 秦龙 · @character-qinlong",
    );
    expect(sourceOptions.join("\n")).not.toContain("world/rules/lore.md");

    const locator = screen.getByLabelText<HTMLSelectElement>(
      "从 YAML 哪个字段读取 $ref（插槽 3）",
    );
    const locatorOptions = Array.from(locator.options, ({ text }) => text);
    expect(locator.value).toBe(JSON.stringify(["人物"]));
    expect(locatorOptions).toContain("人物 — 列表 · 2 个 $ref");
    expect(locatorOptions).toContain("场景 › 地点 — 对象 · 1 个 $ref");
    expect(locatorOptions).toContain("备注 — 对象 · 当前无 $ref");

    fireEvent.change(locator, {
      target: { value: JSON.stringify(["场景", "地点"]) },
    });
    expect(latestFrame(changed).context[2]?.slot.from).toEqual({
      document: "@current-situation",
      locator: { yaml: ["场景", "地点"] },
    });

    fireEvent.change(source, { target: { value: "@character-qinlong" } });
    expect(latestFrame(changed).context[2]?.slot.from).toEqual({
      document: "@character-qinlong",
      locator: { yaml: [] },
    });
    expect(
      screen.getByText(
        "实际关联 world/characters/qinlong.yaml；frame.yaml 保存 @短引用：@character-qinlong",
      ),
    ).toBeTruthy();
  });

  // 每次编辑本来就整份重写 frame.yaml，留着 id 只会让后续的 AI 编辑读到
  // doc.<uuid> 这种它无从对应到任何文档的值——没有任何设定工具会报出 id。
  test("保存时把可解析的 id 一并规范化为 @短引用，无法解析的原样保留", () => {
    const changed = vi.fn<(contents: string) => void>();
    render(
      createElement(FrameHarness, {
        initialContents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/style.md
  - markdown: blocks/state.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: document, document: character.qinlong }
  - slot: { kind: document, document: doc.deadbeef }
  - slot: { kind: additional_materials }
`,
        files: files(),
        onContentsChange: changed,
        onSave: vi.fn(),
      }),
    );

    // 改的是指令顺序，完全没碰任何文档字段。
    fireEvent.click(screen.getByRole("button", { name: "下移 世界风格" }));

    const saved = latestFrame(changed);
    expect(saved.bindings.currentSituation).toBe("@current-situation");
    expect(saved.context[1]?.slot.document).toBe("@character-qinlong");
    expect(saved.context[2]?.slot.document).toBe("doc.deadbeef");
  });

  test("YAML 损坏时只开放原文修复，不用推断结果冒充可视化", () => {
    const onChange = vi.fn();
    render(
      createElement(WorldFrameEditor, {
        contents: "format: [",
        files: files(),
        dirty: true,
        onChange,
        onSave: vi.fn(),
      }),
    );

    expect(screen.getByText("当前 YAML 暂时无法可视化")).toBeTruthy();
    expect(screen.queryByLabelText("当前情境文档")).toBeNull();
    const source = screen.getByLabelText("直接编辑 control/frame.yaml");
    fireEvent.change(source, {
      target: { value: "format: narraeon.world-frame/v1\n" },
    });
    expect(onChange).toHaveBeenCalledWith("format: narraeon.world-frame/v1\n");
  });
});

function FrameHarness({
  initialContents,
  files,
  onContentsChange,
  onSave,
}: {
  initialContents: string;
  files: ContentTreeFile[];
  onContentsChange: (contents: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  const [contents, setContents] = useState(initialContents);
  const [dirty, setDirty] = useState(false);
  return createElement(WorldFrameEditor, {
    contents,
    files,
    dirty,
    onChange: (next) => {
      setContents(next);
      setDirty(true);
      onContentsChange(next);
    },
    onSave,
  });
}

interface ParsedFrameFixture {
  bindings: { currentSituation: string };
  instructions: { markdown: string }[];
  context: { slot: Record<string, unknown> }[];
}

function latestFrame(
  changed: Mock<(contents: string) => void>,
): ParsedFrameFixture {
  const yaml = changed.mock.lastCall?.[0];
  if (typeof yaml !== "string") throw new Error("测试未收到 frame YAML");
  return parse(yaml) as ParsedFrameFixture;
}

function frame(): string {
  return `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/style.md
  - markdown: blocks/state.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: additional_materials }
`;
}

function files(): ContentTreeFile[] {
  return [
    {
      path: "world/current-situation.yaml",
      contents: referencedDocument(),
    },
    {
      path: "world/alternate-situation.yaml",
      contents: document("situation.alternate", "备用情境"),
    },
    {
      path: "world/characters/qinlong.yaml",
      contents: document("character.qinlong", "秦龙"),
    },
    {
      path: "world/locations/dorm.yaml",
      contents: document("location.dorm", "宿舍"),
    },
    {
      path: "world/rules/lore.md",
      contents: markdownDocument("rule.lore", "世界规则"),
    },
    {
      path: "control/blocks/style.md",
      contents: "# 世界风格\n\n克制、具体。\n",
    },
    {
      path: "control/blocks/state.md",
      contents: "# 状态维护\n\n持续事实写回自然所有者。\n",
    },
  ];
}

function document(id: string, title: string): string {
  return `$document:
  id: ${id}
  ref: ${id.replaceAll(".", "-")}
  title: ${title}
  summary: ${title}文档。
  aliases: []
值: 示例
`;
}

function referencedDocument(): string {
  return `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 当前情境文档。
  aliases: []
人物:
  - $ref: character.qinlong
  - $ref: character.qiming
场景:
  地点:
    $ref: location.dorm
备注: {}
`;
}

function markdownDocument(id: string, title: string): string {
  return `---
$document:
  id: ${id}
  ref: ${id.replaceAll(".", "-")}
  title: ${title}
  summary: ${title}文档。
  aliases: []
---

# ${title}

示例正文。
`;
}
