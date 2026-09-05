// Run against an exported v0.4.0 tree, never against current modules.
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
const [releaseRoot, root, output] = process.argv.slice(2);
if (!releaseRoot || !root || !output)
  throw new Error(
    "Expected release tree, empty data directory, and output .json.gz",
  );
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const expectedSources = {
  "src/runtime/world/FileNativeWorldStore.ts":
    "039c6e09007b3bfea9a8599e1fae1a3325dcedc02d1e58de71be4f330c7f3647",
  "src/runtime/play/FileNativePlayPresetStore.ts":
    "14a1583b8677c3b50e1518ecebe7a2bcc66f4b3210c105263ad44c53a4f10727",
  "src/runtime/play/PlayCallChain.ts":
    "8fcbba51a2d4a67f3d83a9e3b16b40ac4bda9d9170dff5a75dc6282ef60ffcf4",
  "src/runtime/artifact/FileNativeArtifactStore.ts":
    "45b2b17c73f57f20b83357ab5ec1f8ed88dd379560e67c881d299861d07236d9",
  "src/runtime/prompt/FileNativePromptCompiler.ts":
    "6977918ed7b2712a7ae698270a94a68b50da014f8245ae73f7f1c086590f1a32",
  "src/runtime/model/ModelHost.ts":
    "999121d0f463a248683297dde33c4192e81342e382f93f3c8da9134a99cfd0b7",
};
for (const [path, expected] of Object.entries(expectedSources)) {
  const actual = createHash("sha256")
    .update(await readFile(join(releaseRoot, path)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Not the v0.4.0 source: ${path}`);
}
await mkdir(root, { recursive: true });
if ((await readdir(root)).length !== 0)
  throw new Error("Fixture data directory must be empty");
const { FileNativeWorldStore } = await import(
  pathToFileURL(join(releaseRoot, "src/runtime/world/FileNativeWorldStore.ts"))
    .href
);
const {
  FileNativePlayPresetStore,
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
} = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/play/FileNativePlayPresetStore.ts"),
  ).href
);
const { ScriptedModelHost } = await import(
  pathToFileURL(join(releaseRoot, "src/runtime/model/ModelHost.ts")).href
);
const { PlayCallChain } = await import(
  pathToFileURL(join(releaseRoot, "src/runtime/play/PlayCallChain.ts")).href
);
const { FileNativeArtifactStore } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/artifact/FileNativeArtifactStore.ts"),
  ).href
);
const { FileNativePromptCompiler } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/prompt/FileNativePromptCompiler.ts"),
  ).href
);

function hostBinding() {
  return {
    hostPresetId: "play-chain-host",
    files: {
      "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
      "blocks/style.md":
        "# Host style\n\nBe restrained and specific. Do not act for the player.\n",
    },
  };
}

function modelBinding() {
  return {
    provider: "chat_completions",
    endpointFingerprint: "play-chain-endpoint",
    modelId: "play-chain-model",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    protocolConfigFingerprint: "play-chain-protocol",
  };
}

function worldFiles() {
  return [
    { path: "opening.md", contents: "门外传来三声短促的铃响。\n" },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 宿舍门边的局面。
  aliases: []
情况: Alex守在宿舍门边。
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`,
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
  ];
}

function followupPlayPreset() {
  const files = structuredClone(defaultPlayPresetFiles);
  files["preset.yaml"] = `format: narraeon.play-preset/v1
name: followup-test
callChain: call-chain.yaml
mounts:
  panel.status: sidebar
  player.options: composer_below
extensions: []
`;
  files["call-chain.yaml"] = `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
${followupEntry("status", "状态栏", "status_bar", "panel.status")}${followupEntry(
    "options",
    "行动选项",
    "options",
    "player.options",
  )}`;
  files["prompts/status.md"] = "# Status panel\n\nOutput the current status.\n";
  files["prompts/options.md"] =
    "# Action options\n\nSuggest possible next actions.\n";
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "followup-test-preset",
    name: "followup-test",
    revision: "followup-test-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function followupEntry(id, displayName, output, channel) {
  return `  - id: ${id}
    displayName: ${displayName}
    prompt: { markdown: prompts/${id}.md }
    maxArtifactBytes: 32768
    artifacts:
      - name: ${output}
        channel: ${channel}
        strategy: replace
        contentType: application/json
        save: commit
        invalidation: new_operation
        required: true
        maxEmits: 1
`;
}

await mkdir(root, { recursive: true });
const presets = new FileNativePlayPresetStore(join(root, "config"));
await presets.initialize();
const files = followupPlayPreset().files;
files["blocks/style-horror.md"] =
  "# Disabled old original\n\nPreserve **every** word & punctuation.\n";
files["renderers/released.html"] = "<p>Released resource</p>";
const imported = await presets.importPortable({
  name: "Released custom",
  files,
});
await presets.select(imported.preset.id);
const binding = await presets.bindCurrent();
const worlds = new FileNativeWorldStore(root);
const created = await worlds.createFromContentPackage({
  operationId: "released-create",
  sourcePackageId: "released-package",
  packageFiles: worldFiles(),
  prompt: { hostBinding: hostBinding(), modelBinding: modelBinding() },
});
const worldId = created.world.worldId;
const artifacts = new FileNativeArtifactStore(root);
const host = new ScriptedModelHost({
  binding: modelBinding(),
  steps: [
    {
      outcome: "response",
      toolCalls: [
        {
          id: "released-read",
          name: "context_read",
          arguments: { ref: "@current-situation" },
        },
      ],
    },
    {
      outcome: "response",
      text: "Released narrative.\n",
      reasoningContent: "Returned reasoning.",
    },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "released-panel",
          name: "artifact_emit",
          arguments: { output: "status_bar", payload: { hp: 9 } },
        },
      ],
    },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "released-options",
          name: "artifact_emit",
          arguments: { output: "options", payload: { first: "跟上去" } },
        },
      ],
    },
  ],
});
const chains = new PlayCallChain(
  worlds,
  new FileNativePromptCompiler(),
  artifacts,
);
await chains.start({
  worldId,
  chainId: "released-chain",
  exchangeId: "released-send",
  playerText: "Released player.\n",
  hostBinding: hostBinding(),
  playPreset: binding,
  modelBinding: modelBinding(),
  modelHost: host,
});
const filesOut = {};
async function collect(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(dir, entry.name), p + "/");
    else filesOut[p] = await readFile(join(dir, entry.name), "utf8");
  }
}
await collect(root);
await writeFile(
  output,
  gzipSync(
    JSON.stringify(
      {
        release: "v0.4.0",
        commit: "e0b776bbb8a1a1a74e2ff6d137e063272e7aa146",
        worldId,
        presetId: binding.id,
        presetRevision: binding.revision,
        head: await worlds.currentHead(worldId),
        endpoint: await worlds.recoverEndpoint(worldId),
        requests: host.requests,
        artifacts: await artifacts.readActiveProjection(worldId),
        files: filesOut,
      },
      null,
      2,
    ) + "\n",
    { level: 9 },
  ),
);
console.log(
  JSON.stringify({
    worldId,
    requests: host.requests.length,
    files: Object.keys(filesOut).length,
  }),
);
