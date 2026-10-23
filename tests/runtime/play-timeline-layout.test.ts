import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, test } from "vitest";

import type { ContentTreeFile } from "../../src/runtime/content/ContentWorkspace.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  type ModelHost,
  type ModelHostBinding,
  type ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { decodePlayPromptRun } from "../../src/runtime/play/PlayPromptRun.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

interface ReleasedFixture {
  worldId: string;
  files: ({ path: string; text: string } | { path: string; base64: string })[];
  golden: {
    chainId: string;
    head: string;
    prefixDiagnostics: unknown;
  };
}

const released = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        "./fixtures/play-timeline-layout/released-v071.json.gz",
        import.meta.url,
      ),
    ),
  ).toString("utf8"),
) as ReleasedFixture;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("released v0.7.1 layout migrates in place: requests move into their contexts, snapshots become references, and every read value is unchanged", async () => {
  const { root, worldRoot, context } = await restoreReleasedWorld();
  const state = await readJson(join(context, "state.json"));
  const continuation = await readJson(
    join(context, "continuations", `${String(state.continuationDigest)}.json`),
  );
  const digest = continuation.lastRequestDigest as string;
  const legacyRequest = await readFile(
    join(worldRoot, "runtime", "play-requests", `${digest}.json`),
  );
  const legacyRuns = await readLegacyRuns(
    join(context, "prompt-runs"),
    state.promptRunCount as number,
  );
  expect(legacyRuns.length).toBeGreaterThan(1);

  const worlds = new FileNativeWorldStore(root);
  await worlds.ensureCurrentStorage(released.worldId);

  expect(await exists(join(worldRoot, "runtime", "play-requests"))).toBe(false);
  expect(await readdir(join(context, "requests"))).toEqual([`${digest}.json`]);
  expect(await readFile(join(context, "requests", `${digest}.json`))).toEqual(
    legacyRequest,
  );
  const migrated = await worlds.playTimeline.readCurrent(released.worldId);
  expect(migrated?.value.promptRuns).toEqual(legacyRuns);
  expect(migrated?.value.lastRequest).toEqual(
    JSON.parse(legacyRequest.toString("utf8")),
  );

  const chains = new PlayCallChain(worlds);
  const reading = await chains.inspectReading(
    released.worldId,
    released.golden.head,
  );
  expect(reading?.prefixDiagnostics).toEqual(released.golden.prefixDiagnostics);

  const sent: ModelHostExchange[] = [];
  const recorded = await readJson(join(context, "base.json"));
  await chains.append({
    worldId: released.worldId,
    chainId: released.golden.chainId,
    exchangeId: "resend-after-migration",
    playerText: "",
    modelHost: scriptedHost(sent, recorded.modelBinding as ModelHostBinding),
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual(JSON.parse(legacyRequest.toString("utf8")));
});

test("a migration that stopped after copying a request resumes and removes the legacy directory", async () => {
  const { root, worldRoot, context } = await restoreReleasedWorld();
  const state = await readJson(join(context, "state.json"));
  const continuation = await readJson(
    join(context, "continuations", `${String(state.continuationDigest)}.json`),
  );
  const digest = continuation.lastRequestDigest as string;
  const legacyRequest = await readFile(
    join(worldRoot, "runtime", "play-requests", `${digest}.json`),
  );
  await mkdir(join(context, "requests"), { recursive: true });
  await writeFile(join(context, "requests", `${digest}.json`), legacyRequest);

  await new FileNativeWorldStore(root).ensureCurrentStorage(released.worldId);
  expect(await exists(join(worldRoot, "runtime", "play-requests"))).toBe(false);
  expect(await readdir(join(context, "requests"))).toEqual([`${digest}.json`]);
  expect(await readFile(join(context, "requests", `${digest}.json`))).toEqual(
    legacyRequest,
  );
});

test("consecutive sends with an unchanged preset store later prompt snapshots as references, and a changed preset writes one new full snapshot", async () => {
  const { worlds, worldId, root } = await createWorld("prompt-reference");
  const chains = new PlayCallChain(worlds);
  const sent: ModelHostExchange[] = [];
  const host = scriptedHost(sent);
  await chains.start({
    worldId,
    chainId: "prompt-reference-context",
    exchangeId: "send-1",
    playerText: "门外的铃声又响了。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  for (const index of [2, 3])
    await chains.append({
      worldId,
      chainId: "prompt-reference-context",
      exchangeId: `send-${index}`,
      playerText: `第 ${index} 次输入。`,
      resolvePrompt: () =>
        Promise.resolve({
          hostBinding: hostBinding(),
          playPreset: playPreset(),
        }),
      modelHost: host,
    });
  await chains.append({
    worldId,
    chainId: "prompt-reference-context",
    exchangeId: "send-4",
    playerText: "第 4 次输入，预设已改动。",
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: revisedPlayPreset(),
      }),
    modelHost: host,
  });
  await chains.append({
    worldId,
    chainId: "prompt-reference-context",
    exchangeId: "send-5",
    playerText: "第 5 次输入，预设未再改动。",
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: revisedPlayPreset(),
      }),
    modelHost: host,
  });

  const context = await contextRoot(root, worldId);
  const records = await readPromptRunRecords(join(context, "prompt-runs"));
  const full = records.filter((record) => record.kind === "play_prompt_run");
  expect(full).toHaveLength(1);
  expect(
    records.filter((record) => record.kind !== "play_prompt_run"),
  ).toHaveLength(records.length - 1);

  const reloaded = await new FileNativeWorldStore(
    root,
  ).playTimeline.readCurrent(worldId);
  const runs = reloaded?.value.promptRuns ?? [];
  expect(runs).toHaveLength(records.length);
  const revisionOf = (run: (typeof runs)[number]) => run.playPreset.revision;
  const changed = runs.findIndex(
    (run) => revisionOf(run) !== revisionOf(runs[0]!),
  );
  expect(changed).toBeGreaterThan(0);
  expect(runs.slice(0, changed).map(revisionOf)).toEqual(
    runs.slice(0, changed).map(() => "builtin-default-v1"),
  );
  expect(runs.slice(changed).map(revisionOf)).toEqual(
    runs.slice(changed).map(() => "builtin-default-v2"),
  );
});

test("a context keeps only its latest frozen request, and the released request directory never reappears", async () => {
  const { worlds, worldId, root } = await createWorld("latest-request");
  const chains = new PlayCallChain(worlds);
  const sent: ModelHostExchange[] = [];
  const host = scriptedHost(sent);
  await chains.start({
    worldId,
    chainId: "latest-request-context",
    exchangeId: "send-1",
    playerText: "门外的铃声又响了。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  for (const index of [2, 3])
    await chains.append({
      worldId,
      chainId: "latest-request-context",
      exchangeId: `send-${index}`,
      playerText: `第 ${index} 次输入。`,
      modelHost: host,
    });

  const context = await contextRoot(root, worldId);
  const current = await worlds.playTimeline.readCurrent(worldId);
  const digest = requestDigest(current!.value.lastRequest!);
  expect(await readdir(join(context, "requests"))).toEqual([`${digest}.json`]);
  expect(
    await exists(
      join(root, "worlds-file-native", worldId, "runtime", "play-requests"),
    ),
  ).toBe(false);
  expect(current?.value.lastRequest).toEqual(sent.at(-1));
});

test("a context keeps at most two request encodings, and the AI-reading diagnostics still compare the latest two", async () => {
  const { worlds, worldId, root } = await createWorld("encoding-bound");
  const chains = new PlayCallChain(worlds);
  const sent: unknown[] = [];
  const host = new FileNativeModelHost(
    {
      provider: "chat_completions",
      dialect: "cliproxyapi",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "bound-secret",
      modelId: "bound-model",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    },
    (_url, options) => {
      if (typeof options?.body !== "string")
        throw new Error("Expected JSON request text");
      sent.push(JSON.parse(options.body) as unknown);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "你走到了门边。" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          }),
        ),
      );
    },
  );
  await chains.start({
    worldId,
    chainId: "encoding-bound-context",
    exchangeId: "send-1",
    playerText: "走到门边。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: host.binding(),
    modelHost: host,
  });
  for (const index of [2, 3, 4])
    await chains.append({
      worldId,
      chainId: "encoding-bound-context",
      exchangeId: `send-${index}`,
      playerText: `第 ${index} 次输入。`,
      resolvePrompt: () =>
        Promise.resolve({
          hostBinding: hostBinding(),
          playPreset: playPreset(),
        }),
      modelHost: host,
    });
  expect(sent).toHaveLength(4);

  const context = await contextRoot(root, worldId);
  const encodings = (await readdir(context)).filter((name) =>
    /^(initial-)?request-encoding/u.test(name),
  );
  expect(encodings).toHaveLength(2);
  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  const view = await restarted.inspectWorld(worldId);
  await expect(
    restarted.inspectReading(worldId, view!.parentHead),
  ).resolves.toBeDefined();
});

test("a context derived from a completed endpoint starts without a frozen request, and keeps its own prompt snapshots after the source changes", async () => {
  const { worlds, worldId, root } = await createWorld("derived-copy");
  const chains = new PlayCallChain(worlds);
  const sent: ModelHostExchange[] = [];
  const host = scriptedHost(sent);
  const completed = await chains.start({
    worldId,
    chainId: "derived-copy-source",
    exchangeId: "send-1",
    playerText: "门外的铃声又响了。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: host,
  });
  expect(completed.status).toBe("ready");
  await chains.append({
    worldId,
    chainId: "derived-copy-source",
    exchangeId: "send-2",
    playerText: "第二次输入。",
    resolvePrompt: () =>
      Promise.resolve({ hostBinding: hostBinding(), playPreset: playPreset() }),
    modelHost: host,
  });
  const sourceBefore = await worlds.playTimeline.readCurrent(worldId);
  const sourceEnd = sourceBefore!.value.parentHead;

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const derived = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-completed-context",
      sourceWorldId: worldId,
      sourceHead: sourceEnd,
    })
  ).result as { world: { worldId: string } };
  const derivedBefore = await worlds.playTimeline.readCurrent(
    derived.world.worldId,
  );
  expect(derivedBefore?.value.lastRequest).toBeNull();
  expect(
    await exists(
      join(await contextRoot(root, derived.world.worldId), "requests"),
    ),
  ).toBe(false);

  await chains.append({
    worldId,
    chainId: "derived-copy-source",
    exchangeId: "send-3",
    playerText: "第三次输入，源上下文改用新预设。",
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: hostBinding(),
        playPreset: revisedPlayPreset(),
      }),
    modelHost: host,
  });
  const sourceAfter = await worlds.playTimeline.readCurrent(worldId);
  expect(sourceAfter?.value.promptRuns?.length).toBeGreaterThan(
    sourceBefore?.value.promptRuns?.length ?? 0,
  );
  const derivedAfter = await worlds.playTimeline.readCurrent(
    derived.world.worldId,
  );
  expect(derivedAfter?.value.promptRuns).toEqual(
    derivedBefore?.value.promptRuns,
  );
  expect(derivedAfter?.value.transcript).toEqual(
    derivedBefore?.value.transcript,
  );
});

async function restoreReleasedWorld(): Promise<{
  root: string;
  worldRoot: string;
  context: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-released-play-layout-"));
  roots.push(root);
  for (const file of released.files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      "text" in file ? file.text : Buffer.from(file.base64, "base64"),
    );
  }
  const worldRoot = join(root, "worlds-file-native", released.worldId);
  const contexts = join(worldRoot, "runtime", "play-contexts");
  const [only] = await readdir(contexts);
  return { root, worldRoot, context: join(contexts, only!) };
}

async function contextRoot(root: string, worldId: string): Promise<string> {
  const contexts = join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-contexts",
  );
  const [only] = await readdir(contexts);
  return join(contexts, only!);
}

async function readPromptRunRecords(
  directory: string,
): Promise<{ kind: string }[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const record = await readJson(join(directory, name));
      return { kind: String(record.kind) };
    }),
  );
}

async function readLegacyRuns(directory: string, count: number) {
  const runs = [];
  for (let index = 1; index <= count; index += 1)
    runs.push(
      decodePlayPromptRun(await readJson(join(directory, numbered(index)))),
    );
  return runs;
}

function numbered(index: number): string {
  return `${String(index).padStart(10, "0")}.json`;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function requestDigest(request: ModelHostExchange): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function scriptedHost(
  record: ModelHostExchange[],
  binding: ModelHostBinding = modelBinding(),
): ModelHost {
  return {
    binding: () => binding,
    exchange(request) {
      record.push(structuredClone(request));
      return Promise.resolve({
        text: `第 ${record.length} 段叙事。`,
        providerState: {
          protocol: "chat_completions",
          assistantMessage: {
            role: "assistant",
            content: `第 ${record.length} 段叙事。`,
          },
        },
      });
    },
  };
}

async function createWorld(label: string): Promise<{
  worlds: FileNativeWorldStore;
  worldId: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const worlds = new FileNativeWorldStore(root);
  const created = await worlds.createFromContentPackage({
    operationId: `create-${label}-world`,
    sourcePackageId: `${label}-package`,
    sourcePackageTitle: `${label} package`,
    packageFiles: worldFiles(),
    prompt: { hostBinding: hostBinding(), modelBinding: modelBinding() },
  });
  if (created.outcome !== "created") throw new Error("world was not created");
  return { worlds, worldId: created.world.worldId, root };
}

function revisedPlayPreset(): PlayPresetBinding {
  return { ...playPreset(), revision: "builtin-default-v2" };
}

function playPreset(): PlayPresetBinding {
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

function hostBinding(
  style = "Be restrained and specific. Do not act for the player.",
): Parameters<
  FileNativeWorldStore["createFromContentPackage"]
>[0]["prompt"]["hostBinding"] {
  return {
    hostPresetId: "play-timeline-layout-host",
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
      "blocks/style.md": `# Host style\n\n${style}\n`,
    },
  };
}

function modelBinding(): ModelHostBinding {
  return {
    provider: "chat_completions",
    endpointFingerprint: "play-timeline-layout-endpoint",
    modelId: "play-timeline-layout-model",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    protocolConfigFingerprint: "play-timeline-layout-protocol",
  };
}

function worldFiles(): ContentTreeFile[] {
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
