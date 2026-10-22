// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { OrderedPlayPromptEditor } from "../../src/web/OrderedPlayPromptEditor.tsx";
import {
  builtinPlayPrompts,
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
  fireEvent.click(
    screen.getByRole("button", { name: "Save timing and consolidation" }),
  );
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
  fireEvent.click(
    screen.getByRole("button", { name: "Save timing and consolidation" }),
  );
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
      "Tools and response settlement (required)Required",
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
  fireEvent.click(
    screen.getByRole("button", { name: "Save timing and consolidation" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clone prompt" }));
  const cloned = changes
    .at(-1)!
    .find((entry) => entry.kind === "user" && entry.name.endsWith("copy"));
  expect(cloned).toBeDefined();
  expect(cloned).not.toHaveProperty("gameplay");
  // Only the scoped builtin itself carries the badge; the unscoped copy has none.
  expect(screen.getAllByText("Tabletop only")).toHaveLength(1);
});

test("choice groups are exclusive, builtin lines can be overridden or restored, and tail lines join the preview", () => {
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
  const catalog = builtinPlayPrompts("en");
  const defaultLine = (id: string) =>
    catalog.find((item) => item.id === id)!.turnGuide!;
  const enabledOf = (id: string) =>
    changes
      .at(-1)!
      .some(
        (entry) =>
          entry.kind === "builtin" && entry.builtin === id && entry.enabled,
      );
  setWebLocale("en");
  render(createElement(Editor));
  const preview = () =>
    screen.getByLabelText("Turn guide preview").textContent ?? "";
  expect(preview()).toContain(defaultLine("play.person-second"));
  expect(preview()).not.toContain(defaultLine("play.person-first"));

  // Enabling one member of a choice group turns its siblings off.
  fireEvent.click(screen.getByRole("button", { name: "Person: first person" }));
  fireEvent.click(screen.getByLabelText("Enabled"));
  expect(enabledOf("play.person-first")).toBe(true);
  expect(enabledOf("play.person-second")).toBe(false);
  expect(enabledOf("play.person-third")).toBe(false);
  expect(preview()).toContain(defaultLine("play.person-first"));
  expect(preview()).not.toContain(defaultLine("play.person-second"));

  // A builtin's line starts from the catalog default and can be overridden,
  // cleared, or restored.
  fireEvent.click(screen.getByRole("button", { name: "Ending" }));
  const line = screen.getByLabelText<HTMLInputElement>("Turn-guide line");
  expect(line.value).toBe(defaultLine("play.ending"));
  expect(
    screen.queryByRole("button", { name: "Restore default line" }),
  ).toBeNull();
  fireEvent.change(line, {
    target: { value: "Stop on the last spoken line." },
  });
  const ending = () =>
    changes
      .at(-1)!
      .find(
        (entry) => entry.kind === "builtin" && entry.builtin === "play.ending",
      )!;
  expect(ending()).toMatchObject({
    turnGuide: "Stop on the last spoken line.",
  });
  expect(preview()).toContain("Stop on the last spoken line.");
  expect(preview()).not.toContain(defaultLine("play.ending"));
  fireEvent.change(screen.getByLabelText("Turn-guide line"), {
    target: { value: "" },
  });
  expect(ending()).toMatchObject({ turnGuide: "" });
  expect(preview()).not.toContain(defaultLine("play.ending"));
  fireEvent.click(screen.getByRole("button", { name: "Restore default line" }));
  expect(ending()).not.toHaveProperty("turnGuide");
  expect(screen.getByLabelText<HTMLInputElement>("Turn-guide line").value).toBe(
    defaultLine("play.ending"),
  );

  // A tail entry carries only a line, which follows the list position.
  fireEvent.click(screen.getByRole("button", { name: "Add tail line" }));
  fireEvent.change(screen.getByLabelText("Tail line"), {
    target: { value: "Keep the lamp lit." },
  });
  const tail = changes.at(-1)!.find((entry) => entry.kind === "tail");
  expect(tail).toMatchObject({ kind: "tail", body: "Keep the lamp lit." });
  const endingIndex = changes
    .at(-1)!
    .findIndex(
      (entry) => entry.kind === "builtin" && entry.builtin === "play.ending",
    );
  expect(changes.at(-1)![endingIndex + 1]).toBe(tail);
  expect(preview()).toContain("Keep the lamp lit.");
  expect(screen.queryByLabelText("Prompt text")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Delete prompt" }));
  expect(changes.at(-1)!.some((entry) => entry.kind === "tail")).toBe(false);
  expect(preview()).not.toContain("Keep the lamp lit.");
});
