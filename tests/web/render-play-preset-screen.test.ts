// @vitest-environment jsdom
import { setWebLocale } from "../../src/web/i18n.ts";
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

test.each(["zh-CN", "en"] as const)(
  "advanced labels and normal feedback are readable in %s without changing saved enum values",
  async (locale) => {
    setWebLocale(locale);
    const cn = locale === "zh-CN";
    const request = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: cn ? "新增后置请求" : "Add follow-up request",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: cn ? "高级设置" : "Advanced",
      }),
    );
    const format = screen.getByLabelText(cn ? "内容格式" : "Content format");
    expect(
      within(format)
        .getByRole("option", {
          name: cn ? "JSON 结构化数据" : "Structured JSON data",
        })
        .getAttribute("value"),
    ).toBe("application/json");
    const strategy = screen.getByLabelText(cn ? "更新方式" : "Update policy");
    expect(
      within(strategy)
        .getByRole("option", {
          name: cn ? "仅在生成期间显示" : "Show only while generating",
        })
        .getAttribute("value"),
    ).toBe("transient");
    const save = screen.getByLabelText(cn ? "保存范围" : "Save scope");
    expect(
      within(save)
        .getByRole("option", {
          name: cn ? "随世界进度保存" : "Save with world progress",
        })
        .getAttribute("value"),
    ).toBe("commit");
    const clearing = screen.getByLabelText(
      cn ? "清空条件" : "Clearing condition",
    );
    expect(
      within(clearing)
        .getByRole("option", {
          name: cn
            ? "世界状态版本改变时"
            : "When the world state version changes",
        })
        .getAttribute("value"),
    ).toBe("head_change");
    fireEvent.change(strategy, { target: { value: "append" } });
    fireEvent.change(clearing, { target: { value: "never" } });
    fireEvent.click(
      screen.getByRole("button", { name: cn ? "保存修改" : "Save changes" }),
    );
    await screen.findByText(cn ? "预设已保存。" : "Preset saved.");
    const saved = request.mock.calls
      .map(([r]) => r)
      .find(
        (r): r is Extract<V1Request, { type: "play.save" }> =>
          r.type === "play.save",
      )!;
    expect(
      (
        saved.structure as unknown as NonNullable<
          PlayPresetScreenPreset["structure"]
        >
      ).followups[0]!.artifacts[0],
    ).toMatchObject({
      contentType: "text/markdown",
      strategy: "append",
      save: "commit",
      invalidation: "never",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: cn ? "应用为当前玩法" : "Use as current play preset",
      }),
    );
    await screen.findByText(
      cn
        ? "已应用此预设；游玩修改将在下一次正常发送时生效。"
        : "Preset applied. Play changes take effect on the next normal send.",
    );
  },
);

test("message role and merging controls are saved with the preset", async () => {
  const request = setup();
  expect(screen.getByLabelText<HTMLSelectElement>("发送角色").disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "新增提示词" }));
  fireEvent.change(screen.getByLabelText("提示词名称"), {
    target: { value: "示例回答" },
  });
  fireEvent.change(screen.getByLabelText("提示词正文"), {
    target: { value: "夜色渐浓。" },
  });
  fireEvent.change(screen.getByLabelText("发送角色"), {
    target: { value: "assistant" },
  });
  fireEvent.click(screen.getByLabelText("合并相邻同角色消息"));
  fireEvent.click(screen.getByRole("button", { name: "克隆提示词" }));
  expect(screen.getByLabelText<HTMLSelectElement>("发送角色").value).toBe(
    "assistant",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  const save = request.mock.calls
    .map(([r]) => r)
    .find((r) => r.type === "play.save");
  expect(save?.structure).toMatchObject({ mergeConsecutiveMessages: false });
  expect(save?.structure).toHaveProperty(
    "playPrompts",
    expect.arrayContaining([
      expect.objectContaining({
        name: "示例回答",
        messageRole: "assistant",
        body: "夜色渐浓。",
      }),
      expect.objectContaining({
        name: "示例回答 副本",
        messageRole: "assistant",
      }),
    ]),
  );
});

async function savedRequest(request: ReturnType<typeof setup>) {
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === "play.save")).toBe(true),
  );
  return request.mock.calls
    .map(([r]) => r)
    .find(
      (r): r is Extract<V1Request, { type: "play.save" }> =>
        r.type === "play.save",
    )!;
}

test("interface resource creation reaches save with its declaration, file and extension index", async () => {
  const request = setup();
  fireEvent.click(screen.getByRole("button", { name: "新增纯界面" }));
  fireEvent.click(screen.getByRole("button", { name: "新建 HTML 模板" }));
  fireEvent.change(screen.getByLabelText("HTML", { exact: true }), {
    target: { value: "<main>PANEL</main>" },
  });
  const save = await savedRequest(request);
  const structure = save.structure as unknown as NonNullable<
    PlayPresetScreenPreset["structure"]
  >;
  const renderer = structure.playerViewPanels[0]!.renderer!;
  expect(save.files[renderer]).toBe("<main>PANEL</main>");
  expect(structure.extensionRefs).toContain(renderer);
  expect(request.mock.calls.some(([r]) => r.type === "play.scripts")).toBe(
    false,
  );
});

function resourceRequestFixture() {
  const preset = fixture();
  preset.structure!.followups = [
    {
      id: "request",
      displayName: "来源请求",
      prompt: { role: "author_instruction", path: "prompts/request.md" },
      maxArtifactBytes: 32768,
      artifacts: [
        {
          name: "status",
          channel: "source",
          strategy: "replace",
          contentType: "text/markdown",
          renderer: "renderers/view.html",
          rendererRevision: "v1",
          scripts: ["scripts/view.js"],
          assets: ["assets/data.json"],
          save: "commit",
          invalidation: "never",
          required: false,
          maxEmits: 1,
        },
      ],
    },
  ];
  Object.assign(preset.files, {
    "prompts/request.md": "Original prompt",
    "renderers/view.html": "<main>Original</main>",
    "scripts/view.js": 'window.__NARRAEON_ASSETS__["assets/data.json"]',
    "assets/data.json": '{"value":1}',
  });
  preset.structure!.mounts = [{ channel: "source", mount: "sidebar" }];
  preset.structure!.extensionRefs = [
    "renderers/view.html",
    "scripts/view.js",
    "assets/data.json",
  ];
  return preset;
}

test("clone and remove-output buttons save independent rewritten resources and clean only the removed mount", async () => {
  const preset = resourceRequestFixture();
  const request = setup(preset);
  fireEvent.click(screen.getByRole("button", { name: /来源请求/u }));
  fireEvent.click(screen.getByRole("button", { name: "克隆后置请求" }));
  expect(screen.getByLabelText("后置请求名称")).toHaveProperty(
    "value",
    "来源请求 副本",
  );
  outputs();
  fireEvent.click(screen.getByRole("button", { name: "移除此产物" }));
  const save = await savedRequest(request);
  const structure = save.structure as unknown as NonNullable<
    PlayPresetScreenPreset["structure"]
  >;
  expect(structure.followups).toHaveLength(2);
  expect(structure.followups[0]).toEqual(preset.structure!.followups[0]);
  expect(structure.followups[1]!.artifacts).toEqual([]);
  expect(structure.mounts).toEqual([{ channel: "source", mount: "sidebar" }]);
  const copiedScript = structure.extensionRefs.find(
    (path) => path.startsWith("scripts/") && path !== "scripts/view.js",
  )!;
  const copiedData = structure.extensionRefs.find(
    (path) => path.startsWith("assets/") && path !== "assets/data.json",
  )!;
  expect(save.files[copiedScript]).toBe(
    `window.__NARRAEON_ASSETS__["${copiedData}"]`,
  );
  expect(save.files["scripts/view.js"]).toBe(preset.files["scripts/view.js"]);
  expect(request.mock.calls.some(([r]) => r.type === "play.scripts")).toBe(
    false,
  );
});

test("resource deletion button follows current source references through edits and save", async () => {
  const preset = fixture();
  preset.files["assets/data.json"] = "{}";
  preset.files["scripts/consumer.js"] =
    'window.__NARRAEON_ASSETS__["assets/data.json"]';
  preset.structure!.extensionRefs = ["assets/data.json", "scripts/consumer.js"];
  const request = setup(preset);
  fireEvent.click(screen.getByText("预设操作", { exact: true }));
  fireEvent.click(screen.getByText("保留的资源", { exact: true }));
  const data = screen
    .getByText("data.json", { selector: "summary" })
    .closest("details")!;
  fireEvent.click(within(data).getByText("data.json", { selector: "summary" }));
  expect(
    within(data).getByRole("button", { name: "删除未引用资源" }),
  ).toHaveProperty("disabled", true);
  const consumer = screen
    .getByText("consumer.js", { selector: "summary" })
    .closest("details")!;
  fireEvent.click(
    within(consumer).getByText("consumer.js", { selector: "summary" }),
  );
  fireEvent.change(within(consumer).getByRole("textbox"), {
    target: { value: "// no resource references" },
  });
  expect(
    within(data).getByRole("button", { name: "删除未引用资源" }),
  ).toHaveProperty("disabled", false);
  fireEvent.click(within(data).getByRole("button", { name: "删除未引用资源" }));
  const save = await savedRequest(request);
  expect(save.files["assets/data.json"]).toBeUndefined();
  expect(
    (
      save.structure as unknown as NonNullable<
        PlayPresetScreenPreset["structure"]
      >
    ).extensionRefs,
  ).toEqual(["scripts/consumer.js"]);
});

test("missing clone resource shows a diagnostic and preserves the draft and selection", async () => {
  const preset = resourceRequestFixture();
  delete preset.files["assets/data.json"];
  const request = setup(preset);
  fireEvent.click(screen.getByRole("button", { name: /来源请求/u }));
  fireEvent.click(screen.getByRole("button", { name: "克隆后置请求" }));
  expect(screen.getByRole("alert").textContent).toContain("assets/data.json");
  expect(screen.getByLabelText("后置请求名称")).toHaveProperty(
    "value",
    "来源请求",
  );
  fireEvent.change(screen.getByLabelText("后置请求名称"), {
    target: { value: "仍可编辑" },
  });
  const save = await savedRequest(request);
  expect(save.files).toEqual(preset.files);
  const structure = save.structure as unknown as NonNullable<
    PlayPresetScreenPreset["structure"]
  >;
  expect(structure.followups).toHaveLength(1);
  expect(structure.followups[0]!.displayName).toBe("仍可编辑");
});

test("cloning the system example reaches save with its production story mount", async () => {
  const request = setup();
  fireEvent.click(
    screen.getByRole("button", { name: /场景回顾（系统示例）/u }),
  );
  fireEvent.click(screen.getByRole("button", { name: "克隆后置请求" }));
  const save = await savedRequest(request);
  const structure = save.structure as unknown as NonNullable<
    PlayPresetScreenPreset["structure"]
  >;
  expect(structure.mounts).toEqual([
    { channel: structure.followups[0]!.artifacts[0]!.channel, mount: "story" },
  ]);
});
