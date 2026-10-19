import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { WorldArchives } from "../../src/runtime/archive/WorldArchives.ts";
import {
  ScriptedModelHost,
  type ModelHostBinding,
} from "../../src/runtime/model/ModelHost.ts";
import type { ContentTreeFile } from "../../src/protocol/v1.ts";

export const archiveModelBinding: ModelHostBinding = {
  provider: "chat_completions",
  endpointFingerprint: "archive-source",
  modelId: "archive-test",
  contextWindowTokens: 1000000,
  maxOutputTokens: 8192,
  protocolConfigFingerprint: "archive-protocol",
};
export function archiveStores(root: string) {
  const worlds = new FileNativeWorldStore(root);
  const artifacts = new FileNativeArtifactStore(root);
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );
  const archives = new WorldArchives({ dataRoot: root, worlds, chains });
  return { root, worlds, artifacts, chains, archives };
}
export async function worldArchiveFixture(
  options: { extraPackageFiles?: readonly ContentTreeFile[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-world-archive-"));
  const fixture = archiveStores(root);
  await fixture.archives.initialize();
  const preset = builtinDefaultPlayPresetBinding();
  const created = await fixture.worlds.createFromContentPackage({
    operationId: "create-archive",
    sourcePackageId: "archive-package",
    sourcePackageTitle: "雨夜旅店",
    packageFiles: [
      ...(options.extraPackageFiles ?? []),
      { path: "opening.md", contents: "门外传来三声短促的铃响。\n" },
      {
        path: "world/current-situation.yaml",
        contents:
          "$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 旅店门边。\n  aliases: []\n情况: Alex守在旅店门边。\n",
      },
      {
        path: "control/frame.yaml",
        contents:
          "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 2 }\n  - slot: { kind: additional_materials }\n",
      },
      {
        path: "control/blocks/world.md",
        contents:
          "# World Rules\n\nWrite durable outcomes back to their natural owner.\n",
      },
      {
        path: "control/player-views.yaml",
        contents: "format: narraeon.player-views/v1\nviews: []\n",
      },
    ],
    prompt: {
      hostBinding: presetHostBinding(preset),
      modelBinding: archiveModelBinding,
    },
  });
  if (created.outcome !== "created") throw new Error("World creation failed");
  const worldId = created.world.worldId;
  const story = await fixture.chains.start({
    worldId,
    chainId: "archive-chain",
    exchangeId: "archive-send",
    playerText: "我推开旅店的大门。",
    hostBinding: presetHostBinding(preset),
    playPreset: preset,
    modelBinding: archiveModelBinding,
    modelHost: new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "response", text: "Alex抬起头，向你点头致意。" }],
    }),
  });
  return { ...fixture, worldId, preset, story };
}
