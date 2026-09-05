import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const [releaseRoot, output] = process.argv.slice(2);
if (!releaseRoot || !output)
  throw new Error("Expected pre38 source tree and output .json.gz");
const expectedSources = {
  "src/runtime/content/ContentWorkspace.ts":
    "70041e5c01a02b903ded0907fa2a53fda9ac484887b71de956c007319ad22a4d",
  "src/runtime/model/ModelHost.ts":
    "a999f0d048fb16f457156736be05339f84292afd753be00a8ca82c098e9a1e41",
  "src/runtime/prompt/FileNativePromptCompiler.ts":
    "0e00c19503e3ce80132c92e27caf2e9766f0f1d82d8a05e8ae22a9a68d1e7658",
  "src/runtime/setting/FileNativeSettingImprovementStore.ts":
    "f7d07014649e7eee0b63692fe161a3ce671f4f3021b4d6b5ab8b05f591a81c1c",
  "src/runtime/setting/SettingImprovementSession.ts":
    "386ba86578856d2cdcdfd6ea561d750b22e8532bbb3a8e8ba1e86c158c3f7c63",
  "src/runtime/play/FileNativePlayPresetStore.ts":
    "ca775487f53a5385723a840496ecbdb79b8ecab7811af22cb5cde644f5d30025",
};
for (const [path, expected] of Object.entries(expectedSources)) {
  const actual = createHash("sha256")
    .update(await readFile(join(releaseRoot, path)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Not the pre38 source: ${path}`);
}
const { ContentWorkspace } = await import(
  pathToFileURL(join(releaseRoot, "src/runtime/content/ContentWorkspace.ts"))
    .href
);
const { ScriptedModelHost } = await import(
  pathToFileURL(join(releaseRoot, "src/runtime/model/ModelHost.ts")).href
);
const { FileNativePromptCompiler } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/prompt/FileNativePromptCompiler.ts"),
  ).href
);
const { FileNativeSettingImprovementStore } = await import(
  pathToFileURL(
    join(
      releaseRoot,
      "src/runtime/setting/FileNativeSettingImprovementStore.ts",
    ),
  ).href
);
const { SettingImprovementSession } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/setting/SettingImprovementSession.ts"),
  ).href
);
const { builtinDefaultPlayPresetBinding, presetHostBinding } = await import(
  pathToFileURL(
    join(releaseRoot, "src/runtime/play/FileNativePlayPresetStore.ts"),
  ).href
);
const binding = {
  provider: "chat_completions",
  endpointFingerprint: "endpoint:test",
  modelId: "model:test",
  contextWindowTokens: 32_000,
  maxOutputTokens: 4_096,
  protocolConfigFingerprint: "protocol:test",
  cacheStrategy: "provider_managed",
};

async function createFixture(steps) {
  const root = await temporaryRoot("narraeon-setting-conversation-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const host = new ScriptedModelHost({ binding, steps });
  return {
    root,
    content,
    packageId: created.localId,
    host,
    session: serviceFor(root, content, host),
  };
}

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sendFresh(session, packageId, requestId, message) {
  return session.send({
    packageId,
    requestId,
    message,
    continuation: { kind: "fresh_context" },
  });
}

function serviceFor(
  root,
  content,
  host,
  playPreset = builtinDefaultPlayPresetBinding("en"),
) {
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  return new SettingImprovementSession({
    store: new FileNativeSettingImprovementStore(root),
    content,
    compiler,
    locale: () => "en",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: (frozenBinding) => {
      if (JSON.stringify(frozenBinding) !== JSON.stringify(host.binding()))
        throw new Error("Frozen model binding is unavailable");
      return Promise.resolve(host);
    },
    bindPlayPreset: () => Promise.resolve(structuredClone(playPreset)),
    preview: (snapshot, modelBinding, frozenPreset) => {
      if (frozenPreset === undefined)
        throw new Error(
          "New setting-improvement conversations freeze a preset",
        );
      const openingMessage = "setting-authoring.message.genesis.narrator";
      const opening = snapshot.files.find(({ path }) => path === "opening.md");
      return compiler.preview(
        {
          endpoint: { id: "setting-authoring", commit: "current-tree" },
          hostBinding: presetHostBinding(frozenPreset),
          world: {
            controlFingerprint: "setting-authoring",
            documentSnapshot: snapshot,
            history: { [openingMessage]: opening?.contents ?? "" },
            additionalMaterials: [
              { kind: "history_message", message: openingMessage },
            ],
          },
          playerInputPlacement: "append",
          playerInput: "Inspect the content package current tree.",
          modelBinding,
        },
        frozenPreset,
      );
    },
  });
}

const roots = [];
const fixture = await createFixture([
  {
    outcome: "response",
    reasoningContent: "Need the exact opening before replacing it.",
    toolCalls: [
      {
        id: "read-opening",
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: "write-opening",
        name: "setting_write_file",
        arguments: {
          path: "opening.md",
          contents: "Rain needles the midnight harbor.\n",
        },
      },
    ],
  },
  {
    outcome: "response",
    text: "The rainy harbor opening is already live.",
    toolCalls: [],
  },
]);
const view = await sendFresh(
  fixture.session,
  fixture.packageId,
  "request-write",
  "Move the opening to a rainy harbor.",
);
const files = {};
async function collect(dir, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(dir, entry.name), p + "/");
    else files[p] = await readFile(join(dir, entry.name), "utf8");
  }
}
await collect(fixture.root);
await writeFile(
  output,
  gzipSync(
    JSON.stringify(
      {
        commit: "f970155f4bc549158d7b73fccb7f317b7dcdb403",
        release: null,
        packageId: fixture.packageId,
        sessionId: view.sessionId,
        stored: await new FileNativeSettingImprovementStore(fixture.root).read(
          view.sessionId,
        ),
        requests: fixture.host.requests,
        files,
      },
      null,
      2,
    ) + "\n",
    { level: 9 },
  ),
);
console.log(
  JSON.stringify({ root: fixture.root, files: Object.keys(files).length }),
);
