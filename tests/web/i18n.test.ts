// @vitest-environment jsdom

import ts from "typescript";
import { afterEach, expect, test } from "vitest";

import { getWebLocale, setWebLocale, uiText } from "../../src/web/i18n.ts";
import i18nSource from "../../src/web/i18n.ts?raw";

afterEach(() => setWebLocale("zh-CN"));

test("English message keys are unique across all registered definitions", () => {
  const file = ts.createSourceFile(
    "src/web/i18n.ts",
    i18nSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = new Map<string, ts.Expression>();
  const registrations: ts.Expression[] = [];
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList
        .declarations) {
        if (ts.isIdentifier(name) && initializer)
          declarations.set(name.text, initializer);
      }
    }
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      continue;
    const {
      expression,
      arguments: [target, ...sources],
    } = statement.expression;
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.expression.getText(file) === "Object" &&
      expression.name.text === "assign" &&
      target?.getText(file) === "englishMessages"
    ) {
      registrations.push(...sources);
    }
  }

  const base = declarations.get("englishMessages");
  if (!base) throw new Error("Missing englishMessages definition");
  expect(registrations.length).toBeGreaterThan(0);
  const locationsByKey = new Map<string, string[]>();
  for (const registration of [base, ...registrations]) {
    const table = ts.isIdentifier(registration)
      ? declarations.get(registration.text)
      : registration;
    if (!table || !ts.isObjectLiteralExpression(table)) {
      throw new Error(
        `Cannot inspect English message table ${registration.getText(file)}`,
      );
    }
    for (const property of table.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      ) {
        throw new Error(
          `Expected a literal English message key at ${property.getText(file)}`,
        );
      }
      const { line, character } = file.getLineAndCharacterOfPosition(
        property.name.getStart(file),
      );
      const key = property.name.text;
      const location = `${file.fileName}:${line + 1}:${character + 1} = ${property.initializer.getText(file)}`;
      const locations = locationsByKey.get(key) ?? [];
      locations.push(location);
      locationsByKey.set(key, locations);
    }
  }

  const duplicates = [...locationsByKey]
    .filter(([, locations]) => locations.length > 1)
    .map(
      ([key, locations]) =>
        `${JSON.stringify(key)}\n  ${locations.join("\n  ")}`,
    );
  expect(
    duplicates.length,
    `Duplicate English message keys:\n${duplicates.join("\n")}`,
  ).toBe(0);
});

test.each([
  ["脚本", "Script"],
  ["脚本文件", "Scripts"],
  ["玩家视图面板", "Player-view panels"],
  ["分组", "Group"],
  ["项目分组", "Groups"],
  ["编排方案", "Orchestration"],
  ["编排方案工作台", "Orchestrations"],
  ["编排方案绑定", "Orchestration binding"],
  ["编排方案 · 冻结修订", "Orchestration · frozen revision"],
  ["字符", "characters"],
  ["正文", "Text"],
  ["提示词正文", "Prompt text"],
  ["全新上下文", "New context"],
])("translates the label %s in context", (chinese, english) => {
  setWebLocale("en");
  expect(uiText(chinese)).toBe(english);
  setWebLocale("zh-CN");
  expect(uiText(chinese)).toBe(chinese);
});

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
