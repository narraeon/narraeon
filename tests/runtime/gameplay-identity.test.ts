import { expect, test } from "vitest";

import {
  assertSameGameplay,
  assertSameGameplayMode,
  gameplayFile,
  gameplayLabel,
  gameplayPath,
  parseGameplay,
  readGameplay,
} from "../../src/protocol/gameplay.ts";

const tabletopD100 = JSON.stringify({
  format: "narraeon.gameplay/v1",
  mode: "tabletop",
  scheme: "d100",
});

test("缺少 control/gameplay.json 时默认是互动式小说", () => {
  expect(readGameplay([])).toEqual({ mode: "interactive-fiction" });
  expect(
    readGameplay([{ path: "control/frame.yaml", contents: "format: x" }]),
  ).toEqual({ mode: "interactive-fiction" });
});

test("规范的 UTF-8 文件读出跑团模式与判定方案", () => {
  expect(
    readGameplay([{ path: gameplayPath, contents: tabletopD100 }]),
  ).toEqual({ mode: "tabletop", scheme: "d100" });
  expect(
    readGameplay([
      {
        path: gameplayPath,
        contents: JSON.stringify({
          format: "narraeon.gameplay/v1",
          mode: "interactive-fiction",
        }),
      },
    ]),
  ).toEqual({ mode: "interactive-fiction" });
});

test("玩法文件必须规范、UTF-8、精确字段，并拒绝未知取值", () => {
  const invalid: {
    files: { path: string; contents: string; encoding?: string }[];
    pattern: RegExp;
  }[] = [
    {
      files: [{ path: "Control/gameplay.json", contents: tabletopD100 }],
      pattern: /canonical UTF-8/u,
    },
    {
      files: [
        { path: gameplayPath, contents: tabletopD100, encoding: "base64" },
      ],
      pattern: /canonical UTF-8/u,
    },
    {
      files: [
        { path: gameplayPath, contents: tabletopD100 },
        { path: gameplayPath, contents: tabletopD100 },
      ],
      pattern: /canonical UTF-8/u,
    },
    {
      files: [{ path: gameplayPath, contents: "{ not json" }],
      pattern: /valid JSON/u,
    },
    {
      files: [{ path: gameplayPath, contents: "[]" }],
      pattern: /Invalid gameplay identity/u,
    },
    {
      files: [
        {
          path: gameplayPath,
          contents: JSON.stringify({
            format: "narraeon.gameplay/v0",
            mode: "tabletop",
            scheme: "d20",
          }),
        },
      ],
      pattern: /Unknown gameplay format/u,
    },
    {
      files: [
        {
          path: gameplayPath,
          contents: JSON.stringify({
            format: "narraeon.gameplay/v1",
            mode: "tabletop",
            scheme: "d6",
          }),
        },
      ],
      pattern: /Unknown gameplay type or resolution scheme/u,
    },
    {
      files: [
        {
          path: gameplayPath,
          contents: JSON.stringify({
            format: "narraeon.gameplay/v1",
            mode: "tabletop",
          }),
        },
      ],
      pattern: /Unknown gameplay type or resolution scheme/u,
    },
    {
      files: [
        {
          path: gameplayPath,
          contents: JSON.stringify({
            format: "narraeon.gameplay/v1",
            mode: "interactive-fiction",
            scheme: "d20",
          }),
        },
      ],
      pattern: /Unknown gameplay type or resolution scheme/u,
    },
    {
      files: [
        {
          path: gameplayPath,
          contents: JSON.stringify({
            format: "narraeon.gameplay/v1",
            mode: "tabletop",
            scheme: "d20",
            extra: true,
          }),
        },
      ],
      pattern: /Unknown gameplay type or resolution scheme/u,
    },
  ];

  for (const { files, pattern } of invalid)
    expect(() => readGameplay(files)).toThrow(pattern);
});

test("gameplayFile 以固定 JSON 形式序列化，并能被原样读回", () => {
  const file = gameplayFile({ mode: "tabletop", scheme: "d100" });

  expect(file).toEqual({
    path: gameplayPath,
    contents:
      '{\n  "format": "narraeon.gameplay/v1",\n  "mode": "tabletop",\n  "scheme": "d100"\n}\n',
  });
  expect(readGameplay([file])).toEqual({ mode: "tabletop", scheme: "d100" });
  expect(gameplayFile({ mode: "interactive-fiction" }).contents).toBe(
    '{\n  "format": "narraeon.gameplay/v1",\n  "mode": "interactive-fiction"\n}\n',
  );
});

test("内容编辑可以改判定方案，但不能改玩法模式", () => {
  const d20 = [
    {
      path: gameplayPath,
      contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
    },
  ];
  const bag = [
    {
      path: gameplayPath,
      contents: gameplayFile({ mode: "tabletop", scheme: "bag" }).contents,
    },
  ];
  const fiction = [{ path: "opening.md", contents: "开场" }];

  expect(() => assertSameGameplayMode(d20, bag)).not.toThrow();
  expect(() => assertSameGameplayMode(d20, fiction)).toThrow(
    /Gameplay mode is fixed/u,
  );
  expect(() => assertSameGameplayMode(fiction, d20)).toThrow(
    /Gameplay mode is fixed/u,
  );
  expect(() => assertSameGameplayMode(fiction, fiction)).not.toThrow();
});

test("世界要求模式与判定方案都不变", () => {
  const d20 = [
    {
      path: gameplayPath,
      contents: gameplayFile({ mode: "tabletop", scheme: "d20" }).contents,
    },
  ];
  const d100 = [
    {
      path: gameplayPath,
      contents: gameplayFile({ mode: "tabletop", scheme: "d100" }).contents,
    },
  ];
  const fiction: { path: string; contents: string }[] = [];

  expect(() => assertSameGameplay(d20, d20)).not.toThrow();
  expect(() => assertSameGameplay(d20, d100)).toThrow(/fixed/u);
  expect(() => assertSameGameplay(d20, fiction)).toThrow(/fixed/u);
  expect(() => assertSameGameplay(fiction, fiction)).not.toThrow();
});

test("玩法标签按语言显示模式与方案", () => {
  expect(gameplayLabel({ mode: "interactive-fiction" }, "zh-CN")).toBe(
    "互动式小说",
  );
  expect(gameplayLabel({ mode: "interactive-fiction" }, "en")).toBe(
    "Interactive fiction",
  );
  expect(gameplayLabel({ mode: "tabletop", scheme: "d20" }, "zh-CN")).toBe(
    "跑团 · d20",
  );
  expect(gameplayLabel({ mode: "tabletop", scheme: "d100" }, "en")).toBe(
    "Tabletop · d100",
  );
  expect(gameplayLabel({ mode: "tabletop", scheme: "bag" }, "zh-CN")).toBe(
    "跑团 · 混乱袋",
  );
  expect(gameplayLabel({ mode: "tabletop", scheme: "bag" }, "en")).toBe(
    "Tabletop · Chaos bag",
  );
});

test("parseGameplay 只接受显式的模式与方案", () => {
  expect(parseGameplay({ mode: "interactive-fiction" })).toEqual({
    mode: "interactive-fiction",
  });
  expect(parseGameplay({ mode: "tabletop", scheme: "d20" })).toEqual({
    mode: "tabletop",
    scheme: "d20",
  });
  expect(() => parseGameplay(null)).toThrow(/玩法选择无效/u);
  expect(() => parseGameplay({ mode: "tabletop" })).toThrow(/判定方案/u);
});
