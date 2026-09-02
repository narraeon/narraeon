import { expect, test } from "vitest";

import { buildUnifiedDiffRows } from "../../src/web/UnifiedTextDiffModel.ts";

test("统一差异用红色删除行、绿色新增行和明确行号标记修改", () => {
  expect(
    buildUnifiedDiffRows(
      "title: Old\nsummary: Same\nbody: Before\n",
      "title: New\nsummary: Same\nbody: After\n",
    ),
  ).toEqual([
    {
      kind: "remove",
      marker: "-",
      oldLine: 1,
      newLine: null,
      text: "title: Old",
    },
    {
      kind: "add",
      marker: "+",
      oldLine: null,
      newLine: 1,
      text: "title: New",
    },
    {
      kind: "context",
      marker: " ",
      oldLine: 2,
      newLine: 2,
      text: "summary: Same",
    },
    {
      kind: "remove",
      marker: "-",
      oldLine: 3,
      newLine: null,
      text: "body: Before",
    },
    {
      kind: "add",
      marker: "+",
      oldLine: null,
      newLine: 3,
      text: "body: After",
    },
    {
      kind: "context",
      marker: " ",
      oldLine: 4,
      newLine: 4,
      text: "",
    },
  ]);
});

test("统一差异折叠距离改动很远的未变行", () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const after = [...before];
  after[10] = "changed line";

  const rows = buildUnifiedDiffRows(before.join("\n"), after.join("\n"), 2);

  expect(rows[0]).toEqual({ kind: "skip", count: 8 });
  expect(rows.at(-1)).toEqual({ kind: "skip", count: 7 });
  expect(rows).toContainEqual(
    expect.objectContaining({ kind: "remove", text: "line 11" }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({ kind: "add", text: "changed line" }),
  );
});

test("新建和删除文件会把每行标成新增或删除", () => {
  expect(
    buildUnifiedDiffRows(null, "one\ntwo").map(({ kind }) => kind),
  ).toEqual(["add", "add"]);
  expect(
    buildUnifiedDiffRows("one\ntwo", null).map(({ kind }) => kind),
  ).toEqual(["remove", "remove"]);
});

test("重复行和大范围重排也不会丢失任一侧原文", () => {
  const reversed = Array.from({ length: 400 }, (_, index) => `item ${index}`);
  for (const [before, after] of [
    ["a\nb\na\nc", "a\na\nb\nc"],
    ["first\nsecond\nthird", "zero\nfirst\nthird\nfourth"],
    [reversed.join("\n"), [...reversed].reverse().join("\n")],
  ] satisfies [string, string][]) {
    const rows = buildUnifiedDiffRows(
      before,
      after,
      Number.MAX_SAFE_INTEGER,
    ).filter((row) => row.kind !== "skip");
    expect(
      rows
        .filter(({ kind }) => kind === "context" || kind === "remove")
        .map((row) => row.text)
        .join("\n"),
    ).toBe(before);
    expect(
      rows
        .filter(({ kind }) => kind === "context" || kind === "add")
        .map((row) => row.text)
        .join("\n"),
    ).toBe(after);
  }
});

test("大段重复内容移动一行时仍保留未变上下文", () => {
  const repeated = Array.from({ length: 300 }, () => "same line");
  const rows = buildUnifiedDiffRows(
    ["old heading", ...repeated].join("\n"),
    [...repeated, "new footer"].join("\n"),
    2,
  );

  expect(rows).toContainEqual(
    expect.objectContaining({ kind: "remove", text: "old heading" }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({ kind: "add", text: "new footer" }),
  );
  expect(rows).toContainEqual({ kind: "skip", count: 296 });
  expect(rows.filter(({ kind }) => kind === "context")).toHaveLength(4);
});
