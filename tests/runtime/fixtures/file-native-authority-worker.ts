import { createHash } from "node:crypto";

import { FileNativeWorldStore } from "../../../src/runtime/world/FileNativeWorldStore.ts";

const [, , root, edge = "none", mode = "commit"] = process.argv;
if (root === undefined) throw new Error("Missing data directory");
const store = new FileNativeWorldStore(root);
const before = `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`;
const after = before.replace("安静", "已经提交");
const created = await store.createFromContentPackage({
  operationId: "create",
  sourcePackageId: "package",
  sourcePackageTitle: "Test content package",
  packageFiles: [
    {
      path: "opening.md",
      contents:
        "The room falls quiet, leaving the present situation for your response.\n",
    },
    { path: "world/current-situation.yaml", contents: before },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    { path: "control/blocks/world.md", contents: "# World Rules\n" },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ],
  prompt: {
    hostBinding: {
      hostPresetId: "host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - markdown: blocks/style.md\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
        "blocks/style.md": "# Style\n",
      },
    },
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  },
});
if (edge !== "none")
  process.env.NARRAEON_INTERNAL_TEST_CRASH_AT_FILE_NATIVE_AUTHORITY_EDGE = edge;
if (mode === "derive") {
  await store.repairMaterialization(created.world.worldId);
  await store.deriveWorld({
    operationId: "derive",
    sourceWorldId: created.world.worldId,
    sourceHead: "commit:1",
    hostPresetId: "host",
  });
} else {
  const outcome = await store.commitPlayStep({
    operationId: "play",
    worldId: created.world.worldId,
    parentHead: "genesis",
    historyAppend: [
      { role: "player", exactText: "Player" },
      { role: "narrator", exactText: "Narrator" },
    ],
    nextMaterials: [],
    stateChanges: [
      {
        kind: "replace",
        documentId: "situation.current",
        stableShortRef: "current-situation",
        relativePath: "current-situation.yaml",
        codec: "yaml",
        expectedPreviousHash: hash(before),
        nextHash: hash(after),
        canonicalNextBytes: after,
      },
    ],
  });
  if (outcome.outcome === "committed_materialization_pending")
    await store.repairMaterialization(created.world.worldId);
}

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
