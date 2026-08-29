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
            : `${validPlan()}\n\nSecond version: focus on the club storyline.`,
        );
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  const revised = await improvement.revisePlan(
    "Change direction and focus on the club storyline.",
  );

  expect(revised.markdown).toContain("Second version");
  expect(requests).toHaveLength(2);
  const second = (requests[1] ?? []).join("\n");
  // Feedback and the first plan remain in the same continuing session.
  expect(second).toContain("Change direction and focus on the club storyline.");
  expect(second).toContain("# Creation plan: Dorm world");
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
          return assistant("Create a character first.", [
            write("w1", "world/characters/mia.yaml", "mia", "Mia", "present"),
            previewCall("p1"),
          ]);
        if (round === 3) return assistant("Finish.", [finishCall("f1")]);
        if (round === 4) {
          // Revision continues from the existing candidate instead of rebuilding it.
          expect(request.messages.at(-1)?.content).toContain(
            "The current candidate is exactly the state from the end of the previous generation",
          );
          return assistant("Create another character.", [
            write(
              "w2",
              "world/characters/casey.yaml",
              "casey",
              "Casey",
              "present",
            ),
            previewCall("p2"),
          ]);
        }
        return assistant("Finish.", [finishCall("f2")]);
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  await improvement.confirmPlan();
  const revised = await improvement.reviseCandidate("Add another roommate.");

  const paths = revised.files.map(({ path }) => path);
  expect(paths).toContain("world/characters/mia.yaml");
  expect(paths).toContain("world/characters/casey.yaml");
  // Both edits remain in one diff; the second does not replace the first.
  expect(revised.review.diff.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      "world/characters/mia.yaml",
      "world/characters/casey.yaml",
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
          return assistant("Create a character.", [
            write("w1", "world/characters/mia.yaml", "mia", "Mia", "present"),
            previewCall("p1"),
          ]);
        if (round === 3) return assistant("Finish.", [finishCall("f1")]);
        throw new Error("provider unavailable");
      },
    },
    preview: previewSnapshot,
  });

  await improvement.start(planFirst());
  const before = await improvement.confirmPlan();
  await expect(improvement.reviseCandidate("Revise again.")).rejects.toThrow(
    "provider unavailable",
  );

  // The previous candidate remains available for another revision or apply.
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
    "Revision feedback cannot be empty",
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

  await expect(improvement.revisePlan("Revise it.")).rejects.toThrow(
    "There is no creation plan to revise",
  );
  await improvement.start(planFirst());
  await expect(improvement.reviseCandidate("Revise it.")).rejects.toThrow(
    "There is no candidate to revise",
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
      contents: `$document:\n  id: x\n  ref: ${ref}\n  title: ${title}\n  summary: A natural-language setting for ${title}.\n  aliases: []\nstatus: ${state}\n`,
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
      contents:
        "The dormitory door closes in front of you. Alex holds a jersey and waits.\n",
    },
    {
      path: "world/characters/alex.yaml",
      contents: `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: The basketball forward's current state and relationships.\n  aliases: []\nrelationships: {}\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: Current situation\n  summary: The situation unfolding in the dormitory.\n  aliases: []\ncharacters:\n  - $ref: character.alex\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World hosting rules\n\nWrite durable results back to their natural owners.\n",
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
          "The dormitory door closes in front of you.",
      },
      additionalMaterials: [
        {
          kind: "history_message",
          message: "candidate.message.genesis.narrator",
        },
      ],
    },
    playerInputPlacement: "bootstrap",
    playerInput: "Preview",
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
}
