// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { V1Request } from "../../src/protocol/v1.ts";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import { type PlayPresetPromptRole } from "../../src/shared/play-preset-prompt-roles.ts";
import { PlayPresetScreen } from "../../src/web/PlayPresetScreen.tsx";

interface Preset {
  id: string;
  name: string;
  revision: string;
  files: Record<string, string>;
  validation: { status: "valid" };
  enabled?: boolean;
  scriptsEnabled?: boolean;
  structure?: {
    name: string;
    callChainPath: string;
    mounts: { channel: string; mount: "story" | "sidebar" | "debug" }[];
    playerViewPanels: Record<string, unknown>[];
    extensionRefs: string[];
    narrativePrompts: { role: PlayPresetPromptRole; path: string }[];
    followups: {
      id: string;
      displayName: string;
      prompt: { role: PlayPresetPromptRole; path: string };
      artifacts: { name: string }[];
      maxArtifactBytes: number;
    }[];
  };
}

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
      artifacts: [{ name: "player_options" }],
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

  test("以工作区导航收纳流程、文件和管理，并可撤销未保存修改", async () => {
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

    fireEvent.click(screen.getByRole("tab", { name: /预设文件/u }));
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

    fireEvent.click(screen.getByRole("tab", { name: /管理/u }));
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
            structure: request.structure as NonNullable<Preset["structure"]>,
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
      within(screen.getByRole("list", { name: "后置请求" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("后置请求 1 显示名"), {
      target: { value: "行动选项" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "保存结构化/文件草稿" }),
    );
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
    fireEvent.click(screen.getByRole("tab", { name: /预设文件/u }));
    fireEvent.change(screen.getByLabelText("玩法预设文件", { exact: true }), {
      target: { value: "call-chain.yaml" },
    });
    fireEvent.change(screen.getByLabelText("编辑玩法文件 call-chain.yaml"), {
      target: { value: "raw call chain authored directly" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "保存结构化/文件草稿" }),
    );
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
    fireEvent.click(screen.getByRole("tab", { name: /预设文件/u }));
    fireEvent.change(screen.getByLabelText("玩法预设文件", { exact: true }), {
      target: { value: "call-chain.yaml" },
    });
    fireEvent.change(screen.getByLabelText("编辑玩法文件 call-chain.yaml"), {
      target: { value: "another raw call chain edit" },
    });
    expect(screen.getByText(/stale structure 覆盖 raw YAML/u)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "保存结构化/文件草稿" })
        .getAttribute("disabled"),
    ).toBe("");
  });
});
