import { rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  presetHostBinding,
  validatePlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { defaultPresetHostFiles } from "../../src/shared/default-preset-host.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import { defaultNarrationPrompt } from "../../src/shared/default-play-prompts.ts";
import { firstPartyGenericPanelsPresetFiles } from "../../src/shared/first-party-generic-panels.ts";
import { firstPartyStatusPanelPresetFiles } from "../../src/shared/first-party-player-view.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("默认提示词职责", () => {
  test("默认与第一方玩法模板逐字共用调用链叙事语义", () => {
    const presets = [
      defaultPlayPresetFiles,
      firstPartyActionChoicesPresetFiles,
      firstPartyStatusPanelPresetFiles,
      firstPartyGenericPanelsPresetFiles,
    ];

    for (const files of presets) {
      expect(files["prompts/narrate.md"]).toBe(defaultNarrationPrompt);
      expect(files).not.toHaveProperty("prompts/policy.md");
      expect(files["call-chain.yaml"]).not.toContain("prompts/policy.md");
    }

    expect(defaultNarrationPrompt).toContain("已经确定的结果同样不能改");
    // 只写进文档的变化玩家读不到；叙事必须把它演出来，不只是不改写它。
    expect(defaultNarrationPrompt).toContain("这一段必须演出来");
    expect(defaultNarrationPrompt).toContain("对他等于没有发生");
    expect(defaultNarrationPrompt).toContain("后续模型请求读得到它们");
    expect(defaultNarrationPrompt).toContain("当你决定输出玩家可见故事正文时");
    // 玩家可见叙事写的是小说正文，不是逐项交代的过程报告。
    expect(defaultNarrationPrompt).toContain("互动式小说的正文，不是过程报告");
    expect(defaultNarrationPrompt).toContain("可以分多个自然段");
    expect(defaultNarrationPrompt).not.toContain("篇幅只覆盖");
    // 结尾必须是一个具体事件。"他们在等你"这类状态描写是主持人腔换了层皮，
    // 禁字面问句挡不住它，所以要连同这种功能一起点名禁掉。
    expect(defaultNarrationPrompt).toContain(
      "最后一句写某个人做的一件具体的事",
    );
    expect(defaultNarrationPrompt).toContain("沉默不是事件");
    expect(defaultNarrationPrompt).toContain("两道视线落回你身上");
    expect(defaultNarrationPrompt).toContain("穿了小说的皮");
    expect(defaultNarrationPrompt).not.toContain("有人正等着他表态");
    // 玩家代理权只约束关键决定，合法的连带动作仍可正常演出。
    expect(defaultNarrationPrompt).toContain("本该由他决定");
    expect(defaultNarrationPrompt).toContain("不算替玩家决定");
    expect(defaultNarrationPrompt).not.toContain("第二人称");
    expect(
      firstPartyActionChoicesPresetFiles["prompts/options.md"],
    ).not.toContain("artifact_emit");
    expect(
      firstPartyGenericPanelsPresetFiles["prompts/panels.md"],
    ).not.toContain("artifact_emit");
  });

  test("主持层承担通用状态判据，世界 scaffold 只承担世界特有语义", () => {
    const style = defaultPresetHostFiles["blocks/style.md"]!;
    const agency = defaultPresetHostFiles["blocks/adjudication.md"]!;
    const state = defaultPresetHostFiles["blocks/state.md"]!;
    const frame = defaultPresetHostFiles["frame.yaml"]!;

    expect(style).toContain("玩家可见叙事以第二人称“你”");
    expect(style).not.toContain("世界提示框架明确规定");
    expect(style).not.toContain("篇幅只覆盖");
    expect(style).not.toContain("Runtime");
    // 文体定位跨世界恒真，归主持层。
    expect(style).toContain("这是一部互动式小说");
    expect(style).toContain("先接住玩家的输入");
    expect(style).toContain("写出小说的质感");
    // 放开篇幅的同时守住"丰富不等于注水"这条线。
    expect(style).toContain("不是把已知背景再说一遍");
    // 逐个交代在场的人是清单换了标点，不是描写。
    expect(style).toContain("不要点名式并列");
    expect(style).toContain("已经知道名字的人就叫名字");
    expect(agency).toContain("只能来自玩家当前输入的明确表达");
    expect(agency).not.toContain("一旦局面再次需要玩家选择");
    // 代理权按"是否关键决策"划线，而不是按"是否玩家角色的动作"。
    expect(agency).toContain("哪些可以替玩家演");
    expect(agency).not.toContain("看似顺手的后续动作");
    // NPC 不是只对玩家行动作出反应的装置。
    expect(agency).toContain("NPC 有自己的生活");
    expect(agency).not.toContain("针对已实施行动作出的反应");
    // NPC 推进职责由主持层承担：
    // 在场的人自主行动会产生要保存的结果，不在场的人也不会被冻结。
    expect(agency).toContain("和玩家行动产生的结果是同一种东西");
    expect(agency).toContain("不在场的人也在往前走");
    expect(agency).toContain("不说明别人按了暂停");
    expect(agency).toContain("不必每次行动都把所有人跑一遍");
    expect(state).toContain("先取材，再裁决");
    expect(state).toContain("即使目录里已经看到了对应条目");
    expect(state).toContain("允许当前调用链没有任何文档变化");
    expect(state).toContain("失败经历本身");
    expect(state).toContain("已经作出的承诺本身可以保存");
    expect(state).toContain("保存到哪里");
    expect(state).toContain("当前情境的收敛");
    // 世界文档对玩家不可见：能感知到的变化必须同时落在叙事里。
    expect(state).toContain("玩家只能读到叙事");
    expect(state).toContain("只留在文档里等于对玩家没有发生");
    expect(state).toContain("两边讲的是同一件事");
    // NPC 自主行动与场外推进同样要过保存检验。
    expect(state).toContain("不只是玩家动作的直接后果");
    // 离场不等于这个人的进行中事项可以随当前情境一起丢掉。
    expect(state).toContain("这里删掉的是这个场面里的他，不是这个人");
    expect(state).not.toMatch(/人物文档|地点文档|物品文档/u);
    expect(frame.indexOf("blocks/style.md")).toBeLessThan(
      frame.indexOf("blocks/adjudication.md"),
    );
    expect(frame.indexOf("blocks/adjudication.md")).toBeLessThan(
      frame.indexOf("blocks/state.md"),
    );
    expect(frame.indexOf("blocks/state.md")).toBeLessThan(
      frame.indexOf("world.instructions"),
    );

    // 出厂样板会被设定完善的 AI 当作文风示范照抄，所以它自己不能是主持人腔。
    const opening = minimalFileNativeContentScaffold().find(
      ({ path }) => path === "opening.md",
    )?.contents;
    expect(opening).not.toMatch(/你准备怎么做|你打算怎么做|你可以选择/u);

    const world = minimalFileNativeContentScaffold().find(
      ({ path }) => path === "control/blocks/world.md",
    )?.contents;
    expect(world).toContain("本文件只写这个世界特有的规则");
    expect(world).toContain("本世界的文档与保存位置");
    expect(world).toContain("专属规则");
    expect(world).not.toContain("如果下一次行动开始时忽略它");
    expect(
      inspectContentPackageCurrentTree(minimalFileNativeContentScaffold())
        .status,
    ).toBe("usable");
  });

  test("后置请求携带自己的 Runtime 契约，主链只拿到读写工具", () => {
    const files = structuredClone(firstPartyActionChoicesPresetFiles);
    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind !== "valid") throw parsed.error;
    const binding = {
      id: "first-party-action-choices",
      name: "action-choices-recommended",
      revision: "v1",
      definition: parsed.definition,
      files,
      scriptsEnabled: true,
    };
    const preview = new FileNativePromptCompiler().previewPlayPreset(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "prompt-contract-test",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
        playerInput: "我试着推开门。",
        playerInputPlacement: "append",
      }),
      binding,
    );

    const followups = preview.playPreset!.followups;
    expect(followups.map(({ id }) => id)).toEqual(["player_options"]);
    const contract = followups[0]!.logicalMessages[0]!.markdown;
    // 后置请求要说明它已在提交之后、只发一次、只能发产物。
    expect(contract).toContain("核心叙事与世界状态已经提交");
    expect(contract).toContain("它只发出一次，没有后续往返");
    expect(contract).toContain("output=player_options");
    expect(contract).toContain("channel=player.options");
    expect(followups[0]!.allowedTools).toEqual([
      "artifact_emit",
      "artifact_clear",
    ]);
  });
});

describe("提示块启用清单", () => {
  test("frame.yaml 决定哪些块进入模型，未列出的块留在树里", () => {
    const withExtraStyle: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "blocks/style-noir.md": "# 冷硬派\n\n短句，不解释。\n",
    };

    // 未被 frame 引用的块：文件有效，但不进提示词。
    expect(validatePlayPresetFiles(withExtraStyle)).toEqual({
      status: "valid",
    });
    expect(authorBlockSources(withExtraStyle)).not.toContain(
      "host:blocks/style-noir.md",
    );

    // 列进 frame 就生效，而且可以和原文风块同时启用——不做互斥限制。
    const bothEnabled: Record<string, string> = {
      ...withExtraStyle,
      "frame.yaml": withExtraStyle["frame.yaml"]!.replace(
        "    - markdown: blocks/style.md\n",
        "    - markdown: blocks/style.md\n    - markdown: blocks/style-noir.md\n",
      ),
    };
    expect(authorBlockSources(bothEnabled)).toEqual([
      "host:blocks/style.md",
      "host:blocks/style-noir.md",
      "host:blocks/adjudication.md",
      "host:blocks/state.md",
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);

    // 从 frame 里移走一块：正文消失，文件仍在预设里。
    const disabled: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "frame.yaml": defaultPlayPresetFiles["frame.yaml"]!.replace(
        "    - markdown: blocks/adjudication.md\n",
        "",
      ),
    };
    expect(authorBlockSources(disabled)).not.toContain(
      "host:blocks/adjudication.md",
    );
    expect(disabled["blocks/adjudication.md"]).toContain("NPC 有自己的生活");
  });
});

function authorBlockSources(files: Record<string, string>): string[] {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  const binding = {
    id: "enable-list-preset",
    name: parsed.definition.name,
    revision: "rev-enable-list",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "enable-list-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    playerInput: "我推门进去。",
    playerInputPlacement: "append",
  });
  input.hostBinding = presetHostBinding(binding);
  return (
    new FileNativePromptCompiler()
      .compilePlayCallChain(input, binding)
      .bootstrap.logicalMessages.find(
        ({ role }) => role === "author_instruction",
      )
      ?.blocks.map(({ source }) => source) ?? []
  );
}

describe("文风块库", () => {
  test("通用块讲变速，六种文风预置在库里但默认不启用", () => {
    const style = defaultPresetHostFiles["blocks/style.md"]!;
    // 之前只有防注水的约束，没有一句说该详的地方要详。
    expect(style).toContain("该慢的地方要慢下来");
    expect(style).toContain("一个抬手的动作可以写三行");
    expect(style).toContain("注水是把同一件事换个说法再说一遍");
    // 玩家自己的身体经验可以直接写，不必绕成侧写。
    expect(style).toContain("玩家角色自己的身体经验是可以直接写的");
    expect(defaultNarrationPrompt).toContain("篇幅由这一刻的分量决定");

    const styles = Object.keys(defaultPresetHostFiles)
      .filter((path) => path.startsWith("blocks/style-"))
      .sort();
    expect(styles).toEqual([
      "blocks/style-action.md",
      "blocks/style-horror.md",
      "blocks/style-intimate.md",
      "blocks/style-literary.md",
      "blocks/style-noir.md",
      "blocks/style-wuxia.md",
    ]);

    // 预置≠启用：frame.yaml 只列通用块，其余留在库里等作者挑。
    const frame = defaultPresetHostFiles["frame.yaml"]!;
    expect(frame).toContain("markdown: blocks/style.md");
    for (const path of styles) expect(frame).not.toContain(path);
    expect(authorBlockSources(defaultPlayPresetFiles)).toEqual([
      "host:blocks/style.md",
      "host:blocks/adjudication.md",
      "host:blocks/state.md",
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);
  });

  test("情感文风要求把动作拆开并让触觉打头，且可以和别的文风叠加", () => {
    const intimate = defaultPresetHostFiles["blocks/style-intimate.md"]!;
    expect(intimate).toContain("不要跳过过程直接给结论");
    expect(intimate).toContain("触觉优先");
    expect(intimate).toContain("一个动作可以占三四行");
    // 落俗的现成比喻要落回具体位置，而不是替代描写。
    expect(intimate).toContain("它替代了描写而不是完成描写");
    // 亲密戏不能绕过玩家代理权，也不能因为气氛就让 NPC 答应。
    expect(intimate).toContain("不要因为气氛到了就让他答应");

    const stacked: Record<string, string> = {
      ...defaultPlayPresetFiles,
      "frame.yaml": defaultPresetHostFiles["frame.yaml"]!.replace(
        "    - markdown: blocks/style.md\n",
        "    - markdown: blocks/style.md\n    - markdown: blocks/style-intimate.md\n    - markdown: blocks/style-wuxia.md\n",
      ),
    };
    expect(authorBlockSources(stacked)).toEqual([
      "host:blocks/style.md",
      "host:blocks/style-intimate.md",
      "host:blocks/style-wuxia.md",
      "host:blocks/adjudication.md",
      "host:blocks/state.md",
      "world:control/blocks/world-style.md",
      "play:prompts/narrate.md",
    ]);
  });
});
