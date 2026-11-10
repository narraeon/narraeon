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
