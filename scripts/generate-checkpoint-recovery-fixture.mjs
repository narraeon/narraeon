import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// Run against the exported historical source described in README.md. No
// current objects are edited to impersonate a released persistent format.
if (!process.argv[2])
  throw new Error("Expected exported 2cd320b source directory");
const sourceRoot = resolve(process.argv[2]);
const expectedSources = {
  "runtime/play/PlayContinuity.ts":
    "4936fc9786f9ce656dc2512f22e38734bf6f75a1cc746b99b3c575b4bb4f14b1",
  "runtime/play/PlayCallChain.ts":
    "2ab66b0b0ec16dd9dc03a01dcb5a77db7bb6e03e60e3b3dcc4b928a4382ea362",
  "runtime/prompt/FileNativeToolRegistry.ts":
    "a08305d35cec6ac7735216b79168c4038b4c44ea2bffe33154e8e146eeebb043",
  "runtime/prompt/FileNativePromptCompiler.ts":
    "d5710ca6e141e1d37c7245350946ce8b28335be940bfea0473e83a017d856a6e",
  "shared/default-preset-host.ts":
    "ce58055860300d499761056ba6b901afa47a7c36f4a0675441f058aa98eb5635",
};
for (const [path, expected] of Object.entries(expectedSources)) {
  const actual = createHash("sha256")
    .update(await readFile(join(sourceRoot, "src", path)))
    .digest("hex");
  if (actual !== expected)
    throw new Error(`Not the original 2cd320b source: ${path}`);
}
const load = (path) =>
  import(pathToFileURL(join(sourceRoot, "src", path)).href);
const [world, play, prompt, preset, model, content] = await Promise.all([
  load("runtime/world/FileNativeWorldStore.ts"),
  load("runtime/play/PlayCallChain.ts"),
  load("runtime/prompt/FileNativePromptCompiler.ts"),
  load("runtime/play/FileNativePlayPresetStore.ts"),
  load("runtime/model/ModelHost.ts"),
  load("runtime/content/ContentWorkspace.ts"),
]);
const root = await mkdtemp(join(tmpdir(), "narraeon-released-checkpoint-"));
try {
  const worlds = new world.FileNativeWorldStore(root);
  const modelBinding = {
    provider: "chat_completions",
    endpointFingerprint: "checkpoint-recovery-fixture",
    modelId: "checkpoint-recovery-fixture",
    protocolConfigFingerprint: "checkpoint-recovery-fixture",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8192,
  };
  const scenarios = [];
  for (const locale of ["en", "zh-CN"]) {
    const playPreset = preset.builtinDefaultPlayPresetBinding(locale);
    const hostBinding = preset.presetHostBinding(playPreset);
    const created = await worlds.createFromContentPackage({
      operationId: `create-${locale}`,
      sourcePackageId: `checkpoint-fixture-${locale}`,
      sourcePackageTitle: `Checkpoint recovery ${locale}`,
      packageFiles: content.minimalFileNativeContentScaffold(locale),
      prompt: { hostBinding, modelBinding },
    });
    if (created.outcome !== "created") throw new Error("World not created");
    const worldId = created.world.worldId;
    const host = new model.ScriptedModelHost({
      binding: modelBinding,
      steps: [{ outcome: "failure", message: "Rejected before generation." }],
    });
    const result = await new play.PlayCallChain(
      worlds,
      new prompt.FileNativePromptCompiler({ locale }),
    ).start({
      worldId,
      chainId: `released-checkpoint-${locale}`,
      exchangeId: "initial",
      playerText: "  Begin the lesson.\n",
      hostBinding,
      playPreset,
      modelBinding,
      modelHost: host,
    });
    if (result.status !== "interrupted" || !result.canRetry)
      throw new Error("Expected a frozen retryable request");
    const request = host.requests[0];
    if (request.appended[0]?.notice !== "checkpoint_rounds")
      throw new Error("Source does not generate released round markers");
    scenarios.push({
      locale,
      worldId,
      chainId: result.chainId,
      head: result.parentHead,
      request,
    });
  }
  const files = {};
  async function collect(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await collect(path, `${relative}/`);
      else files[relative] = await readFile(path, "utf8");
    }
  }
  await collect(root);
  await writeFile(
    new URL(
      "../tests/runtime/fixtures/released-v056-checkpoint/storage.json.gz",
      import.meta.url,
    ),
    gzipSync(
      JSON.stringify({
        sourceCommit: "2cd320bb6a5f4cc37b0d6d8049c175b03cc9d450",
        sourceVersion: "0.5.6",
        scenarios,
        files,
      }),
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
