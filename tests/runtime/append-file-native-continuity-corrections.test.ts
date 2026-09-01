import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import type { ContentTreeFile } from "../../src/runtime/content/ContentWorkspace.ts";
import { FileNativeContinuityCorrection } from "../../src/runtime/play/FileNativeContinuityCorrection.ts";
import type { MaterialSelection } from "../../src/runtime/prompt/MaterialSelection.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { invalidMaterialLists } from "../support/materialListCases.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("文档修正先读后 patch、Preview并追加 correction commit", async () => {
  const { root, store, corrections, worldId } = await world();
  const started = await corrections.begin({
    worldId,
    operationId: "correction-document",
    mode: "documents",
  });
  const read = corrections.readDocument(started.candidateId, "@alex");
  const patched = corrections.patchDocument({
    candidateId: started.candidateId,
    expectedVersion: started.version,
    target: "@alex",
    expectedHash: read.hash,
    edits: [
      {
        op: "replace",
        locator: { yaml: ["衣着"] },
        value: "蓝色训练外套",
      },
    ],
  });
  const preview = corrections.preview({
    candidateId: started.candidateId,
    expectedVersion: patched.version,
    prompt: prompt(),
  });
  expect(preview.parentHead).toBe("genesis");
  expect(preview.diffs[0]).toMatchObject({
    documentId: "character.alex",
    beforeHash: read.hash,
  });
  expect(preview.diffs[0]?.after).toContain("蓝色训练外套");
  expect(preview.nextPrompt.compilation.logicalMessages.length).toBeGreaterThan(
    0,
  );

  const committed = await corrections.apply({
    candidateId: started.candidateId,
    expectedVersion: patched.version,
  });
  expect(committed).toMatchObject({
    outcome: "committed",
    parentHead: "genesis",
    head: "commit:1",
    mode: "correction",
  });
  expect(await store.readSurface(worldId, "history")).toEqual([
    expect.objectContaining({
      contents: "你站在安静的房间里，面前的局面正等你回应。\n",
    }),
  ]);
  expect(
    (await store.bindPlayCallChain(worldId)).files[
      "state/characters/alex.yaml"
    ],
  ).toContain("蓝色训练外套");
  expect(
    (await store.renderPlayerViews(worldId)).views[0]?.items[0]?.value,
  ).toBe("蓝色训练外套");
  expect(
    (await store.readAuthorityEndpoint(worldId, "genesis")).state.find(
      ({ path }) => path === "characters/alex.yaml",
    )?.contents,
  ).toContain("白色背心");

  const trace = await store.readAuthorityHistory(worldId);
  expect(trace.commits[0]).toMatchObject({
    mode: "correction",
    auditParent: { head: "genesis" },
    timelineParent: { head: "genesis" },
    head: "commit:1",
    correctionTargets: ["character.alex"],
  });
  await expect(
    store.commitCorrection({
      operationId: "correction-document",
      worldId,
      parentHead: "genesis",
      nextMaterials: [],
      stateChanges: [],
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(store.traceCorrections(worldId, "genesis")).resolves.toEqual({
    endpoint: "genesis",
    corrects: null,
    correctedBy: ["commit:1"],
  });
  await expect(store.traceCorrections(worldId, "commit:1")).resolves.toEqual({
    endpoint: "commit:1",
    corrects: "genesis",
    correctedBy: [],
  });
  const recovered = new FileNativeWorldStore(root);
  expect(
    (await recovered.bindPlayCallChain(worldId)).files[
      "state/characters/alex.yaml"
    ],
  ).toContain("蓝色训练外套");
  expect(
    (await recovered.readAuthorityEndpoint(worldId, "genesis")).state.find(
      ({ path }) => path === "characters/alex.yaml",
    )?.contents,
  ).toContain("白色背心");
});

test("文档修正通过同一 revision 身份与 hash 规则替换完整文档", async () => {
  const { store, corrections, worldId } = await world();
  const started = await corrections.begin({
    worldId,
    operationId: "correction-replace-document",
    mode: "documents",
  });
  const read = corrections.readDocument(started.candidateId, "@alex");
  const contents = read.contents.replace("衣着: 白色背心", "衣着: 黑色风衣");

  const replaced = corrections.replaceDocument({
    candidateId: started.candidateId,
    expectedVersion: started.version,
    target: "@alex",
    expectedHash: read.hash,
    contents,
  });
  const preview = corrections.preview({
    candidateId: started.candidateId,
    expectedVersion: replaced.version,
    prompt: prompt(),
  });

  expect(preview.diffs).toEqual([
    expect.objectContaining({
      documentId: "character.alex",
      path: "characters/alex.yaml",
      beforeHash: read.hash,
      before: read.contents,
      after: contents,
    }),
  ]);
  await corrections.apply({
    candidateId: started.candidateId,
    expectedVersion: replaced.version,
  });
  expect(
    (await store.bindPlayCallChain(worldId)).files[
      "state/characters/alex.yaml"
    ],
  ).toBe(contents);
});

test("Markdown 修正复用 revision 的标题 locator 与完整结构化 diff", async () => {
  const { corrections, worldId } = await world();
  const started = await corrections.begin({
    worldId,
    operationId: "correction-markdown-locator",
    mode: "documents",
  });
  const read = corrections.readDocument(started.candidateId, "@world-lore");
  const patched = corrections.patchDocument({
    candidateId: started.candidateId,
    expectedVersion: started.version,
    target: "@world-lore",
    expectedHash: read.hash,
    edits: [
      {
        op: "replace_section",
        locator: { markdown: ["真实规则"] },
        markdown: "## 真实规则\n\n新正文。",
      },
    ],
  });
  const preview = corrections.preview({
    candidateId: started.candidateId,
    expectedVersion: patched.version,
    prompt: prompt(),
  });

  expect(preview.diffs[0]).toMatchObject({
    documentId: "rule.world-lore",
    path: "rules/lore.md",
    beforeHash: read.hash,
    before: read.contents,
  });
  expect(preview.diffs[0]?.after).toContain(
    "```md\n## 真实规则\n伪标题正文。\n```",
  );
  expect(preview.diffs[0]?.after).toContain("## 真实规则\n\n新正文。\n");
  await corrections.cancel(started.candidateId, patched.version);
});

test("修正读取授权绑定当前 revision 快照，候选变化后必须重新精确读取", async () => {
  const { corrections, worldId } = await world();
  const started = await corrections.begin({
    worldId,
    operationId: "correction-stale-read",
    mode: "documents",
  });
  const alex = corrections.readDocument(started.candidateId, "@alex");
  const staleLore = corrections.readDocument(
    started.candidateId,
    "@world-lore",
  );
  const changed = corrections.patchDocument({
    candidateId: started.candidateId,
    expectedVersion: started.version,
    target: "@alex",
    expectedHash: alex.hash,
    edits: [{ op: "replace", locator: { yaml: ["衣着"] }, value: "训练服" }],
  });

  expect(() =>
    corrections.patchDocument({
      candidateId: started.candidateId,
      expectedVersion: changed.version,
      target: "@world-lore",
      expectedHash: staleLore.hash,
      edits: [{ op: "replace_body", markdown: "# 世界掌故\n\n新正文。" }],
    }),
  ).toThrow(/must be read in full first/u);
  const currentLore = corrections.readDocument(
    started.candidateId,
    "@world-lore",
  );
  const repaired = corrections.patchDocument({
    candidateId: started.candidateId,
    expectedVersion: changed.version,
    target: "@world-lore",
    expectedHash: currentLore.hash,
    edits: [{ op: "replace_body", markdown: "# 世界掌故\n\n新正文。" }],
  });
  await corrections.cancel(started.candidateId, repaired.version);
});

test("修正 revision 机械失败不推进版本也不留下部分候选", async () => {
  const { store, corrections, worldId } = await world();
  const started = await corrections.begin({
    worldId,
    operationId: "correction-atomic-failure",
    mode: "documents",
  });
  const read = corrections.readDocument(started.candidateId, "@alex");

  expect(() =>
    corrections.patchDocument({
      candidateId: started.candidateId,
      expectedVersion: started.version,
      target: "@alex",
      expectedHash: read.hash,
      edits: [
        {
          op: "replace",
          locator: { yaml: ["不存在"] },
          value: "不会写入",
        },
      ],
    }),
  ).toThrow(/YAML replace target must exist/u);
  expect(
    corrections.preview({
      candidateId: started.candidateId,
      expectedVersion: started.version,
      prompt: prompt(),
    }).diffs,
  ).toEqual([]);
  await corrections.cancel(started.candidateId, started.version);
  expect(
    (await store.bindPlayCallChain(worldId)).files[
      "state/characters/alex.yaml"
    ],
  ).toBe(read.contents);
});

test("材料清单修正整份替换，不能夹带文档变化，取消不留痕", async () => {
  const { store, corrections, worldId } = await world();
  const started = await corrections.begin({
    worldId,
    operationId: "correction-materials",
    mode: "materials",
  });
  expect(() =>
    corrections.patchDocument({
      candidateId: started.candidateId,
      expectedVersion: started.version,
      target: "@alex",
      expectedHash: "sha256:wrong",
      edits: [],
    }),
  ).toThrow(/cannot modify world documents/u);
  for (const { value: invalid } of invalidMaterialLists)
    expect(() =>
      corrections.replaceMaterials({
        candidateId: started.candidateId,
        expectedVersion: started.version,
        nextMaterials: invalid as MaterialSelection[],
        prompt: prompt(),
      }),
    ).toThrow(/additional-materials list schema/u);
  const replaced = corrections.replaceMaterials({
    candidateId: started.candidateId,
    expectedVersion: started.version,
    nextMaterials: [{ kind: "document", document: "character.alex" }],
    prompt: prompt(),
  });
  await corrections.cancel(started.candidateId, replaced.version);
  expect((await store.bindPlayCallChain(worldId)).parentHead).toBe("genesis");
  await expect(
    store.getOperationOutcome("correction-materials"),
  ).resolves.toEqual({
    outcome: "cancelled",
  });
});

test("陈旧候选版本、同世界并发候选和 operation 复用均被拒绝", async () => {
  const { root, corrections, worldId } = await world();
  const first = await corrections.begin({
    worldId,
    operationId: "correction-first",
    mode: "documents",
  });
  const read = corrections.readDocument(first.candidateId, "@alex");
  const changed = corrections.patchDocument({
    candidateId: first.candidateId,
    expectedVersion: first.version,
    target: "@alex",
    expectedHash: read.hash,
    edits: [{ op: "replace", locator: { yaml: ["衣着"] }, value: "黑色外套" }],
  });
  expect(() =>
    corrections.preview({
      candidateId: first.candidateId,
      expectedVersion: first.version,
      prompt: prompt(),
    }),
  ).toThrow(/candidate version has changed/u);

  await expect(
    new FileNativeContinuityCorrection(new FileNativeWorldStore(root)).begin({
      worldId,
      operationId: "correction-competing",
      mode: "materials",
    }),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  corrections.preview({
    candidateId: first.candidateId,
    expectedVersion: changed.version,
    prompt: prompt(),
  });
  await corrections.apply({
    candidateId: first.candidateId,
    expectedVersion: changed.version,
  });
  const competing = await corrections.begin({
    worldId,
    operationId: "correction-competing",
    mode: "materials",
  });
  const replacement = corrections.replaceMaterials({
    candidateId: competing.candidateId,
    expectedVersion: competing.version,
    nextMaterials: [],
    prompt: prompt(),
  });
  corrections.preview({
    candidateId: competing.candidateId,
    expectedVersion: replacement.version,
    prompt: prompt(),
  });
  await expect(
    corrections.apply({
      candidateId: competing.candidateId,
      expectedVersion: replacement.version,
    }),
  ).resolves.toMatchObject({
    outcome: "committed",
    parentHead: "commit:1",
    head: "commit:2",
  });
  await expect(
    corrections.begin({
      worldId,
      operationId: "correction-competing",
      mode: "materials",
    }),
  ).rejects.toThrow(/cannot be reused/u);
});

test("候选初始化失败会释放 operation reservation", async () => {
  const { store, corrections } = await world();
  await expect(
    corrections.begin({
      worldId: "world-does-not-exist",
      operationId: "correction-begin-failed",
      mode: "documents",
    }),
  ).rejects.toBeTruthy();
  await expect(
    store.getOperationOutcome("correction-begin-failed"),
  ).resolves.toEqual({ outcome: "not_started" });
});

test("候选 revision 初始化异常会释放 reservation、control 与持久 world claim", async () => {
  const { root, worldId } = await world();
  const store = new OneShotRevisionFailureWorldStore(root);
  const corrections = new FileNativeContinuityCorrection(store);

  await expect(
    corrections.begin({
      worldId,
      operationId: "correction-revision-init-failed",
      mode: "documents",
    }),
  ).rejects.toThrow(/simulated revision initialization failure/u);
  await expect(
    store.getOperationOutcome("correction-revision-init-failed"),
  ).resolves.toEqual({ outcome: "not_started" });

  const retried = await corrections.begin({
    worldId,
    operationId: "correction-revision-init-failed",
    mode: "documents",
  });
  await corrections.cancel(retried.candidateId, retried.version);
});

test("并发使用同一 operation ID 只能原子保留一个修正候选", async () => {
  const { corrections, worldId } = await world();
  const results = await Promise.allSettled([
    corrections.begin({
      worldId,
      operationId: "correction-concurrent",
      mode: "documents",
    }),
    corrections.begin({
      worldId,
      operationId: "correction-concurrent",
      mode: "documents",
    }),
  ]);
  expect(results.map(({ status }) => status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const fulfilled = results.find(
    (
      result,
    ): result is PromiseFulfilledResult<{
      candidateId: string;
      version: number;
      parentHead: string;
    }> => result.status === "fulfilled",
  );
  if (fulfilled === undefined)
    throw new Error("Expected one correction candidate to be created");
  await corrections.cancel(
    fulfilled.value.candidateId,
    fulfilled.value.version,
  );
});

async function world() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-correction-"));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const created = await store.createFromContentPackage({
    operationId: "create",
    sourcePackageId: "package",
    sourcePackageTitle: "Test content package",
    packageFiles: files(),
    prompt: prompt(),
  });
  return {
    root,
    store,
    corrections: new FileNativeContinuityCorrection(store),
    worldId: created.world.worldId,
  };
}

function prompt() {
  return {
    hostBinding: {
      hostPresetId: "host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
      },
    },
    modelBinding: {
      provider: "chat_completions" as const,
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  };
}

class OneShotRevisionFailureWorldStore extends FileNativeWorldStore {
  #fail = true;

  override async bindPlayCallChain(worldId: string) {
    const binding = await super.bindPlayCallChain(worldId);
    if (!this.#fail) return binding;
    this.#fail = false;
    return {
      ...binding,
      files: new Proxy(binding.files, {
        ownKeys() {
          throw new Error("simulated revision initialization failure");
        },
      }),
    };
  }
}

function files(): ContentTreeFile[] {
  return [
    {
      path: "opening.md",
      contents: "你站在安静的房间里，面前的局面正等你回应。\n",
    },
    {
      path: "world/current.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`,
    },
    {
      path: "world/characters/alex.yaml",
      contents: `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: 篮球队前锋。\n  aliases: []\n衣着: 白色背心\n`,
    },
    {
      path: "world/rules/lore.md",
      contents: `---\n$document:\n  id: rule.world-lore\n  ref: world-lore\n  title: 世界掌故\n  summary: 一份长篇世界规则。\n  aliases: []\n---\n# 世界掌故\n\n\`\`\`md\n## 真实规则\n伪标题正文。\n\`\`\`\n\n## 真实规则\n\n旧正文。\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World Rules\n\nWrite durable outcomes back to their natural owner.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: 当前状态\n    items:\n      - id: clothes\n        label: 衣着\n        select: { document: character.alex, locator: { yaml: [衣着] } }\n`,
    },
  ];
}
