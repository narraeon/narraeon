import { describe, expect, test } from "vitest";
import { stringify } from "yaml";

import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import { PlayerViewRenderer } from "../../src/shared/PlayerViewRenderer.ts";
import {
  createSourceRangeReader,
  sourceRange,
} from "../../src/shared/world-documents/WorldDocumentSource.ts";
import type { WorldDocumentFile } from "../../src/shared/world-documents/WorldDocumentTypes.ts";
import { buildPlayerViewDraft } from "../../src/web/player-view-draft.ts";

const playerViewsPath = "control/player-views.yaml";
const header = (ref: string, title = ref) => `$document:
  id: test.${ref}
  ref: ${ref}
  title: ${title}
  summary: Authoring test fixture.
  aliases: []
`;

function control(selections: [string, Record<string, unknown>][]): string {
  return stringify({
    format: "narraeon.player-views/v1",
    views: [
      {
        id: "sheet",
        title: "记录",
        items: selections.map(([id, select]) => ({ id, label: id, select })),
      },
    ],
  });
}

describe("draft player view selection and production projection", () => {
  test.each([
    ["content_package", "world"],
    ["world_revision", "state"],
  ] as const)(
    "uses unsaved %s YAML, Markdown, and reference targets",
    (layout, root) => {
      const files: WorldDocumentFile[] = [
        {
          path: `${root}/sub/backpack.yml`,
          contents: `${header("backpack", "旅人的背包")}equipment:
  "a.b": {count: 0, equipped: false, owner: {$ref: test.keeper}}
  a: {b: 点号是另一条路径}
  "0": quoted map key
  items:
    - {name: 绳索, count: 3}
    - compass
plain: test.keeper
empty:
long: "${"十".repeat(80)}"
`,
        },
        {
          path: `${root}/keeper.yaml`,
          contents: `${header("keeper", "草稿里的守门人")}private: 不展开引用正文\n`,
        },
        {
          path: `${root}/notes.md`,
          contents: `---\n${header("notes", "笔记")}---\n# 笔记

## 门
门关着。

### 钥匙
还在桌上。

\`\`\`
### 围栏中的字样
\`\`\`

## 窗
窗开着。
`,
        },
        {
          path: `${root === "state" ? "world" : "state"}/unrelated.yaml`,
          contents: header("unrelated"),
        },
        { path: "control/blocks/irrelevant.md", contents: "unrelated" },
      ];
      const source = control([
        ["whole-yaml", { document: "test.backpack" }],
        [
          "list",
          { document: "@backpack", locator: { yaml: ["equipment", "items"] } },
        ],
        [
          "scalar",
          {
            document: "@backpack",
            locator: { yaml: ["equipment", "a.b", "count"] },
          },
        ],
        [
          "exact-key",
          { document: "@backpack", locator: { yaml: ["equipment", "a", "b"] } },
        ],
        [
          "explicit-ref",
          {
            document: "@backpack",
            locator: { yaml: ["equipment", "a.b", "owner"] },
          },
        ],
        ["whole-markdown", { document: "@notes", locator: { markdown: [] } }],
        ["heading", { document: "@notes", locator: { markdown: ["门"] } }],
      ]);
      const draft = buildPlayerViewDraft(files, layout);
      const rendered = draft.render(source);
      const live = new PlayerViewRenderer().render({
        control: source,
        snapshot: WorldDocumentStore.open({ files, layout }),
      });

      expect(draft.documents.map(({ ref }) => ref)).toEqual([
        "@keeper",
        "@notes",
        "@backpack",
      ]);
      expect(draft.resolve("test.backpack")).toBe(draft.resolve("@backpack"));
      expect(draft.choices("@backpack")).toEqual([
        null,
        { yaml: ["equipment"] },
        { yaml: ["equipment", "a.b"] },
        { yaml: ["equipment", "a.b", "count"] },
        { yaml: ["equipment", "a.b", "equipped"] },
        { yaml: ["equipment", "a.b", "owner"] },
        { yaml: ["equipment", "a"] },
        { yaml: ["equipment", "a", "b"] },
        { yaml: ["equipment", "0"] },
        { yaml: ["equipment", "items"] },
        { yaml: ["plain"] },
        { yaml: ["empty"] },
        { yaml: ["long"] },
      ]);
      expect(draft.choices("@notes")).toEqual([
        null,
        { markdown: ["门"] },
        { markdown: ["门", "钥匙"] },
        { markdown: ["窗"] },
      ]);
      expect(
        draft
          .choiceHints("@backpack")
          .get('{"yaml":["equipment","a.b","count"]}'),
      ).toBe("0");
      expect(
        draft
          .choiceHints("@backpack")
          .get('{"yaml":["equipment","a.b","equipped"]}'),
      ).toBe("false");
      expect(
        draft
          .choiceHints("@backpack")
          .has('{"yaml":["equipment","a.b","owner"]}'),
      ).toBe(false);
      expect(draft.choiceHints("@backpack").get('{"yaml":["long"]}')).toBe(
        `${"十".repeat(40)}…`,
      );
      expect(rendered).toEqual(live);
      expect(rendered.diagnostics).toEqual([]);
      expect(rendered.views[0]?.items.map((item) => item.value)).toEqual([
        expect.objectContaining({ plain: "test.keeper", empty: null }),
        [{ name: "绳索", count: 3 }, "compass"],
        0,
        "点号是另一条路径",
        { $ref: "test.keeper", title: "草稿里的守门人", ref: "keeper" },
        expect.stringMatching(/^# 笔记.+## 窗/su),
        "## 门\n门关着。\n\n### 钥匙\n还在桌上。\n\n\`\`\`\n### 围栏中的字样\n\`\`\`",
      ]);
      expect(JSON.stringify(rendered)).not.toContain("不展开引用正文");
      expect(JSON.stringify(rendered)).not.toContain("$document");
    },
  );

  test("keeps usable siblings when an exact selector becomes invalid or ambiguous", () => {
    const files = [
      {
        path: "world/duplicate-one.yaml",
        contents: `${header("duplicate")}value: 1\n`,
      },
      {
        path: "world/duplicate-two.yaml",
        contents: `${header("duplicate").replace("test.duplicate", "test.alternate")}value: 2\n`,
      },
      {
        path: "world/story.md",
        contents: `---\n${header("story", "Story")}---\n# Story\n## Ａ\nOne\n## A\nTwo\n## B\nExact.\n`,
      },
      {
        path: "world/broken.yml",
        contents: `${header("broken")}section:\n  broken: {$ref: test.removed}\n  kept: unchanged\nitems: [one, two]\n`,
      },
      {
        path: "world/raw.yaml",
        contents: `${header("bad")}value: &anchor hi\n`,
      },
    ];
    const draft = buildPlayerViewDraft(files, "content_package");
    const source = control([
      ["duplicate", { document: "@duplicate" }],
      ["ambiguous", { document: "@story", locator: { markdown: ["A"] } }],
      ["dangling", { document: "@broken", locator: { yaml: ["section"] } }],
      ["array-index", { document: "@broken", locator: { yaml: ["items", 0] } }],
      ["wrong-codec", { document: "@broken", locator: { markdown: [] } }],
      [
        "missing-key",
        { document: "@broken", locator: { yaml: ["section", "KepT"] } },
      ],
      ["missing-doc", { document: "@removed" }],
      ["valid-markdown", { document: "@story", locator: { markdown: ["B"] } }],
      [
        "valid-yaml",
        { document: "@broken", locator: { yaml: ["section", "kept"] } },
      ],
    ]);
    const rendered = draft.render(source);

    expect(draft.documents.map(({ ref }) => ref)).toEqual([
      "@broken",
      "@story",
    ]);
    expect(draft.choices("@duplicate")).toEqual([]);
    expect(draft.choices("@story")).toEqual([null, { markdown: ["B"] }]);
    expect(draft.choices("@broken")).toEqual([
      { yaml: ["section", "kept"] },
      { yaml: ["items"] },
    ]);
    expect(rendered.views[0]?.items).toEqual([
      { id: "valid-markdown", label: "valid-markdown", value: "## B\nExact." },
      { id: "valid-yaml", label: "valid-yaml", value: "unchanged" },
    ]);
    expect(
      rendered.diagnostics.map(({ itemId, code }) => [itemId, code]),
    ).toEqual([
      ["duplicate", "unresolved_selector"],
      ["ambiguous", "unresolved_selector"],
      ["dangling", "unresolved_selector"],
      ["array-index", "invalid_control"],
      ["wrong-codec", "unresolved_selector"],
      ["missing-key", "unresolved_selector"],
      ["missing-doc", "unresolved_selector"],
    ]);
    expect(rendered.diagnostics[0]?.message).toContain("ambiguous");
    expect(rendered.diagnostics[1]?.message).toContain("ambiguous");
  });

  test("reuses source inspections across control edits and uses new values on file edits", () => {
    const left = {
      path: "world/left.yaml",
      contents: `${header("left")}value: saved\n`,
    };
    const first = buildPlayerViewDraft([left], "content_package");
    const source = control([
      ["item", { document: "@left", locator: { yaml: ["value"] } }],
    ]);
    const changedControl = source.replace("item", "other");
    expect(
      buildPlayerViewDraft(
        [left, { path: playerViewsPath, contents: changedControl }],
        "content_package",
      ),
    ).toBe(first);
    const second = buildPlayerViewDraft(
      [{ ...left, contents: left.contents.replace("saved", "draft") }],
      "content_package",
    );
    expect(second.render(source).views[0]?.items[0]?.value).toBe("draft");
    expect(first.render(source).views[0]?.items[0]?.value).toBe("saved");
  });

  test("keeps YAML safety and production byte limits in preview", () => {
    const draft = buildPlayerViewDraft(
      [
        {
          path: "state/sheet.yaml",
          contents: `${header("sheet")}long: ${"长".repeat(22 * 1024)}\nsmall: fine\n`,
        },
      ],
      "world_revision",
    );
    const source = control([
      ["large", { document: "@sheet", locator: { yaml: ["long"] } }],
      ["later", { document: "@sheet", locator: { yaml: ["small"] } }],
    ]);
    expect(draft.render(source)).toEqual({
      views: [{ id: "sheet", title: "记录", items: [] }],
      diagnostics: [
        expect.objectContaining({
          code: "capacity_exceeded",
          viewId: "sheet",
          itemId: "large",
        }),
      ],
    });
    const unsafeSources = [
      source.replace("views:", "views: &anchor"),
      source.replace("views:", "views: *alias\nother:"),
      source.replace("views:", "views: !!seq"),
      source.replaceAll("\n", "\r\n"),
      `${source}\nextra: ${"[ ".repeat(70)}hi${" ]".repeat(70)}\n`,
    ];
    for (const unsafe of unsafeSources)
      expect(draft.render(unsafe)).toMatchObject({
        views: [],
        diagnostics: [{ code: "invalid_control" }],
      });
  });
});

test("indexed ranges preserve UTF-16 and UTF-8 coordinates at split surrogates", () => {
  const source = `${"文".repeat(254)}\n💡\n\uD800 unmatched \uDFFF\nend`;
  const rangeAt = createSourceRangeReader(source);
  for (let offset = -1; offset <= source.length + 1; offset += 1)
    expect(rangeAt(offset, offset + 5)).toEqual(
      sourceRange(source, offset, offset + 5),
    );
});
