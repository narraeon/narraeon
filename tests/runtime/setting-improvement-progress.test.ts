import { expect, test } from "vitest";

import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  DocumentCandidateSettingImprovement,
  type SettingAuthorAdapter,
  type SettingAuthorToolCall,
} from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";
import type { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

type AuthorResponse = Awaited<ReturnType<SettingAuthorAdapter["next"]>>;

test("候选进行中可以读到轮次、工具调用、token 与当前写入路径", async () => {
  const seen: ReturnType<DocumentCandidateSettingImprovement["progress"]>[] =
    [];
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        round += 1;
        // 每一轮开始前记下上一轮结束时的投影，模拟并发轮询看到的中间状态。
        seen.push(improvement.progress());
        if (round === 1) return assistant(validPlan(), [], 900, 40);
        if (round === 2)
          return assistant(
            "先读人物。",
            [readCall("r1", qinlongPath)],
            1200,
            60,
          );
        if (round === 3)
          return assistant(
            "写回人物。",
            [
              {
                id: "w1",
                name: "setting_write_file",
                arguments: {
                  path: qinlongPath,
                  contents: "关系:\n  启铭: 熟悉\n",
                },
              },
            ],
            1500,
            80,
          );
        if (round === 4)
          return assistant("自检。", [previewCall("p1")], 1700, 20);
        return assistant("结束。", [finishCall("f1")], 1800, 10);
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  const afterPlan = improvement.progress();
  await improvement.confirmPlan();
  const final = improvement.progress();

  expect(afterPlan).toMatchObject({
    phase: "settled",
    round: 1,
    failure: null,
  });
  expect(afterPlan.usage).toEqual({ inputTokens: 900, outputTokens: 40 });

  // 候选阶段是独立计数，不叠加计划阶段的用量。
  const midWrite = seen.at(-2);
  expect(midWrite?.phase).toBe("generating");
  expect(midWrite?.writing).toBe(qinlongPath);
  expect(midWrite?.recentActions.at(-1)).toEqual({
    tool: "setting_write_file",
    target: qinlongPath,
    ok: true,
  });

  expect(final).toMatchObject({
    phase: "settled",
    round: 4,
    toolCalls: 4,
    repairs: 0,
    failedChecks: 0,
    writing: qinlongPath,
    failure: null,
    maxRounds: 64,
  });
  expect(final.usage).toEqual({ inputTokens: 6200, outputTokens: 170 });
  expect(final.updatedAt).toBeGreaterThan(0);
});

test("流式增量在一轮结束前就可见，轮次结束后清空", async () => {
  const midStream: (ReturnType<
    DocumentCandidateSettingImprovement["progress"]
  > | null)[] = [];
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1) {
          request.onDelta?.({ kind: "reasoning", text: "先看看现有关系。" });
          request.onDelta?.({ kind: "text", text: "# 创作计划：宿舍篇" });
          midStream.push(improvement.progress());
          return assistant(validPlan());
        }
        request.onDelta?.({ kind: "tool", text: '{"path":"x"}' });
        midStream.push(improvement.progress());
        if (round === 2) return assistant("自检。", [previewCall("p1")]);
        return assistant("结束。", [finishCall("f1")]);
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  await improvement.confirmPlan();

  const planStream = midStream[0]?.streaming;
  expect(planStream?.reasoningChars).toBe(8);
  expect(planStream?.textChars).toBe(10);
  // 工具参数计入活跃度但不进入可读尾巴。
  expect(planStream?.tail).toContain("先看看现有关系。");
  expect(planStream?.tail).toContain("# 创作计划：宿舍篇");

  const toolStream = midStream[1]?.streaming;
  expect(toolStream?.toolChars).toBe(12);
  expect(toolStream?.tail).toBe("");

  // 一轮结束即清空，避免把上一轮的输出误读成当前仍在进行。
  expect(improvement.progress().streaming).toBeNull();
});

test("自检未通过会记入 failedChecks 并留下最近一条诊断", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        round += 1;
        if (round === 1) return assistant(validPlan());
        if (round === 2) return assistant("自检。", [previewCall("p1")]);
        return assistant("结束。", [previewCall("p2"), finishCall("f1")]);
      },
    },
    preview: () => {
      throw new Error("引用 character.awu 未找到");
    },
  });

  await improvement.start(planFirst());
  await expect(improvement.confirmPlan()).rejects.toThrow();
  const progress = improvement.progress();

  expect(progress.phase).toBe("settled");
  expect(progress.failedChecks).toBeGreaterThanOrEqual(2);
  expect(progress.lastCheck).toContain("引用 character.awu 未找到");
});

test("候选中断后进度保留计数并给出失败原因", async () => {
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        return assistant("没有任何工具调用。");
      },
    },
    preview: previewSnapshot,
  });

  // 直接候选模式：每轮纯文本都是协议错误，第 9 次触发上限。
  await expect(
    improvement.start({
      goal: "完善宿舍世界的人物关系",
      contextPaths: [],
      mode: "direct_candidate",
    }),
  ).rejects.toThrow(/可修复错误上限/u);
  const progress = improvement.progress();

  expect(progress).toMatchObject({
    phase: "settled",
    repairs: 9,
    toolCalls: 0,
  });
  expect(progress.failure).toContain("可修复错误上限");
  expect(progress.round).toBe(9);
});

const qinlongPath = "world/characters/qinlong.yaml";

function assistant(
  content: string,
  toolCalls: SettingAuthorToolCall[] = [],
  inputTokens = 0,
  outputTokens = 0,
): AuthorResponse {
  return {
    role: "assistant",
    content,
    toolCalls,
    usage: { inputTokens, outputTokens },
  };
}

function readCall(id: string, path: string): SettingAuthorToolCall {
  return { id, name: "setting_read", arguments: { path } };
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
      path: qinlongPath,
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
      history: {
        "candidate.message.genesis.narrator":
          snapshot.files.find(({ path }) => path === "opening.md")?.contents ??
          "",
      },
      additionalMaterials: [
        {
          kind: "history_message",
          message: "candidate.message.genesis.narrator",
        },
      ],
    },
    playerInputPlacement: "bootstrap",
    playerInput: "预览设定候选。",
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
}
