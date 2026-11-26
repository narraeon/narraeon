import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ModelHostBinding } from "../../src/runtime/model/ModelHost.ts";
import { settleEditorTools } from "../../src/runtime/orchestration/EditorTools.ts";
import { sillyTavernEditorSource } from "../../src/runtime/orchestration/SillyTavernEditorSource.ts";
import { FileNativePlayPresetStore } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { prepareSillyTavernPresetImport } from "../../src/shared/sillytavern-preset.ts";

const snippets = {
  player: "On every player turn, use the active voice.",
  single: "On every single turn, use plain language.",
  new: "For every new round, conserve words.",
  digit: "Use short sentences every 3 turns.",
  word: "Use short sentences every three turns.",
  compound: "Use short sentences every twenty-one turns.",
  other: "Keep prose grounded. Every other turn, review the clues.",
  chinese: "保持简洁。每隔三轮再检查线索。",
  depth: "On every player turn, explain the clue plainly.",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-editor-conditions-"));
  const name = "Cadence fixture";
  const ids = Object.keys(snippets);
  const source = JSON.stringify({
    prompts: Object.entries(snippets).map(([id, content]) => ({
      identifier: id,
      name: id,
      role: "user",
      content,
      ...(id === "depth" ? { injection_position: 1, injection_depth: 4 } : {}),
    })),
    prompt_order: [
      {
        character_id: 100001,
        order: ids.map((identifier) => ({ identifier, enabled: true })),
      },
    ],
  });
  const { conversion, snapshot } = prepareSillyTavernPresetImport(source, {
    name,
    selected: ids,
    locale: "en",
  });
  const store = new FileNativePlayPresetStore(root, { locale: () => "en" });
  const { preset } = await store.importSillyTavern({
    name,
    files: conversion.files,
    snapshot,
  });
  const extension = sillyTavernEditorSource(store);
  const summary = await extension.summarize(preset.id);
  const snapshotId = summary?.snapshotId;
  if (typeof snapshotId !== "string")
    throw new Error("Missing fixture snapshot");
  const target = await store.readEditorDraft(preset.id);
  const binding: ModelHostBinding = {
    provider: "chat_completions",
    modelId: "fixture-model",
    contextWindowTokens: 4096,
    maxOutputTokens: 1024,
    endpointFingerprint: "fixture",
    protocolConfigFingerprint: "fixture",
  };
  const authorization = {
    revision: target.revision,
    epoch: target.epoch,
    head: target.head,
    reads: [],
    sourceSnapshotId: snapshotId,
    sourceEvidence: [],
  };
  const read = (entryId: keyof typeof snippets, limit?: number) =>
    extension.read({
      presetId: preset.id,
      sourceSnapshotId: snapshotId,
      evidence: [],
      call: {
        id: `read-${entryId}`,
        name: "sillytavern_source_read",
        arguments: {
          snapshotId,
          entryId,
          ...(limit === undefined ? {} : { limit }),
        },
      },
    });
  async function edit(
    entryId: keyof typeof snippets,
    enabled: boolean,
    evidence: unknown,
    droppedConditions: string[],
    end: number,
  ) {
    return settleEditorTools({
      target,
      extension,
      calls: [
        {
          id: `edit-${entryId}`,
          name: "orchestration_edit",
          arguments: {
            surface: "playPrompts",
            expectedRevision: target.revision,
            operations: [
              {
                operationId: `op-${entryId}`,
                op: "create",
                entryId: `new-${entryId}`,
                kind: "user",
                name: `Adapted ${entryId}`,
                body: "Prefer short sentences.",
                enabled,
                provenance: {
                  snapshotId,
                  fragments: [{ entryId, offset: 0, end }],
                  rationale: "Extract the portable prose preference.",
                  droppedConditions,
                },
              },
            ],
          },
        },
      ],
      allowedTools: new Set(["orchestration_edit"]),
      modelBinding: binding,
      locale: "en",
      operationAlreadyUsed: () => false,
      authorization: { ...authorization, sourceEvidence: [evidence] },
    });
  }
  return { root, read, edit };
}

test("turn cadence distinguishes ordinary per-turn phrasing from numeric intervals", async () => {
  const { root, read, edit } = await fixture();
  try {
    for (const id of ["player", "single", "new"] as const)
      expect((await read(id)).data, id).toMatchObject({
        entry: { originalConditions: [] },
      });
    for (const id of ["digit", "word", "compound", "other", "chinese"] as const)
      expect((await read(id)).data, id).toMatchObject({
        entry: { originalConditions: ["turn_interval"] },
      });
    const plain = await read("player");
    const enabled = await edit(
      "player",
      true,
      plain.evidence,
      [],
      snippets.player.length,
    );
    expect(
      enabled.publication?.entries.some(
        ({ after }) => after?.id === "new-player" && after.enabled,
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-wide detection names the lost condition and still blocks enabling conditional extracts", async () => {
  const { root, read, edit } = await fixture();
  try {
    const partial = await read("other", 19);
    const missing = await edit("other", false, partial.evidence, [], 19);
    expect(missing.results[0]?.isError).toBe(true);
    expect(missing.results[0]?.markdown).toContain("turn_interval");
    expect(missing.results[0]?.markdown).toContain("UTF-16 offsets");
    expect(missing.results[0]?.markdown).not.toContain("Every other turn");
    const complete = await read("other");
    const fullReceipt = await edit(
      "other",
      false,
      complete.evidence,
      [],
      snippets.other.length,
    );
    expect(fullReceipt.results[0]?.markdown).toContain("Every other turn");

    const blocked = await edit(
      "other",
      true,
      partial.evidence,
      ["Every other turn"],
      19,
    );
    expect(blocked.results[0]?.markdown).toContain(
      "disabled for the author to review",
    );
    expect(blocked.publication).toBeUndefined();
    expect(
      (await edit("other", false, partial.evidence, ["Every other turn"], 19))
        .publication,
    ).toBeDefined();

    const depth = await read("depth");
    expect(depth.data).toMatchObject({
      entry: { originalConditions: ["depth_injection"] },
    });
    const depthAttempt = await edit(
      "depth",
      true,
      depth.evidence,
      [],
      snippets.depth.length,
    );
    expect(depthAttempt.results[0]?.markdown).toContain("depth_injection");
    expect(depthAttempt.publication).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
