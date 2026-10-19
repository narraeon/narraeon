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
  expect(
    screen.getByLabelText<HTMLSelectElement>("Message role").disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clone prompt" }));
  expect(
    screen.getByLabelText<HTMLSelectElement>("Message role").disabled,
  ).toBe(false);
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

test("tabletop scope survives cloning, can be toggled on user entries, and is badged", () => {
  const changes: OrderedPlayPrompt[][] = [];
  function Editor() {
    const [entries, setEntries] = useState<OrderedPlayPrompt[]>(
      defaultOrderedPlayPrompts(),
    );
    return createElement(OrderedPlayPromptEditor, {
      entries,
      onChange: (next: OrderedPlayPrompt[]) => {
        changes.push(next);
        setEntries(next);
      },
    });
  }
  setWebLocale("en");
  render(createElement(Editor));

  fireEvent.click(screen.getByRole("button", { name: "Tabletop GM" }));
  expect(screen.getAllByText("Tabletop only").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText("Tabletop worlds only")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Clone prompt" }));
  const cloned = changes
    .at(-1)!
    .find(
      (entry) => entry.kind === "user" && entry.name === "Tabletop GM copy",
    );
  expect(cloned).toMatchObject({ kind: "user", gameplay: "tabletop" });
  const scope = screen.getByLabelText<HTMLInputElement>("Tabletop worlds only");
  expect(scope.checked).toBe(true);

  fireEvent.click(scope);
  expect(
    changes.at(-1)!.find((entry) => entry.id === cloned!.id),
  ).not.toHaveProperty("gameplay");
  expect(
    screen.getByLabelText<HTMLInputElement>("Tabletop worlds only").checked,
  ).toBe(false);

  fireEvent.click(screen.getByLabelText("Tabletop worlds only"));
  expect(
    changes.at(-1)!.find((entry) => entry.id === cloned!.id),
  ).toMatchObject({ gameplay: "tabletop" });
});

test("cloning an unscoped builtin leaves the copy unscoped", () => {
  const changes: OrderedPlayPrompt[][] = [];
  function Editor() {
    const [entries, setEntries] = useState<OrderedPlayPrompt[]>(
      defaultOrderedPlayPrompts(),
    );
    return createElement(OrderedPlayPromptEditor, {
      entries,
      onChange: (next: OrderedPlayPrompt[]) => {
        changes.push(next);
        setEntries(next);
      },
    });
  }
  setWebLocale("en");
  render(createElement(Editor));
  fireEvent.click(screen.getByRole("button", { name: "State maintenance" }));
  fireEvent.click(screen.getByRole("button", { name: "Clone prompt" }));
  const cloned = changes
    .at(-1)!
    .find((entry) => entry.kind === "user" && entry.name.endsWith("copy"));
  expect(cloned).toBeDefined();
  expect(cloned).not.toHaveProperty("gameplay");
  // Only the scoped builtin itself carries the badge; the unscoped copy has none.
  expect(screen.getAllByText("Tabletop only")).toHaveLength(1);
});
