// Drives one play context through a scripted chat-completions endpoint and
// reports how much of the world directory it occupies. Run it against an
// exported release tree to record that layout (ADR-0034 fixtures) or against
// the working tree to measure the current one. The last send is rejected
// before generation, so the context ends retryable with its frozen request.
//
// Usage: node scripts/play-world-storage-run.mjs <tree> <empty-output-dir> [--sends N] [--envelope file.json.gz]
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const [tree, output] = args.filter((arg, index) => {
  const previous = args[index - 1];
  return !arg.startsWith("--") && !previous?.startsWith("--");
});
if (!tree || !output)
  throw new Error(
    "Expected a source tree and an empty output directory: node scripts/play-world-storage-run.mjs <tree> <output> [--sends N]",
  );
const sends = Number(flag("--sends") ?? 20);
const envelope = flag("--envelope");
const root = resolve(tree);
const dataRoot = resolve(output);
await mkdir(dataRoot, { recursive: true });
if ((await readdir(dataRoot)).length !== 0)
  throw new Error("Output directory must be empty");

const source = (path) => pathToFileURL(join(root, "src", path)).href;
const { PlayCallChain } = await import(source("runtime/play/PlayCallChain.ts"));
const { FileNativeWorldStore } = await import(
  source("runtime/world/FileNativeWorldStore.ts")
);
const { FileNativeModelHost } = await import(
  source("runtime/model/FileNativeModelAdapters.ts")
);
const { ModelHostFailureError } = await import(
  source("runtime/model/ModelHost.ts")
);
const { defaultPlayPresetFiles, parsePlayPresetFiles } = await import(
  source("runtime/play/FileNativePlayPresetStore.ts")
);

const modelConnection = {
  provider: "chat_completions",
  dialect: "cliproxyapi",
  baseUrl: "https://provider.invalid/v1",
  apiKey: "scripted-key",
  modelId: "scripted-model",
  contextWindowTokens: 32000,
  maxOutputTokens: 2000,
};
let answered = 0;
const scripted = new FileNativeModelHost(modelConnection, (_url, options) => {
  answered += 1;
  JSON.parse(String(options?.body));
  return Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: `第 ${answered} 段叙事：Alex 答应了你的请求。`,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100 + answered,
          completion_tokens: 20,
          total_tokens: 120 + answered,
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
});
const binding = scripted.binding();

function playPreset() {
  const files = structuredClone(defaultPlayPresetFiles);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "builtin-default",
    name: "default",
    revision: "builtin-default-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

const hostBinding = () => ({
  hostPresetId: "storage-run-host",
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
});

const packageFiles = [
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

const worlds = new FileNativeWorldStore(dataRoot);
const created = await worlds.createFromContentPackage({
  operationId: "storage-run-world",
  sourcePackageId: "storage-run-package",
  sourcePackageTitle: "storage run package",
  packageFiles,
  prompt: { hostBinding: hostBinding(), modelBinding: binding },
});
if (created.outcome !== "created") throw new Error("world was not created");
const worldId = created.world.worldId;
const chains = new PlayCallChain(worlds);
const resolvePrompt = async () => ({
  hostBinding: hostBinding(),
  playPreset: playPreset(),
});

await chains.start({
  worldId,
  chainId: "storage-run-context",
  exchangeId: "send-1",
  playerText: "门外的铃声又响了。",
  hostBinding: hostBinding(),
  playPreset: playPreset(),
  modelBinding: binding,
  modelHost: scripted,
});
for (let index = 2; index <= sends - 1; index += 1)
  await chains.append({
    worldId,
    chainId: "storage-run-context",
    exchangeId: `send-${index}`,
    playerText: `第 ${index} 次输入：我看向${index % 2 === 0 ? "门" : "窗"}外。`,
    resolvePrompt,
    modelHost: scripted,
  });

let rejectedRequest = null;
const rejecting = {
  binding: () => binding,
  exchange(request) {
    rejectedRequest = structuredClone(request);
    return Promise.reject(
      new ModelHostFailureError("Provider 在生成前拒绝了请求。"),
    );
  },
};
const interrupted = await chains.append({
  worldId,
  chainId: "storage-run-context",
  exchangeId: `send-${sends}`,
  playerText: "最后一次输入：我敲门。",
  resolvePrompt,
  modelHost: rejecting,
});
const view = await chains.inspectWorld(worldId);
const reading = await chains.inspectReading(worldId, view.parentHead);

const worldRoot = join(dataRoot, "worlds-file-native", worldId);
const files = await listFiles(worldRoot);
const buckets = {};
for (const file of files) {
  const bucket = bucketOf(file.path);
  buckets[bucket] = (buckets[bucket] ?? 0) + file.bytes;
}
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
const summary = {
  tree,
  sends,
  answeredByScript: answered,
  worldId,
  interruptedStatus: interrupted.status,
  canRetry: interrupted.canRetry,
  worldFiles: files.length,
  worldBytes: totalBytes,
  bytesByBucket: buckets,
  requestSha256: rejectedRequest
    ? createHash("sha256").update(JSON.stringify(rejectedRequest)).digest("hex")
    : null,
};
console.log(JSON.stringify(summary, null, 2));

if (envelope !== undefined) {
  const envelopeFiles = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    const bytes = await readFile(join(worldRoot, file.path));
    const path = relative(dataRoot, join(worldRoot, file.path));
    try {
      envelopeFiles.push({ path, text: decoder.decode(bytes) });
    } catch {
      envelopeFiles.push({ path, base64: bytes.toString("base64") });
    }
  }
  const golden = {
    release: flag("--release") ?? null,
    worldId,
    sends,
    chainId: "storage-run-context",
    head: view.parentHead,
    prefixDiagnostics: reading?.prefixDiagnostics ?? null,
    retryRequestSha256: summary.requestSha256,
  };
  await writeFile(
    envelope,
    gzipSync(JSON.stringify({ worldId, files: envelopeFiles, golden })),
  );
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(join(directory, prefix), {
    withFileTypes: true,
  });
  const result = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await listFiles(directory, path)));
    else result.push({ path, bytes: (await stat(join(directory, path))).size });
  }
  return result;
}

function bucketOf(path) {
  if (path.startsWith("runtime/play-requests/")) return "runtime/play-requests";
  if (/\/prompt-runs\//u.test(path)) return "prompt-runs";
  if (/\/(initial-)?request-encoding/u.test(path)) return "request-encodings";
  if (
    /\/(transcript|events|summaries|completed-tools|continuations)\//u.test(
      path,
    )
  )
    return "context-records";
  if (/^runtime\/turns\//u.test(path)) return "turn-ledger";
  return path.split("/").slice(0, 2).join("/");
}
