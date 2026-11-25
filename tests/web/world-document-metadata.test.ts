import { expect, test } from "vitest";

import { inspectDocumentFile } from "../../src/shared/world-documents/WorldDocumentCodec.ts";
import { revisionBaseDocumentIds } from "../../src/web/world-document-draft.ts";
import {
  readWorldDocumentMetadata,
  type MetadataEdit,
} from "../../src/web/world-document-metadata.ts";

function change(
  source: string,
  codec: "yaml" | "markdown",
  edit: MetadataEdit,
): string {
  const metadata = readWorldDocumentMetadata(source, codec);
  expect(metadata).not.toBeNull();
  const next = metadata!.edit(edit);
  expect(next).not.toBeNull();
  return next!;
}

const header =
  "$document:\n  id: doc.harbor\n  ref: harbor\n  title: Harbor\n  summary: A short summary\n";

test("allows unusual YAML string values and keeps the comments in an edited flow alias list", () => {
  const body = "# remaining authored comment\nWeather:   sunny\n";
  const source = `${header}  aliases: [Dock, # first alias\n    Pier, # last alias\n  ]\n${body}`;
  const updated = change(source, "yaml", {
    field: "alias",
    index: 1,
    value: 'new: [text] " #\n第二行',
  });
  expect(updated).toContain("[Dock, # first alias\n");
  expect(updated).toContain(", # last alias\n");
  const removedFirst = change(updated, "yaml", {
    field: "removeAlias",
    index: 0,
  });
  const removedLast = change(removedFirst, "yaml", {
    field: "removeAlias",
    index: 0,
  });
  const added = change(removedLast, "yaml", { field: "appendAlias" });
  const next = change(added, "yaml", {
    field: "alias",
    index: 0,
    value: "false",
  });
  const inspected = inspectDocumentFile(
    { path: "world/harbor.yaml", contents: next },
    "world",
  );
  expect(inspected.diagnostics).toEqual([]);
  expect(inspected.descriptor?.aliases).toEqual(["false"]);
  expect(next).toContain("# first alias\n");
  expect(next).toContain("# last alias\n");
  expect(next.endsWith(body)).toBe(true);
});

test("replaces a folded scalar and keeps its original comment and following data", () => {
  const source = `${header.replace("A short summary\n", ">+ # Metadata note\n    Old\n    description\n\n")}  aliases: []\n# Keep me\nweather:   calm # Forecast\n`;
  const next = change(source, "yaml", {
    field: "summary",
    value: "A summary\nthat spans lines.",
  });
  expect(next).toBe(
    `${header.replace("A short summary\n", '"A summary\\nthat spans lines." # Metadata note\n\n')}  aliases: []\n# Keep me\nweather:   calm # Forecast\n`,
  );
  expect(
    inspectDocumentFile({ path: "state/harbor.yaml", contents: next }, "state")
      .descriptor?.summary,
  ).toBe("A summary\nthat spans lines.");
});

test("matches Runtime headings, keeps fenced examples and trailing whitespace, and allows literal final hashes", () => {
  const body =
    "Preamble  \n```\n# decoy\n```\n  #\tHarbor  \n\n## Lower section\nfree text  \n\n";
  const source = `---\n${header}  aliases: []\n---\n${body}`;
  const summary = change(source, "markdown", {
    field: "summary",
    value: "New summary",
  });
  expect(summary.split("\n---\n")[1]).toBe(body);
  const cleared = change(summary, "markdown", { field: "title", value: "" });
  expect(cleared.split("\n---\n")[1]).toBe(body);
  const renamed = change(cleared, "markdown", {
    field: "title",
    value: "Another harbor ##",
  });
  expect(renamed.split("\n---\n")[1]).toBe(
    body.replace("#\tHarbor  ", "#\tAnother harbor ## #  "),
  );
  const inspected = inspectDocumentFile(
    { path: "state/harbor.md", contents: renamed },
    "state",
  );
  expect(inspected.diagnostics).toEqual([]);
  expect(inspected.descriptor?.documentId).toBe("doc.harbor");
});

test.each([
  "$document: {id: doc.one, ref: harbor, title: Harbor, summary: Introduction, aliases: [], custom: 4}\n",
  `${header}  aliases: []\nweather: &anchor calm\n`,
  `${header}  aliases: []\nweather: [draft`,
  `weather: clear\n${header}  aliases: []\n`,
])(
  "leaves unsupported and incomplete YAML available for source repair",
  (source) => {
    expect(readWorldDocumentMetadata(source, "yaml")).toBeNull();
  },
);

test("identifies published revision documents across moves and excludes saved additions", () => {
  const contents = `${header}  aliases: []\n`;
  const oldPath = "state/places/harbor.yaml";
  const moved = "state/places/moved.yaml";
  const added = "state/places/dock.yaml";
  const addContents = contents.replace("doc.harbor", "doc.dock");
  expect(
    revisionBaseDocumentIds(
      [
        { path: moved, contents },
        { path: added, contents: addContents },
      ],
      [
        { path: oldPath, kind: "delete", before: contents, after: null },
        { path: moved, kind: "create", before: null, after: contents },
        { path: added, kind: "create", before: null, after: addContents },
      ],
    ),
  ).toEqual(new Set(["doc.harbor"]));
});
