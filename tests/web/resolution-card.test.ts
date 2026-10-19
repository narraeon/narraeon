// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test } from "vitest";

import type {
  BagReceipt,
  D20Receipt,
  DiceReceipt,
} from "../../src/protocol/resolution.ts";
import { setWebLocale } from "../../src/web/i18n.ts";
import { ResolutionCard } from "../../src/web/ResolutionCard.tsx";

function textOf(element: Element | null): string {
  return element?.textContent ?? "";
}

afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});

const d20: D20Receipt = {
  kind: "d20",
  goal: "推开石门",
  modifier: 3,
  difficulty: 15,
  mode: "advantage",
  dice: [12, 18],
  selected: 18,
  total: 21,
  margin: 6,
  outcome: "critical_success",
};

const bag: BagReceipt = {
  kind: "bag",
  goal: "推开石门",
  value: 3,
  difficulty: 2,
  defaultBag: false,
  tokens: [
    { label: "+1", count: 2, modifier: 1 },
    { label: "骷髅", count: 1, outcome: "critical_failure" },
  ],
  drawn: { label: "−1", modifier: -1 },
  total: 2,
  margin: 0,
  outcome: "success",
};

const dice: DiceReceipt = {
  kind: "dice",
  goal: "推开石门",
  count: 2,
  sides: 6,
  modifier: 1,
  dice: [3, 5],
  total: 9,
};

describe("判定结果卡片", () => {
  test("折叠行按结果着色并始终包含结果词，展开后列出每个输入", () => {
    const { container } = render(
      createElement(ResolutionCard, { receipt: d20 }),
    );

    const card = screen.getByRole("article", { name: "判定结果" });
    expect(card.className).toContain("is-critical_success");
    expect(textOf(card)).toContain(
      "推开石门 · d20 优势 12/18 取 18 + 3 = 21 ≥ 15 · 大成功",
    );
    expect(
      card.querySelector<HTMLElement>(".resolution-outcome")?.textContent,
    ).toBe("大成功");
    expect(container.querySelector("details")?.open).toBe(false);

    const diceLabel = Array.from(container.querySelectorAll("dt")).find(
      (term) => term.textContent === "掷出的骰",
    );
    expect(diceLabel?.nextElementSibling?.textContent).toBe("12、18");
    expect(screen.getByText("差值（总值 − 难度）")).toBeTruthy();
    expect(screen.getByText("+6")).toBeTruthy();
    expect(screen.getByText("大成功", { selector: "dd" })).toBeTruthy();
  });

  test("混乱袋展示整袋标记表与是否为默认袋", () => {
    render(createElement(ResolutionCard, { receipt: bag }));

    const card = screen.getByRole("article", { name: "判定结果" });
    expect(textOf(card)).toContain(
      "推开石门 · 抽到 −1 · 3 + (−1) = 2 ≥ 2 · 成功",
    );
    expect(screen.getByText("世界混乱袋")).toBeTruthy();
    const table = card.querySelector("table");
    expect(table).not.toBeNull();
    const rows = within(table!)
      .getAllByRole("row")
      .map((row) => row.textContent);
    expect(rows).toEqual(["标记数量效果", "+12+1", "骷髅1大失败"]);
  });

  test("骰子与算术没有结果词，也没有混乱袋表", () => {
    const { rerender, container } = render(
      createElement(ResolutionCard, { receipt: dice }),
    );
    const card = screen.getByRole("article", { name: "判定结果" });
    expect(card.className).toContain("is-neutral");
    expect(textOf(card)).toContain("推开石门 · 2d6+1 = 3 + 5 + 1 = 9");
    expect(container.querySelector(".resolution-outcome")).toBeNull();
    expect(container.querySelector("table")).toBeNull();

    rerender(
      createElement(ResolutionCard, {
        receipt: {
          kind: "arithmetic",
          goal: "推开石门",
          left: 3,
          right: 4,
          operation: "multiply",
          total: 12,
        },
      }),
    );
    expect(textOf(screen.getByRole("article", { name: "判定结果" }))).toContain(
      "推开石门 · 3 × 4 = 12",
    );
  });

  test("英文界面使用英文标签、结果词与标记表标题", () => {
    setWebLocale("en");
    render(createElement(ResolutionCard, { receipt: bag }));

    const card = screen.getByRole("article", { name: "Resolution result" });
    expect(textOf(card)).toContain(
      "推开石门 · Drew −1 · 3 + (−1) = 2 ≥ 2 · Success",
    );
    expect(screen.getByText("Chaos bag used for this check")).toBeTruthy();
    expect(screen.getByText("World chaos bag")).toBeTruthy();
    expect(screen.getByText("Critical failure")).toBeTruthy();
  });
});
