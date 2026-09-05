// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { OrderedPlayPromptEditor } from "../../src/web/OrderedPlayPromptEditor.tsx";
import {
  defaultOrderedPlayPrompts,
  type OrderedPlayPrompt,
} from "../../src/shared/ordered-play-prompts.ts";
import { setWebLocale } from "../../src/web/i18n.ts";
afterEach(() => {
  cleanup();
  setWebLocale("zh-CN");
});
test("authors clone readonly recommendations, disable originals, and reorder with keyboard", () => {
  function Editor() {
    const [entries, setEntries] = useState<OrderedPlayPrompt[]>(
      defaultOrderedPlayPrompts(),
    );
    return createElement(OrderedPlayPromptEditor, {
      entries,
      onChange: setEntries,
    });
  }
  setWebLocale("en");
  render(createElement(Editor));
  fireEvent.click(screen.getByRole("button", { name: "State maintenance" }));
  expect(
    screen.getByLabelText<HTMLTextAreaElement>("Prompt text").readOnly,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clone prompt" }));
  fireEvent.change(screen.getByLabelText("Prompt name"), {
    target: { value: "My policy" },
  });
  fireEvent.change(screen.getByLabelText("Prompt text"), {
    target: { value: "My independent text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Move up" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Prompt text").value).toBe(
    "My independent text",
  );
  fireEvent.click(screen.getByRole("button", { name: "State maintenance" }));
  fireEvent.click(screen.getByLabelText("Enabled"));
  expect(screen.getByLabelText<HTMLInputElement>("Enabled").checked).toBe(
    false,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Complete world prompt" }),
  );
  expect(screen.queryByLabelText("Prompt text")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete prompt" })).toBeNull();
});

test.each(["keyboard", "drag"] as const)(
  "%s moves the complete world placeholder ahead of required mechanics",
  (mode) => {
    function Editor() {
      const [entries, setEntries] = useState<OrderedPlayPrompt[]>([
        {
          id: "mechanics",
          kind: "builtin",
          builtin: "play.mechanics",
          enabled: true,
        },
        { id: "world", kind: "world" },
      ]);
      return createElement(OrderedPlayPromptEditor, {
        entries,
        onChange: setEntries,
      });
    }
    setWebLocale("en");
    render(createElement(Editor));
    const world = screen.getByRole("button", { name: "Complete world prompt" });
    if (mode === "keyboard")
      fireEvent.keyDown(world, { key: "ArrowUp", altKey: true });
    else {
      fireEvent.dragStart(world.closest("li")!);
      fireEvent.dragOver(screen.getAllByRole("listitem")[0]!);
      fireEvent.drop(screen.getAllByRole("listitem")[0]!);
    }
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      "Complete world prompt",
      "Tools and response settlement (required)",
    ]);
  },
);
