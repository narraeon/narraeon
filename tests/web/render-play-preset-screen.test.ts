// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { V1Request } from "../../src/protocol/v1.ts";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import {
  PlayPresetScreen,
  type PlayPresetScreenPreset,
} from "../../src/web/PlayPresetScreen.tsx";

type Preset = PlayPresetScreenPreset & { validation: { status: "valid" } };

const editorStructure: NonNullable<Preset["structure"]> = {
  name: "结构化玩法",
  callChainPath: "call-chain.yaml",
  mounts: [],
  playerViewPanels: [],
  extensionRefs: [],
  narrativePrompts: [
    { role: "author_instruction", path: "prompts/narrate.md" },
  ],
  followups: [
    {
      id: "player_options",
      displayName: "行动选项",
      prompt: { role: "author_instruction", path: "prompts/options.md" },
      artifacts: [
        {
          name: "player_options",
          channel: "player.options",
          strategy: "replace",
          contentType: "application/json",
          save: "commit",
          invalidation: "new_operation",
          required: true,
          maxEmits: 1,
        },
      ],
      maxArtifactBytes: 32_768,
    },
  ],
};

function workbenchSnapshot(
  id: string,
  revision: string,
  message: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    revision,
    structure: editorStructure,
    artifactPreviews: [],
    staticErrors: [{ code: "fixture", message, location: "call-chain.yaml" }],
    trustedLocalCode: false,
    scriptsEnabled: false,
  };
}

afterEach(cleanup);

describe("玩法预设工作台", () => {
  test("复制推荐起点后展示普通文件并允许编辑 contract/renderer 文件", async () => {
    const base: Preset = {
      id: "default",
      name: "default",
      revision: "rev-base",
      files: structuredClone(firstPartyActionChoicesPresetFiles),
      validation: { status: "valid" },
    };
    const requests: unknown[] = [];
    let copied: Preset | null = null;
    const client = {
      request: vi.fn((request: V1Request) => {
        requests.push(request);
        if (request.type === "play.create") {
          copied = {
            ...base,
            id: "copy",
            name: "下一步建议（可编辑副本）",
            files: request.files ?? base.files,
          };
          return Promise.resolve({ currentPresetId: "copy", preset: copied });
        }
        if (request.type === "play.read")
          return Promise.resolve({
            currentPresetId: copied?.id ?? base.id,
            presets: copied === null ? [base] : [base, copied],
          });
        return Promise.reject(new Error(`unexpected ${request.type}`));
      }),
    } as unknown as {
      request<T = unknown>(request: V1Request): Promise<T>;
    };
    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: { currentPresetId: base.id, presets: [base] },
        recommendedTemplates: [
          {
            id: "fixture-action-choices",
            label: "行动选项",
            name: "下一步建议（可编辑副本）",
            files: firstPartyActionChoicesPresetFiles,
          },
        ],
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );

    expect(screen.getByRole("heading", { name: "玩法预设" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制推荐行动选项" }));
    await screen.findByText("已复制推荐行动选项；所有文件均可编辑。");
    const create = requests.find(
      (
        request,
      ): request is { type: "play.create"; files?: Record<string, string> } =>
        typeof request === "object" &&
        request !== null &&
        (request as { type?: string }).type === "play.create",
    );
    expect(create?.files).toBeDefined();
    expect(Object.keys(create?.files ?? {})).toEqual(
      expect.arrayContaining([
        "prompts/options.md",
        "call-chain.yaml",
        "renderers/player-options.html",
        "scripts/player-options.js",
        "assets/player-options.css",
      ]),
    );
  });

  test("推荐模板 registry 为空时工作台仍可编辑普通玩法文件", () => {
    const base: Preset = {
      id: "generic",
      name: "普通玩法",
      revision: "rev-generic",
      files: {
        "preset.yaml": "format: narraeon.play-preset/v1\n",
      },
      validation: { status: "valid" },
    };
    const client = {
      request: vi.fn(),
    } as unknown as {
      request<T = unknown>(request: V1Request): Promise<T>;
    };
    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: { currentPresetId: base.id, presets: [base] },
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(
      screen.queryByRole("button", { name: "复制推荐行动选项" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "玩法预设" })).toBeTruthy();
  });

  test("以五个任务区收纳流程、内容、文件和预览，管理操作不再独占分页", async () => {
    const base: Preset = {
      id: "organized",
      name: "清晰玩法",
      revision: "rev-organized",
      files: {
        "preset.yaml": "format: narraeon.play-preset/v1\n",
        "call-chain.yaml": "format: narraeon.play-call-chain/v1\n",
        "prompts/policy.md": "# Policy\n",
      },
      validation: { status: "valid" },
      structure: editorStructure,
      enabled: true,
      scriptsEnabled: false,
    };
    const sibling: Preset = {
      ...base,
      id: "organized-copy",
      name: "备用玩法",
      revision: "rev-organized-copy",
    };
    const requestMock = vi.fn((request: V1Request) => {
      if (request.type === "play.workbench.read")
        return Promise.resolve({
          id: base.id,
          name: base.name,
          revision: base.revision,
          structure: editorStructure,
          artifactPreviews: [],
          staticErrors: [],
          trustedLocalCode: false,
          scriptsEnabled: false,
        });
      return Promise.reject(new Error(`unexpected ${request.type}`));
    });
    const client = {
      request: requestMock,
    } as unknown as { request<T = unknown>(request: V1Request): Promise<T> };
    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: {
          currentPresetId: base.id,
          presets: [base, sibling],
        },
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );

    expect(
      screen.getByRole("button", { name: "删除后置请求 player_options" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("玩法预设文件", { exact: true })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /高级文件/u }));
    expect(screen.getByLabelText("玩法预设文件", { exact: true })).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(/编辑玩法文件/u).wrap,
    ).toBe("soft");
    expect(
      screen.queryByRole("button", { name: "删除后置请求 player_options" }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText("玩法预设名称"), {
      target: { value: "清晰玩法二版" },
    });
    expect(screen.getByText("未保存修改")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /备用玩法/u })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "撤销未保存修改" }));
    expect(screen.getByLabelText<HTMLInputElement>("玩法预设名称").value).toBe(
      "清晰玩法",
    );
    expect(
      screen
        .getByRole("button", { name: /备用玩法/u })
        .hasAttribute("disabled"),
    ).toBe(false);

    expect(screen.queryByRole("tab", { name: /管理/u })).toBeNull();
    fireEvent.click(screen.getByText("预设操作"));
    expect(screen.getByLabelText("玩法预设身份管理")).toBeTruthy();
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith({
        type: "play.workbench.read",
        presetId: base.id,
        revision: base.revision,
      }),
    );
  });

  test("第一方脚本不重复发送由 host 注入的 bridge.ready", () => {
    expect(
      firstPartyActionChoicesPresetFiles["scripts/player-options.js"],
    ).not.toContain('type: "bridge.ready"');
  });

  test("常用配置直接显示提示内容、解释频道与核心 YAML，并在原页嵌入预览", async () => {
    const structure = structuredClone(editorStructure);
    structure.mounts = [{ channel: "player.options", mount: "composer_below" }];
    structure.extensionRefs = [
      "renderers/player-options.html",
      "scripts/player-options.js",
      "assets/player-options.css",
    ];
    const base: Preset = {
      id: "readable",
      name: "可读玩法",
      revision: "rev-readable",
      files: structuredClone(firstPartyActionChoicesPresetFiles),
      validation: { status: "valid" },
      structure,
      enabled: true,
      scriptsEnabled: false,
    };
    const client = {
      request: vi.fn((request: V1Request) => {
        if (request.type === "play.workbench.read")
          return Promise.resolve({
            id: base.id,
            name: base.name,
            revision: base.revision,
            structure,
            artifactPreviews: [
              {
                requestId: "player_options",
                output: "player_options",
                declaration: structure.followups[0]?.artifacts[0],
                rawPayload: [{ id: "observe", label: "先观察四周" }],
                rawText: '[{"id":"observe","label":"先观察四周"}]',
                regex: [],
                activeProjection: {
                  status: "active",
                  channel: "player.options",
                  strategy: "replace",
                  save: "commit",
                },
                clear: {
                  supported: true,
                  invalidation: "new_operation",
                  description: "新操作开始时清除",
                },
                simulation: {
                  emitted: { status: "active", identity: "fixture" },
                  explicitClear: { status: "cleared", identity: "fixture" },
                  invalidation: {
                    policy: "new_operation",
                    status: "cleared",
                    reason: "新操作开始",
                  },
                },
                diagnostics: [],
              },
            ],
            staticErrors: [],
            trustedLocalCode: false,
            scriptsEnabled: false,
          });
        return Promise.reject(new Error(`unexpected ${request.type}`));
      }),
    } as unknown as { request<T = unknown>(request: V1Request): Promise<T> };

    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: { currentPresetId: base.id, presets: [base] },
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
        renderPromptPreview: ({ revision }: { revision: string }) =>
          createElement(
            "div",
            { "aria-label": "嵌入的真实提示词预览" },
            `原页预览 ${revision}`,
          ),
      }),
    );

    expect(
      screen.getByLabelText<HTMLTextAreaElement>(
        "编辑提示内容 prompts/narrate.md",
      ).value,
    ).toContain("可见叙事");
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(
        "编辑提示内容 prompts/options.md",
      ).value,
    ).toContain("下一步建议");
    expect(screen.queryByText("提示块路径")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /界面扩展/u }));
    expect(screen.getByText("频道是什么？")).toBeTruthy();
    expect(screen.queryByLabelText("玩家视图面板 JSON")).toBeNull();
    expect(screen.queryByLabelText("扩展引用 JSON")).toBeNull();
    expect(
      screen.getByLabelText<HTMLSelectElement>("player_options 显示位置").value,
    ).toBe("composer_below");
    expect(screen.getByRole("list", { name: "界面扩展文件" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /提示内容/u }));
    expect(screen.getByText("frame.yaml 在这里做什么？")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(
        "编辑提示块内容 blocks/style.md",
      ).value,
    ).toContain("互动式小说");

    fireEvent.click(screen.getByRole("tab", { name: /高级文件/u }));
    const yamlGuide = screen.getByLabelText("三个核心 YAML 文件的用途");
    expect(yamlGuide.textContent).toContain("预设入口");
    expect(yamlGuide.textContent).toContain("调用链与产物");
    expect(yamlGuide.textContent).toContain("主持规则顺序");
    expect(
      screen.getByLabelText<HTMLSelectElement>("玩法预设文件", {
        exact: true,
      }).value,
    ).toBe("preset.yaml");

    fireEvent.click(screen.getByRole("tab", { name: /产物预览/u }));
    expect(screen.getByLabelText("嵌入的真实提示词预览").textContent).toBe(
      "原页预览 rev-readable",
    );
    expect(
      await screen.findByRole("heading", { name: "页面上的效果" }),
    ).toBeTruthy();
    expect(
      screen.getByText("技术细节：频道、处理规则与产物协议").closest("details")
        ?.open,
    ).toBe(false);
  });

  test("结构化编辑器可新增后置请求并通过 play.save 保存同一结构草稿", async () => {
    const structure: NonNullable<Preset["structure"]> = {
      name: "结构化玩法",
      callChainPath: "call-chain.yaml",
      mounts: [{ channel: "story.panel", mount: "story" }],
      playerViewPanels: [],
      extensionRefs: [],
      narrativePrompts: [
        { role: "author_instruction", path: "prompts/narrate.md" },
      ],
      followups: [],
    };
    const base: Preset = {
      id: "structured",
      name: "结构化玩法",
      revision: "rev-structured",
      files: {
        "preset.yaml": "format: narraeon.play-preset/v1",
        "call-chain.yaml": "format: narraeon.play-call-chain/v1",
      },
      validation: { status: "valid" },
      structure,
      enabled: true,
      scriptsEnabled: false,
    };
    const requests: V1Request[] = [];
    let current = base;
    const client = {
      request: vi.fn((request: V1Request) => {
        requests.push(request);
        if (request.type === "play.save") {
          current = {
            ...current,
            structure: request.structure as unknown as NonNullable<
              Preset["structure"]
            >,
          };
          return Promise.resolve({
            currentPresetId: current.id,
            preset: current,
          });
        }
        if (request.type === "play.read")
          return Promise.resolve({
            currentPresetId: current.id,
            presets: [current],
          });
        if (request.type === "play.workbench.read")
          return Promise.resolve({
            id: current.id,
            name: current.name,
            revision: current.revision,
            structure: current.structure ?? editorStructure,
            artifactPreviews: [],
            staticErrors: [],
            trustedLocalCode: false,
            scriptsEnabled: false,
          });
        return Promise.reject(new Error(`unexpected ${request.type}`));
      }),
    } as unknown as { request<T = unknown>(request: V1Request): Promise<T> };
    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: { currentPresetId: base.id, presets: [base] },
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "新增后置请求" }));
    expect(
      screen
        .getByRole("list", { name: "后置请求" })
        .querySelectorAll(":scope > .play-preset-followup-card"),
    ).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("后置请求 1 显示名"), {
      target: { value: "行动选项" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("玩法文件与结构化草稿已保存。");
    const save = requests.find((request) => request.type === "play.save");
    expect(save?.type).toBe("play.save");
    if (save?.type === "play.save") {
      expect(save.structure).toBeDefined();
      const followups = save.structure?.followups as { displayName: string }[];
      expect(followups).toHaveLength(1);
      expect(followups[0]?.displayName).toBe("行动选项");
    }
  });

  test("初始与切换选择会自动加载对应 workbench，并丢弃迟到的旧 revision", async () => {
    const first: Preset = {
      id: "first",
      name: "第一玩法",
      revision: "rev-first",
      files: { "preset.yaml": "first", "call-chain.yaml": "first" },
      validation: { status: "valid" },
      structure: editorStructure,
    };
    const second: Preset = {
      ...first,
      id: "second",
      name: "第二玩法",
      revision: "rev-second",
    };
    const pending = new Map<
      string,
      (snapshot: Record<string, unknown>) => void
    >();
    const requests: V1Request[] = [];
    const client = {
      request: vi.fn((request: V1Request) => {
        requests.push(request);
        if (request.type === "play.workbench.read")
          return new Promise<Record<string, unknown>>((resolve) => {
            pending.set(`${request.presetId}:${request.revision}`, resolve);
          });
        return Promise.reject(new Error(`unexpected ${request.type}`));
      }),
    } as unknown as { request<T = unknown>(request: V1Request): Promise<T> };
    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: {
          currentPresetId: first.id,
          presets: [first, second],
        },
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    await waitFor(() =>
      expect(requests).toContainEqual({
        type: "play.workbench.read",
        presetId: first.id,
        revision: first.revision,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /第二玩法/u }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        type: "play.workbench.read",
        presetId: second.id,
        revision: second.revision,
      }),
    );
    pending.get("first:rev-first")?.(
      workbenchSnapshot(first.id, first.revision, "旧预览"),
    );
    await Promise.resolve();
    expect(screen.queryByText("旧预览")).toBeNull();
    pending.get("second:rev-second")?.(
      workbenchSnapshot(second.id, second.revision, "第二玩法预览"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "工作台静态错误" }).textContent,
      ).toContain("第二玩法预览"),
    );
  });

  test("raw call chain 编辑不被旧结构静默覆盖，双向结构修改会明确阻止保存", async () => {
    const base: Preset = {
      id: "raw-edit",
      name: "raw 编辑",
      revision: "rev-raw",
      files: {
        "preset.yaml": "preset",
        "prompts/policy.md": "policy",
        "call-chain.yaml": "call chain",
      },
      validation: { status: "valid" },
      structure: editorStructure,
    };
    const requests: V1Request[] = [];
    let current = base;
    const client = {
      request: vi.fn((request: V1Request) => {
        requests.push(request);
        if (request.type === "play.workbench.read")
          return Promise.resolve(
            workbenchSnapshot(base.id, base.revision, "预览"),
          );
        if (request.type === "play.save") {
          current = {
            ...current,
            revision: "rev-raw-draft",
            files: request.files,
            structure: current.structure ?? editorStructure,
          };
          return Promise.resolve({
            currentPresetId: current.id,
            preset: current,
          });
        }
        if (request.type === "play.read")
          return Promise.resolve({
            currentPresetId: current.id,
            presets: [current],
          });
        return Promise.reject(new Error(`unexpected ${request.type}`));
      }),
    } as unknown as { request<T = unknown>(request: V1Request): Promise<T> };
    render(
      createElement(PlayPresetScreen, {
        client,
        initialLibrary: { currentPresetId: base.id, presets: [base] },
        onLibraryChange: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: /高级文件/u }));
    fireEvent.change(screen.getByLabelText("玩法预设文件", { exact: true }), {
      target: { value: "call-chain.yaml" },
    });
    fireEvent.change(screen.getByLabelText("编辑玩法文件 call-chain.yaml"), {
      target: { value: "raw call chain authored directly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await screen.findByText("玩法文件与结构化草稿已保存。");
    const rawSave = requests.find(
      (request): request is Extract<V1Request, { type: "play.save" }> =>
        request.type === "play.save",
    );
    expect(rawSave).toBeDefined();
    expect(rawSave).not.toHaveProperty("structure");

    fireEvent.click(screen.getByRole("tab", { name: /调用链/u }));
    fireEvent.change(screen.getByLabelText("后置请求 1 显示名"), {
      target: { value: "改过的显示名" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /高级文件/u }));
    fireEvent.change(screen.getByLabelText("玩法预设文件", { exact: true }), {
      target: { value: "call-chain.yaml" },
    });
    fireEvent.change(screen.getByLabelText("编辑玩法文件 call-chain.yaml"), {
      target: { value: "another raw call chain edit" },
    });
    expect(screen.getByText(/stale structure 覆盖 raw YAML/u)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "保存修改" }).getAttribute("disabled"),
    ).toBe("");
  });
});
