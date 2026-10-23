import { createHash } from "node:crypto";
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
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { ContentTreeFile } from "../../src/runtime/content/ContentWorkspace.ts";
import type {
  ModelHost,
  ModelHostBinding,
  ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("upgrading a world removes released advance records, keeps the in-progress marker, and restart still reports the chain interrupted", async () => {
  const label = "advance-layout-interrupted";
  const { worlds, worldId, root } = await createWorld(label);
  const dispatched: ModelHostExchange[] = [];
  // The first runtime's dispatch never returns, as if the process exited mid-generation.
  const neverReturns: ModelHost = {
    binding: () => modelBinding(),
    exchange: (request) => {
      dispatched.push(structuredClone(request));
      return new Promise<never>(() => undefined);
    },
  };
  void new PlayCallChain(worlds)
    .start({
      worldId,
      chainId: label,
      exchangeId: `${label}-player`,
      playerText: "我推开石门。",
      hostBinding: hostBinding(),
      playPreset: playPreset(),
      modelBinding: modelBinding(),
      modelHost: neverReturns,
    })
    .catch(() => undefined);
  await vi.waitFor(() => expect(dispatched).toHaveLength(1));

  const chainRoot = advanceChainRoot(root, worldId, label);
  const marker = join(chainRoot, "in-progress.json");
  const markerBefore = await readFile(marker);
  await writeReleasedRecords(chainRoot);

  await new FileNativeWorldStore(root).ensureCurrentStorage(worldId);

  expect(await readdir(chainRoot)).toEqual(["in-progress.json"]);
  expect(await readFile(marker)).toEqual(markerBefore);
  const restarted = new PlayCallChain(new FileNativeWorldStore(root));
  expect(await restarted.inspectWorld(worldId)).toMatchObject({
    status: "interrupted",
    canRetry: true,
    lastFailureKind: "retryable",
  });
});

test("a chain with only released records loses its whole directory on upgrade", async () => {
  const { worldId, root } = await createWorld("advance-layout-legacy-only");
  const chainRoot = advanceChainRoot(root, worldId, "released-chain");
  await writeReleasedRecords(chainRoot);

  await new FileNativeWorldStore(root).ensureCurrentStorage(worldId);

  expect(await exists(chainRoot)).toBe(false);
});

test("an upgrade that stopped partway resumes: a chain whose records are already gone keeps its marker, and a chain still holding current.json is finished", async () => {
  const { worldId, root } = await createWorld("advance-layout-resume");
  const worldRoot = join(root, "worlds-file-native", worldId);
  // State left by an upgrade that removed the first chain's records and stopped.
  const finished = advanceChainRoot(root, worldId, "chain-finished");
  await mkdir(finished, { recursive: true });
  await writeFile(
    join(finished, "in-progress.json"),
    '{"kind":"in-progress"}\n',
  );
  const partial = advanceChainRoot(root, worldId, "chain-partial");
  await writeReleasedRecords(partial);

  await new FileNativeWorldStore(root).ensureCurrentStorage(worldId);

  expect(await readdir(finished)).toEqual(["in-progress.json"]);
  expect(await readFile(join(finished, "in-progress.json"), "utf8")).toBe(
    '{"kind":"in-progress"}\n',
  );
  expect(await exists(partial)).toBe(false);
  expect(
    await exists(join(worldRoot, "runtime", "play-advance-layout.json")),
  ).toBe(true);
});

test("an upgraded world writes nothing when it is opened again", async () => {
  const { worldId, root } = await createWorld("advance-layout-reopen");
  const worldRoot = join(root, "worlds-file-native", worldId);
  const chainRoot = advanceChainRoot(root, worldId, "released-chain");
  await writeReleasedRecords(chainRoot);

  await new FileNativeWorldStore(root).ensureCurrentStorage(worldId);
  expect(await exists(chainRoot)).toBe(false);
  const before = await snapshotTree(worldRoot);

  await new FileNativeWorldStore(root).ensureCurrentStorage(worldId);

  expect(await snapshotTree(worldRoot)).toEqual(before);
});

test("a world without released advance records is not marked or written when it is opened", async () => {
  const { worldId, root } = await createWorld("advance-layout-clean");
  const worldRoot = join(root, "worlds-file-native", worldId);
  const before = await snapshotTree(worldRoot);

  await new FileNativeWorldStore(root).ensureCurrentStorage(worldId);

  expect(await snapshotTree(worldRoot)).toEqual(before);
  expect(
    await exists(join(worldRoot, "runtime", "play-advance-layout.json")),
  ).toBe(false);
});

/** The layout ADR-0044 replaced: records per request digest plus a current pointer. */
async function writeReleasedRecords(chainRoot: string): Promise<void> {
  const record = join(chainRoot, "records", digest("released-record"));
  await mkdir(record, { recursive: true });
  for (const name of [
    "base.json",
    "provider-completed.json",
    "settlement-prepared.json",
    "settled.json",
  ])
    await writeFile(join(record, name), `{"released":"${name}"}\n`);
  await writeFile(join(chainRoot, "current.json"), '{"released":"current"}\n');
}

function advanceChainRoot(
  root: string,
  worldId: string,
  chainId: string,
): string {
  return join(
    root,
    "worlds-file-native",
    worldId,
    "runtime",
    "play-advances",
    digest(chainId),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function snapshotTree(
  directory: string,
): Promise<Record<string, { size: number; mtimeMs: number }>> {
  const snapshot: Record<string, { size: number; mtimeMs: number }> = {};
  const visit = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      const info = await stat(path);
      if (info.isDirectory()) await visit(path);
      else
        snapshot[path.slice(directory.length)] = {
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
    }
  };
  await visit(directory);
  return snapshot;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
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

function hostBinding(): Parameters<
  FileNativeWorldStore["createFromContentPackage"]
>[0]["prompt"]["hostBinding"] {
  return {
    hostPresetId: "play-advance-layout-host",
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
      "blocks/style.md": "# Host style\n\nBe restrained and specific.\n",
    },
  };
}

function modelBinding(): ModelHostBinding {
  return {
    provider: "chat_completions",
    endpointFingerprint: "play-advance-layout-endpoint",
    modelId: "play-advance-layout-model",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    protocolConfigFingerprint: "play-advance-layout-protocol",
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
