import { expect, test } from "vitest";

import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  DocumentCandidateSettingImprovement,
  type SettingAuthorAdapter,
  type SettingAuthorToolCall,
} from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";
import type { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

type AuthorResponse = Awaited<ReturnType<SettingAuthorAdapter["next"]>>;

test("计划可以按反馈重出，历史保留在同一会话里", async () => {
  const requests: string[][] = [];
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(request.messages.map(({ content }) => content));
        round += 1;
        return assistant(
          round === 1
            ? validPlan()
            : `${validPlan()}\n\n第二版：改为聚焦社团线。`,
        );
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  const revised = await improvement.revisePlan("方向偏了，改成聚焦社团线。");

  expect(revised.markdown).toContain("第二版");
  expect(requests).toHaveLength(2);
  const second = (requests[1] ?? []).join("\n");
  // 反馈与首版计划都在，同一条会话继续往下走。
  expect(second).toContain("方向偏了，改成聚焦社团线。");
  expect(second).toContain("# 创作计划：宿舍篇");
  expect((requests[1] ?? []).length).toBeGreaterThan(
    (requests[0] ?? []).length,
  );
});

test("候选修改从上一次候选继续，已落地的改动仍在", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1) return assistant(validPlan());
        if (round === 2)
          return assistant("先建人物。", [
            write("w1", "world/characters/awu.yaml", "awu", "阿雾", "在场"),
            previewCall("p1"),
          ]);
        if (round === 3) return assistant("结束。", [finishCall("f1")]);
        if (round === 4) {
          // 修改请求必须把现有候选交回来继续。
          expect(request.messages.at(-1)?.content).toContain(
            "当前候选就是上一次生成结束时的状态",
          );
          return assistant("再建一个人物。", [
            write(
              "w2",
              "world/characters/leigang.yaml",
              "leigang",
              "雷刚",
              "在场",
            ),
            previewCall("p2"),
          ]);
        }
        return assistant("结束。", [finishCall("f2")]);
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  await improvement.confirmPlan();
  const revised = await improvement.reviseCandidate("再加一个室友。");

  const paths = revised.files.map(({ path }) => path);
  expect(paths).toContain("world/characters/awu.yaml");
  expect(paths).toContain("world/characters/leigang.yaml");
  // 两次改动都出现在同一份 diff 里，而不是第二次把第一次冲掉。
  expect(revised.review.diff.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      "world/characters/awu.yaml",
      "world/characters/leigang.yaml",
    ]),
  );
});

test("修改失败后回到可修改状态，候选没有被破坏", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        round += 1;
        if (round === 1) return assistant(validPlan());
        if (round === 2)
          return assistant("建人物。", [
            write("w1", "world/characters/awu.yaml", "awu", "阿雾", "在场"),
            previewCall("p1"),
          ]);
        if (round === 3) return assistant("结束。", [finishCall("f1")]);
        throw new Error("provider unavailable");
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  const before = await improvement.confirmPlan();
  await expect(improvement.reviseCandidate("再改改")).rejects.toThrow(
    "provider unavailable",
  );

  // 仍可继续修改或直接应用，之前的候选原样保留。
  expect(improvement.progress().phase).toBe("settled");
  await improvement.apply((files) => {
    expect(files.map(({ path }) => path)).toEqual(
      before.files.map(({ path }) => path),
    );
  });
});

test.each([
  ["空白反馈", "   "],
  ["空字符串", ""],
])("拒绝%s", async (_, feedback) => {
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        return assistant(validPlan());
      },
    },
    preview: previewSnapshot,
  });
  await improvement.start(planFirst());

  await expect(improvement.revisePlan(feedback)).rejects.toThrow(
    "修改意见不能为空",
  );
});

test("没有计划或候选时不能修改", async () => {
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        return assistant(validPlan());
      },
    },
    preview: previewSnapshot,
  });

  await expect(improvement.revisePlan("改一下")).rejects.toThrow(
    "没有可修改的创作计划",
  );
  await improvement.start(planFirst());
  await expect(improvement.reviseCandidate("改一下")).rejects.toThrow(
    "没有可修改的候选",
  );
});

function write(
  id: string,
  path: string,
  ref: string,
  title: string,
  state: string,
): SettingAuthorToolCall {
  return {
    id,
    name: "setting_write_file",
    arguments: {
      path,
      contents: `$document:\n  id: x\n  ref: ${ref}\n  title: ${title}\n  summary: ${title}的自然语言设定。\n  aliases: []\n状态: ${state}\n`,
    },
  };
}

function assistant(
  content: string,
  toolCalls: SettingAuthorToolCall[] = [],
): AuthorResponse {
  return { role: "assistant", content, toolCalls };
}

function previewCall(id: string): SettingAuthorToolCall {
  return { id, name: "setting_preview_candidate", arguments: {} };
}

function finishCall(id: string): SettingAuthorToolCall {
  return { id, name: "setting_finish_candidate", arguments: {} };
}

function planFirst() {
  return {
    goal: "完善宿舍世界的人物关系",
    contextPaths: [],
    mode: "plan_first" as const,
  };
}

function validPlan(): string {
  return "# 创作计划：宿舍篇\n\n保留已有人物、当前情境和玩家行动权，只补充关系的可观察表现与开局钩子，并在应用前通过完整候选自检。";
}

function baseFiles() {
  return [
    {
      path: "opening.md",
      contents: "宿舍门在你面前合上。秦龙抱着球衣，等你先开口。\n",
    },
    {
      path: "world/characters/qinlong.yaml",
      contents: `$document:\n  id: character.qinlong\n  ref: qinlong\n  title: 秦龙\n  summary: 篮球队前锋的当前状态与关系。\n  aliases: []\n关系: {}\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: 当前情境\n  summary: 宿舍中正在发生的局面。\n  aliases: []\n人物:\n  - $ref: character.qinlong\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents: "# 世界主持规则\n\n持续结果写回自然所有者。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1\nviews: []\n`,
    },
  ];
}

function previewSnapshot(snapshot: WorldDocumentStore) {
  return new FileNativePromptCompiler().preview({
    endpoint: { id: "candidate", commit: "candidate" },
    hostBinding: {
      hostPresetId: "host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
      },
    },
    world: {
      controlFingerprint: "candidate",
      documentSnapshot: snapshot,
      history: { "candidate.message.genesis.narrator": "宿舍门在你面前合上。" },
      additionalMaterials: [
        {
          kind: "history_message",
          message: "candidate.message.genesis.narrator",
        },
      ],
    },
    playerInputPlacement: "bootstrap",
    playerInput: "预览",
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
}
