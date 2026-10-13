// @vitest-environment jsdom

import { afterEach, expect, test } from "vitest";

import { getWebLocale, setWebLocale, uiText } from "../../src/web/i18n.ts";

afterEach(() => setWebLocale("zh-CN"));

test("web text follows the active locale and interpolates complete messages", () => {
  setWebLocale("en");
  expect(getWebLocale()).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  expect(uiText("继续游玩")).toBe("Continue playing");
  expect(uiText("AI 如何读取")).toBe("How the model reads");
  expect(uiText("追加不会重新编译世界材料。")).toBe(
    "Appending does not recompile world materials.",
  );
  expect(uiText("调用 {tool}", { tool: "world_patch" })).toBe(
    "Call world_patch",
  );
  expect(
    uiText("第 {round} / {maxRounds} 轮", { round: 3, maxRounds: 64 }),
  ).toBe("Round 3 / 64");

  setWebLocale("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(uiText("调用 {tool}", { tool: "world_patch" })).toBe(
    "调用 world_patch",
  );
});

test("every Chinese uiText literal has an English message", () => {
  const sources = import.meta.glob<string>(
    ["../../src/web/*.{ts,tsx}", "!../../src/web/i18n.ts"],
    { eager: true, import: "default", query: "?raw" },
  );
  const missing = new Set<string>();
  setWebLocale("en");
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/uiText\(\s*"((?:[^"\\]|\\.)*)"/gu)) {
      const chinese = JSON.parse(`"${match[1]}"`) as string;
      if (!/\p{Script=Han}/u.test(chinese)) continue;
      if (uiText(chinese) === chinese) missing.add(`${file}: ${chinese}`);
    }
  }
  expect([...missing]).toEqual([]);
});
