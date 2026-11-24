import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { gameplayFile } from "../../src/protocol/gameplay.ts";
import { expect, test } from "vitest";

import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { sampleContentPackageForLocale } from "../../src/shared/sample-packages/index.ts";

for (const locale of ["en", "zh-CN"] as const) {
  for (const source of ["new", "tabletop", "sample"] as const) {
    test(`${locale} ${source} continuity is visible, selectively readable, and safely writable`, () => {
      const files =
        source === "sample"
          ? sampleContentPackageForLocale(locale).files
          : [
              ...minimalFileNativeContentScaffold(locale),
              ...(source === "tabletop"
                ? [gameplayFile({ mode: "tabletop", scheme: "d20" })]
                : []),
            ];
      expect(inspectContentPackageCurrentTree(files).issues).toEqual([]);
      const worldBlock =
        files.find(({ path }) => path === "control/blocks/world.md")
          ?.contents ?? "";
      if (locale === "zh-CN") {
        expect(worldBlock).not.toContain("叙事提交前");
        expect(worldBlock).toContain("## 连续性文档与保存位置");
        expect(worldBlock).toContain("持续变化需要保存时");
        expect(worldBlock).toContain("`@pending-matters` 的“未了事项”");
        expect(worldBlock).toContain(
          'context_read({ref: "@relationships#/人物/人物键"})',
        );
        expect(worldBlock).toContain(
          'context_read({ref: "@important-events#/事件/事件键"})',
        );
        expect(worldBlock).toContain("新增键前先读父节点");
        expect(worldBlock).toContain(
          "人物文档的“认知”段只记影响该人物行动的内容",
        );
      } else {
        expect(worldBlock).not.toContain("Before submitting narration");
        expect(worldBlock).toContain(
          "## Continuity documents and save locations",
        );
        expect(worldBlock).toContain("When a lasting change needs to be saved");
        expect(worldBlock).toContain(
          "In @pending-matters, the pending mapping",
        );
        expect(worldBlock).toContain(
          'context_read({ref: "@relationships#/people/person-key"})',
        );
        expect(worldBlock).toContain(
          'context_read({ref: "@important-events#/events/event-key"})',
        );
        expect(worldBlock).toContain("read the parent node before adding keys");
        expect(worldBlock).toContain(
          "A character document's Knowledge section records only what affects that character's actions",
        );
      }
      const events = locale === "en" ? "events" : "事件";
      const people = locale === "en" ? "people" : "人物";
      const pending = locale === "en" ? "pending" : "未了事项";
      const state = Object.fromEntries(
        files.map(({ path, contents }) => [
          path.replace(/^world\//u, "state/"),
          contents
            .replace(
              `${events}: {}`,
              `${events}:\n  old-promise:\n    account: EVENT_PRIVATE_ACCOUNT\n  unrelated:\n    account: EVENT_UNRELATED_ACCOUNT`,
            )
            .replace(
              `${people}: {}`,
              `${people}:\n  alex:\n    trust: RELATION_PRIVATE_REASON\n  robin:\n    trust: RELATION_UNRELATED_REASON`,
            )
            .replace(
              `${pending}: {}`,
              `${pending}:\n  return-key: ACTIVE_RETURN_KEY`,
            ),
        ]),
      );
      const documents = new FileNativePlayDocuments(state);
      const input = createMinimalFileNativePreviewInput({
        locale,
        provider: "chat_completions",
        modelId: "continuity-test",
        contextWindowTokens: 128000,
        maxOutputTokens: 4096,
        playerInput: "Return the key.",
        playerInputPlacement: "append",
      });
      input.world.documentSnapshot = documents.snapshot;
      const compiled = new FileNativePromptCompiler({
        locale,
      }).compileBootstrap(input);
      const text = compiled.logicalMessages
        .map(({ markdown }) => markdown)
        .join("\n");
      for (const ref of [
        "@important-events",
        "@relationships",
        "@pending-matters",
        "@current-situation",
      ])
        expect(text).toContain(ref);
      expect(text).toContain(
        locale === "zh-CN"
          ? "按人物稳定键保存各人对彼此的信任、立场、义务、边界及依据（单向分开记录）。"
          : "One-way trust, stance, obligations, boundaries, and reasons indexed by stable person keys.",
      );
      expect(text).toContain("ACTIVE_RETURN_KEY");
      for (const secret of [
        "EVENT_PRIVATE_ACCOUNT",
        "EVENT_UNRELATED_ACCOUNT",
        "RELATION_PRIVATE_REASON",
        "RELATION_UNRELATED_REASON",
      ])
        expect(text).not.toContain(secret);
      documents.bindBootstrap(compiled);
      const execute = (name: string, args: unknown) =>
        documents.execute({ id: name, name, arguments: args }, [], { locale });
      for (const [ref, key, value, unrelated] of [
        [
          "important-events",
          events,
          "EVENT_PRIVATE_ACCOUNT",
          "EVENT_UNRELATED_ACCOUNT",
        ],
        [
          "relationships",
          people,
          "RELATION_PRIVATE_REASON",
          "RELATION_UNRELATED_REASON",
        ],
      ]) {
        const entry = ref === "important-events" ? "old-promise" : "alex";
        const receipt = execute("context_read", {
          ref: `@${ref}#/${key}/${entry}`,
        });
        expect(receipt.ok).toBe(true);
        expect(receipt.markdown).toContain(value);
        expect(receipt.markdown).not.toContain(unrelated);
        const add = {
          target: `@${ref}`,
          edits: [
            {
              op: "add",
              locator: { yaml: [key, "new-entry"] },
              value: { reason: "New established result" },
            },
          ],
        };
        expect(execute("world_patch", add).ok).toBe(false);
        expect(execute("context_read", { ref: `@${ref}#/${key}` }).ok).toBe(
          true,
        );
        expect(execute("world_patch", add).ok).toBe(true);
      }
      expect(
        execute("world_patch", {
          target: "@pending-matters",
          edits: [{ op: "remove", locator: { yaml: [pending, "return-key"] } }],
        }).ok,
      ).toBe(true);
    });
  }
}

test.each(["en", "zh-CN"] as const)(
  "%s ordinary creation routes publish continuity files",
  async (locale) => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-continuity-"));
    try {
      const workspace = new ContentWorkspace(root, { locale: () => locale });
      for (const create of [
        () => workspace.createCurrentTreeContentPackage(),
        () =>
          workspace.createCurrentTreeContentPackage({
            mode: "tabletop",
            scheme: "d20",
          }),
        () => workspace.createSampleContentPackage(locale),
      ]) {
        const created = await create();
        const detail = await workspace.readCurrentTreeContentPackage(
          created.localId,
        );
        expect(detail.status).toBe("usable");
        expect(detail.documents.map(({ path }) => path)).toEqual(
          expect.arrayContaining([
            "world/continuity/important-events.yaml",
            "world/continuity/relationships.yaml",
            "world/continuity/pending-matters.yaml",
          ]),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
