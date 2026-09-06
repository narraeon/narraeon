// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { resourceTitle } from "../../src/web/preset-resource-names.ts";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { V1Request } from "../../src/protocol/v1.ts";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import { defaultOrderedPlayPrompts } from "../../src/shared/ordered-play-prompts.ts";
import { defaultOrderedAuthorPrompts } from "../../src/shared/ordered-author-prompts.ts";
import {
  PlayPresetScreen,
  type PlayPresetScreenPreset,
} from "../../src/web/PlayPresetScreen.tsx";

afterEach(cleanup);
function fixture(): PlayPresetScreenPreset {
  return {
    id: "preset",
    name: "工作台",
    revision: "rev-original",
    files: structuredClone(firstPartyActionChoicesPresetFiles),
    validation: { status: "valid" },
    scriptsEnabled: false,
    structure: {
      name: "workbench",
      callChainPath: "call-chain.yaml",
      mounts: [],
      playerViewPanels: [],
      extensionRefs: [],
      narrativePrompts: [],
      followups: [],
      playPrompts: defaultOrderedPlayPrompts(),
      authorPrompts: defaultOrderedAuthorPrompts(),
    },
  };
}
function setup(preset = fixture()) {
  let current = preset;
  const request = vi.fn((request: V1Request): Promise<unknown> => {
    if (request.type === "play.read")
      return Promise.resolve({
        currentPresetId: current.id,
        presets: [current],
      });
    if (request.type === "play.save") {
      current = {
        ...current,
        name: request.name,
        files: request.files,
        ...(request.structure
          ? {
              structure: request.structure as unknown as NonNullable<
                PlayPresetScreenPreset["structure"]
              >,
            }
          : {}),
      };
      return Promise.resolve({});
    }
    if (request.type === "play.workbench.read")
      return Promise.resolve({
        id: current.id,
        revision: current.revision,
        name: current.name,
        structure: current.structure,
        artifactPreviews: [],
        staticErrors: [],
        scriptsEnabled: false,
      });
    if (request.type === "workspace.read")
      return Promise.resolve({ worlds: [] });
    return Promise.resolve({});
  });
  render(
    createElement(PlayPresetScreen, {
      client: { request: request as <T>(request: V1Request) => Promise<T> },
      initialLibrary: { currentPresetId: current.id, presets: [current] },
      onLibraryChange: vi.fn(),
      onDirtyChange: vi.fn(),
    }),
  );
  return request;
}
function addFollowup() {
  fireEvent.click(screen.getByRole("button", { name: "新增后置请求" }));
}
function outputs() {
  fireEvent.click(screen.getByRole("button", { name: "界面产物" }));
}

test("one directory exposes prompts, followups and pure interface without file or preview tabs", () => {
  setup();
  expect(screen.getAllByRole("tab").map((n) => n.textContent)).toEqual([
    expect.stringContaining("游玩"),
    expect.stringContaining("设定完善"),
  ]);
  expect(screen.getByRole("list", { name: "提示词顺序" })).toBeTruthy();
  expect(screen.getByRole("list", { name: "后置请求" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "新增纯界面" }));
  expect(screen.getByLabelText("玩家视图面板 1 视图")).toHaveProperty(
    "value",
    "status",
  );
  expect(screen.getByLabelText("预览世界")).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "新建 HTML 模板" }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("tab", { name: /设定完善/u }));
  expect(screen.queryByRole("list", { name: "后置请求" })).toBeNull();
  expect(screen.getByRole("list", { name: "提示词顺序" })).toBeTruthy();
});

test("renaming three independent outputs preserves stable submission names, positions and resource references on save", async () => {
  const request = setup();
  addFollowup();
  fireEvent.change(screen.getByLabelText("后置请求名称"), {
    target: { value: "回顾与建议" },
  });
  outputs();
  fireEvent.change(screen.getByLabelText("产物名称"), {
    target: { value: "第一份回顾" },
  });
  fireEvent.change(screen.getByLabelText("生成内容用途"), {
    target: { value: "回顾已发生的变化" },
  });
  fireEvent.click(screen.getByRole("button", { name: "新建 HTML 模板" }));
  fireEvent.change(screen.getByLabelText("HTML", { exact: true }), {
    target: { value: "<h1>ONE</h1><!-- narraeon:content -->" },
  });
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增产物" }));
  fireEvent.change(screen.getByLabelText("产物名称"), {
    target: { value: "行动建议" },
  });
  fireEvent.change(screen.getByLabelText("产物显示位置"), {
    target: { value: "composer_below" },
  });
  fireEvent.click(screen.getByRole("button", { name: "＋ 新增产物" }));
  fireEvent.change(screen.getByLabelText("产物名称"), {
    target: { value: "第三项" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  const save = request.mock.calls
    .map(([r]) => r)
    .find(
      (r): r is Extract<V1Request, { type: "play.save" }> =>
        r.type === "play.save",
    )!;
  const structure = save.structure as unknown as NonNullable<
    PlayPresetScreenPreset["structure"]
  >;
  expect(structure.followups[0]!.artifacts.map((a) => a.name)).toEqual([
    "output_1",
    "output_2",
    "output_3",
  ]);
  expect(structure.followups[0]!.artifacts.map((a) => a.displayName)).toEqual([
    "第一份回顾",
    "行动建议",
    "第三项",
  ]);
  expect(structure.followups[0]!.artifacts[0]!.purpose).toBe(
    "回顾已发生的变化",
  );
  expect(save.files[structure.followups[0]!.artifacts[0]!.renderer!]).toContain(
    "ONE",
  );
  expect(structure.followups[0]!.artifacts[1]!.renderer).toBeUndefined();
  expect(
    structure.mounts.find(
      (m) => m.channel === structure.followups[0]!.artifacts[1]!.channel,
    )?.mount,
  ).toBe("composer_below");
});

test("new regex rules can be disabled without deleting source, and unlink leaves the shared file", async () => {
  const request = setup();
  addFollowup();
  outputs();
  fireEvent.click(screen.getByRole("button", { name: "新建规则集" }));
  fireEvent.click(screen.getByRole("button", { name: "新增正则规则" }));
  fireEvent.change(screen.getByLabelText("查找", { exact: true }), {
    target: { value: "(" },
  });
  expect(screen.getByLabelText("查找", { exact: true })).toHaveProperty(
    "value",
    "(",
  );
  fireEvent.change(screen.getByLabelText("查找", { exact: true }), {
    target: { value: "KEEP_ORIGINAL" },
  });
  fireEvent.click(screen.getByLabelText("启用规则"));
  fireEvent.change(screen.getByLabelText("规则集", { exact: true }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  const save = request.mock.calls
    .map(([r]) => r)
    .find(
      (r): r is Extract<V1Request, { type: "play.save" }> =>
        r.type === "play.save",
    )!;
  const source = Object.entries(save.files).find(([p]) =>
    p.startsWith("regex/"),
  )![1];
  expect(source).toContain("KEEP_ORIGINAL");
  expect(source).toContain("enabled: false");
});

test("system example is fully read-only, clone becomes independently editable and reorderable", () => {
  setup();
  fireEvent.click(
    screen.getByRole("button", { name: /场景回顾（系统示例）/u }),
  );
  expect(screen.getByLabelText("后置请求名称")).toHaveProperty(
    "readOnly",
    true,
  );
  outputs();
  expect(
    screen.getByRole("button", { name: "移除此产物" }).closest("fieldset")
      ?.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "克隆后置请求" }));
  expect(screen.getByLabelText("后置请求名称")).toHaveProperty(
    "readOnly",
    false,
  );
  const list = screen.getByRole("list", { name: "后置请求" });
  const clone = within(list).getByRole("button", { name: /副本/u });
  fireEvent.keyDown(clone, { key: "ArrowUp", altKey: true });
  expect(list.children[1]?.textContent).toContain("副本");
});

test("dirty draft cannot switch and cancel restores source and metadata", () => {
  setup();
  addFollowup();
  expect(screen.getByLabelText("切换预设")).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "撤销未保存修改" }));
  expect(screen.getByLabelText("切换预设")).toHaveProperty("disabled", false);
  expect(
    within(screen.getByRole("list", { name: "后置请求" })).queryByRole(
      "button",
      { name: /新后置请求/u },
    ),
  ).toBeNull();
});

test("invalid imported source is retained in recovery editor and raw save does not attach stale structure", async () => {
  const preset = fixture();
  delete preset.structure;
  preset.validation = { status: "invalid", message: "Broken imported YAML" };
  const request = setup(preset);
  fireEvent.click(screen.getByRole("button", { name: "修复导入原文" }));
  fireEvent.change(screen.getByLabelText("玩法预设文件", { exact: true }), {
    target: { value: "call-chain.yaml" },
  });
  fireEvent.change(screen.getByLabelText("编辑玩法文件 call-chain.yaml"), {
    target: { value: "original unrepaired content" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  const saved = request.mock.calls
    .map(([r]) => r)
    .find((r) => r.type === "play.save");
  expect(saved).not.toHaveProperty("structure");
  expect(saved).toMatchObject({
    files: { "call-chain.yaml": "original unrepaired content" },
  });
});

test("script examples create independent output resources without enabling script permission", async () => {
  const request = setup();
  addFollowup();
  outputs();
  fireEvent.click(screen.getByRole("button", { name: "新建行动按钮示例" }));
  fireEvent.click(screen.getByRole("button", { name: "新建场景卡片示例" }));
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  expect(request.mock.calls.some(([r]) => r.type === "play.scripts")).toBe(
    false,
  );
  const saved = request.mock.calls
    .map(([r]) => r)
    .find(
      (r): r is Extract<V1Request, { type: "play.save" }> =>
        r.type === "play.save",
    )!;
  const structure = saved.structure as unknown as NonNullable<
    PlayPresetScreenPreset["structure"]
  >;
  const artifacts = structure.followups[0]!.artifacts;
  expect(artifacts).toHaveLength(3);
  expect(artifacts[1]!.renderer).not.toBe(artifacts[2]!.renderer);
  expect(saved.files[artifacts[1]!.scripts![0]!]).toContain(
    "composer.set_draft",
  );
  expect(saved.files[artifacts[1]!.scripts![0]!]).toContain(
    "message.requestId",
  );
});

test("first-party scripts leave bridge.ready to the production host", () => {
  expect(
    firstPartyActionChoicesPresetFiles["scripts/player-options.js"],
  ).not.toContain('type: "bridge.ready"');
});

test("unused named resources can be deleted after unlinking without leaving export references", async () => {
  const request = setup();
  addFollowup();
  outputs();
  fireEvent.change(screen.getByLabelText("资源名称"), {
    target: { value: "样式 - 雾港" },
  });
  fireEvent.click(screen.getByRole("button", { name: "新建命名资源" }));
  expect(
    resourceTitle(
      "assets/12345678-1234-1234-1234-123456789abc-named-_u6837__u5f0f_.12345678-1234-1234-1234-123456789abc.css",
    ),
  ).toBe("样式.css");
  const resource = screen
    .getByText("样式 - 雾港.css", { exact: true, selector: "summary" })
    .closest("details")!;
  fireEvent.click(
    within(resource).getByText("样式 - 雾港.css", {
      exact: true,
      selector: "summary",
    }),
  );
  fireEvent.click(within(resource).getByRole("button", { name: "移除此引用" }));
  fireEvent.click(screen.getByText("预设操作", { exact: true }));
  fireEvent.click(screen.getByText("保留的资源", { exact: true }));
  const unused = screen
    .getByText("样式 - 雾港.css", { exact: true, selector: "summary" })
    .closest("details")!;
  fireEvent.click(
    within(unused).getByText("样式 - 雾港.css", {
      exact: true,
      selector: "summary",
    }),
  );
  fireEvent.click(
    within(unused).getByRole("button", { name: "删除未引用资源" }),
  );
  expect(screen.queryByText("样式 - 雾港.css", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  const save = request.mock.calls
    .map(([r]) => r)
    .find(
      (r): r is Extract<V1Request, { type: "play.save" }> =>
        r.type === "play.save",
    )!;
  expect(Object.keys(save.files).some((p) => p.includes("named-"))).toBe(false);
  expect(JSON.stringify(save.structure)).not.toContain("named-");
});
