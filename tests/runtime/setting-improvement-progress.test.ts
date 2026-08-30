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
        // Capture the previous projection before each round, as concurrent polling would.
        seen.push(improvement.progress());
        if (round === 1) return assistant(validPlan(), [], 900, 40, 100, 50, 4);
        if (round === 2)
          return assistant(
            "Read the character first.",
            [readCall("r1", alexPath)],
            1200,
            60,
            200,
            50,
            6,
          );
        if (round === 3)
          return assistant(
            "Write the character back.",
            [
              {
                id: "w1",
                name: "setting_write_file",
                arguments: {
                  path: alexPath,
                  contents: "relationships:\n  Sam: familiar\n",
                },
              },
            ],
            1500,
            80,
            300,
            50,
            8,
          );
        if (round === 4)
          return assistant(
            "Check the candidate.",
            [previewCall("p1")],
            1700,
            20,
            400,
            50,
            2,
          );
        return assistant("Finish.", [finishCall("f1")], 1800, 10, 500, 50, 1);
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
  expect(afterPlan.usage).toMatchObject({
    inputTokens: 900,
    uncachedInputTokens: 750,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    reasoningTokens: 4,
    outputTokens: 40,
    totalTokens: 940,
  });

  // Candidate-phase usage is independent from planning-phase usage.
  const midWrite = seen.at(-2);
  expect(midWrite?.phase).toBe("generating");
  expect(midWrite?.writing).toBe(alexPath);
  expect(midWrite?.recentActions.at(-1)).toEqual({
    tool: "setting_write_file",
    target: alexPath,
    ok: true,
  });

  expect(final).toMatchObject({
    phase: "settled",
    round: 4,
    toolCalls: 4,
    repairs: 0,
    failedChecks: 0,
    writing: alexPath,
    failure: null,
    maxRounds: 64,
  });
  expect(final.usage).toMatchObject({
    inputTokens: 6200,
    uncachedInputTokens: 4600,
    cacheReadTokens: 1400,
    cacheWriteTokens: 200,
    reasoningTokens: 17,
    outputTokens: 170,
    totalTokens: 6370,
  });
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
          request.onDelta?.({
            kind: "reasoning",
            text: "Inspect relationships.",
          });
          request.onDelta?.({ kind: "text", text: "# Creation plan: Dorm" });
          midStream.push(improvement.progress());
          return assistant(validPlan());
        }
        request.onDelta?.({ kind: "tool", text: '{"path":"x"}' });
        midStream.push(improvement.progress());
        if (round === 2)
          return assistant("Check the candidate.", [previewCall("p1")]);
        return assistant("Finish.", [finishCall("f1")]);
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  await improvement.confirmPlan();

  const planStream = midStream[0]?.streaming;
  expect(planStream?.reasoningChars).toBe(22);
  expect(planStream?.textChars).toBe(21);
  // Tool arguments count as activity but do not enter the readable tail.
  expect(planStream?.tail).toContain("Inspect relationships.");
  expect(planStream?.tail).toContain("# Creation plan: Dorm");

  const toolStream = midStream[1]?.streaming;
  expect(toolStream?.toolChars).toBe(12);
  expect(toolStream?.tail).toBe("");

  // Clear streaming state at round end so old output is not shown as active.
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
        if (round === 2)
          return assistant("Check the candidate.", [previewCall("p1")]);
        return assistant("Finish.", [previewCall("p2"), finishCall("f1")]);
      },
    },
    preview: () => {
      throw new Error("Reference character.mia was not found");
    },
  });

  await improvement.start(planFirst());
  await expect(improvement.confirmPlan()).rejects.toThrow();
  const progress = improvement.progress();

  expect(progress.phase).toBe("settled");
  expect(progress.failedChecks).toBeGreaterThanOrEqual(2);
  expect(progress.lastCheck).toContain("Reference character.mia was not found");
});

test("候选中断后进度保留计数并给出失败原因", async () => {
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        return assistant("No tool call.");
      },
    },
    preview: previewSnapshot,
  });

  // In direct-candidate mode, nine plain-text rounds exceed the repair limit.
  await expect(
    improvement.start({
      goal: "Improve relationships in the dorm world",
      contextPaths: [],
      mode: "direct_candidate",
    }),
  ).rejects.toThrow(/candidate phase exceeded its repair limit/u);
  const progress = improvement.progress();

  expect(progress).toMatchObject({
    phase: "settled",
    repairs: 9,
    toolCalls: 0,
  });
  expect(progress.failure).toContain(
    "candidate phase exceeded its repair limit",
  );
  expect(progress.round).toBe(9);
});

const alexPath = "world/characters/alex.yaml";

function assistant(
  content: string,
  toolCalls: SettingAuthorToolCall[] = [],
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  reasoningTokens = 0,
): AuthorResponse {
  const uncachedInputTokens = Math.max(
    0,
    inputTokens - cacheReadTokens - cacheWriteTokens,
  );
  return {
    role: "assistant",
    content,
    toolCalls,
    usage: {
      inputTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      provenance: {
        inputTokens: "provider",
        uncachedInputTokens: "derived_provider_fields",
        cacheReadTokens: "provider",
        cacheWriteTokens: "provider",
        reasoningTokens: "provider",
        outputTokens: "provider",
        totalTokens: "provider",
      },
    },
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
    goal: "Improve relationships in the dorm world",
    contextPaths: [],
    mode: "plan_first" as const,
  };
}

function validPlan(): string {
  return "# Creation plan: Dorm world\n\nPreserve existing characters, the current situation, and player agency. Add only observable relationship behavior and an opening hook, then run the complete candidate check before applying.";
}

function baseFiles() {
  return [
    {
      path: "opening.md",
      contents: "宿舍门在你面前合上。Alex抱着球衣，等你先开口。\n",
    },
    {
      path: alexPath,
      contents: `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: 篮球队前锋的当前状态与关系。\n  aliases: []\n关系: {}\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: 当前情境\n  summary: 宿舍中正在发生的局面。\n  aliases: []\n人物:\n  - $ref: character.alex\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World Narration Rules\n\nWrite durable outcomes back to their natural owner.\n",
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
    playerInput: "Preview the setting candidate.",
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
}
