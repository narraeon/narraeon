import { afterEach, expect, test, vi } from "vitest";

import type { ContentTreeFile } from "../../src/protocol/v1.ts";
import * as restrictedYaml from "../../src/shared/restricted-yaml.ts";
import {
  createAuthoringFileSearch,
  orderAuthoringFiles,
} from "../../src/web/authoring-file-list.ts";

afterEach(() => vi.restoreAllMocks());

test("searches the document header and leaves every file reachable by path", () => {
  const search = createAuthoringFileSearch("content-package");
  const files: ContentTreeFile[] = [
    {
      path: "world/location.yml",
      contents:
        '$document:\n  title: "Paper \\u706f"\n  ref: waterfront\nbody:\n  title: Body title\n',
    },
    {
      path: "world/captain.md",
      contents:
        "---\n$document: { title: Captain Mae, ref: fog }\n---\n\n# Captain Mae\n",
    },
    { path: "world/broken.yaml", contents: "$document: {" },
    {
      path: "control/deck.md",
      contents: "---\n$document: { title: Private, ref: deck }\n---\n",
    },
    { path: "assets/map.png", contents: "AA==", encoding: "base64" },
  ];

  expect(search(files, "  PAPER 灯  ")).toEqual([files[0]]);
  expect(search(files, "＠ＷＡＴＥＲ")).toEqual([files[0]]);
  expect(search(files, "captain mae")).toEqual([files[1]]);
  expect(search(files, "@fog")).toEqual([files[1]]);
  expect(search(files, "Body title")).toEqual([]);
  expect(search(files, "Private")).toEqual([]);
  expect(search(files, "BROKEN.YAML")).toEqual([files[2]]);
  expect(search(files, "map.png")).toEqual([files[4]]);
});

test("a large package indexes its YAML headers once and only reindexes changed files", () => {
  const parse = vi.spyOn(restrictedYaml, "parseRestrictedYamlDocument");
  const search = createAuthoringFileSearch("content-package");
  const body = `body: ${"x".repeat(24_000)}\n`;
  const files = orderAuthoringFiles(
    Array.from({ length: 1024 }, (_, index) => ({
      path: `world/files/${index}.yaml`,
      contents: `$document:\n  title: Note ${index}\n  ref: note-${index}\n${body}`,
    })),
    "content-package",
  );
  expect(search(files, "")).toBe(files);
  expect(parse).not.toHaveBeenCalled();
  expect(search(files, "note")).toHaveLength(1024);
  expect(parse).toHaveBeenCalledTimes(1024);
  expect(parse.mock.calls.every(([contents]) => contents.length <= 64)).toBe(
    true,
  );

  for (const query of ["Note 1", "Note 12", "Note 123", "@note-1"])
    expect(search(files, query).length).toBeGreaterThan(0);
  expect(parse).toHaveBeenCalledTimes(1024);

  const changed = files.map((file) => ({ ...file }));
  changed[0]!.contents = changed[0]!.contents.replace("Note 0", "New title");
  expect(search(changed, "Note 0")).toEqual([]);
  expect(search(changed, "New title")).toEqual([changed[0]]);
  expect(parse).toHaveBeenCalledTimes(1025);
});
