import { parseDocument, stringify } from "yaml";
import { describe, expect, test } from "vitest";

import { defaultPlayPresetFilesForLocale } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { withAlternativePromptBuiltins } from "../../src/runtime/play/OrderedPlayPrompts.ts";
import {
  builtinPlayPrompts,
  defaultOrderedPlayPrompts,
} from "../../src/shared/ordered-play-prompts.ts";
import { defaultPresetHostFilesForLocale } from "../../src/shared/default-preset-host.ts";

interface PromptEntry {
  id: string;
  kind: string;
  builtin?: string;
  enabled?: boolean;
}

function playList(files: Record<string, string>): PromptEntry[] {
  return (
    parseDocument(files["preset.yaml"]!).toJS() as {
      playPrompts: PromptEntry[];
    }
  ).playPrompts;
}

/** A v2 preset as the release before the person builtins saved it. */
function releasedFiles(
  edit: (items: PromptEntry[]) => PromptEntry[] = (items) => items,
): Record<string, string> {
  const files = { ...defaultPlayPresetFilesForLocale("en") };
  const preset = parseDocument(files["preset.yaml"]!);
  const items = (preset.toJS() as { playPrompts: PromptEntry[] }).playPrompts;
  preset.set(
    "playPrompts",
    edit(items.filter(({ id }) => !id.startsWith("play.person-"))),
  );
  files["preset.yaml"] = stringify(preset.toJS());
  return files;
}

describe("narrative-person blocks", () => {
  test("the general style no longer fixes the person; three alternatives follow it, second person on by default", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const host = defaultPresetHostFilesForLocale(locale);
      expect(host["blocks/style.md"]).not.toContain(
        locale === "zh-CN" ? "第二人称" : "as “you”",
      );
      expect(host["blocks/person-second.md"]).toContain(
        locale === "zh-CN" ? "“你”" : "“you”",
      );
      expect(host["blocks/person-first.md"]).toContain(
        locale === "zh-CN" ? "“我”" : "“I”",
      );
      expect(host["blocks/person-third.md"]).toContain(
        locale === "zh-CN" ? "第三人称" : "third person",
      );
      const ids = builtinPlayPrompts(locale).map(({ id }) => id);
      const style = ids.indexOf("play.style");
      expect(ids.slice(style, style + 4)).toEqual([
        "play.style",
        "play.person-second",
        "play.person-first",
        "play.person-third",
      ]);
    }
    const enabled = Object.fromEntries(
      defaultOrderedPlayPrompts().flatMap((entry) =>
        entry.kind === "builtin" ? [[entry.builtin, entry.enabled]] : [],
      ),
    );
    expect(enabled["play.person-second"]).toBe(true);
    expect(enabled["play.person-first"]).toBe(false);
    expect(enabled["play.person-third"]).toBe(false);
  });

  test("a stored preset without the blocks gains all three after the general style", () => {
    const files = releasedFiles();
    const migrated = playList(withAlternativePromptBuiltins(files));
    const before = playList(files);
    expect(
      migrated.filter(({ id }) => before.some((old) => old.id === id)),
    ).toEqual(before);
    const style = migrated.findIndex(({ id }) => id === "play.style");
    expect(migrated.slice(style + 1, style + 4)).toEqual([
      {
        id: "play.person-second",
        kind: "builtin",
        builtin: "play.person-second",
        enabled: true,
      },
      {
        id: "play.person-first",
        kind: "builtin",
        builtin: "play.person-first",
        enabled: false,
      },
      {
        id: "play.person-third",
        kind: "builtin",
        builtin: "play.person-third",
        enabled: false,
      },
    ]);
  });

  test("a swapped choice is kept, and without the style block they precede the adjudication block", () => {
    const swapped = releasedFiles((items) => {
      const style = items.findIndex(({ id }) => id === "play.style");
      items.splice(style + 1, 0, {
        id: "play.person-first",
        kind: "builtin",
        builtin: "play.person-first",
        enabled: true,
      });
      return items;
    });
    expect(withAlternativePromptBuiltins(swapped)).toBe(swapped);

    const noStyle = releasedFiles((items) =>
      items.filter(({ id }) => id !== "play.style"),
    );
    const migrated = playList(withAlternativePromptBuiltins(noStyle));
    const adjudication = migrated.findIndex(
      ({ id }) => id === "play.adjudication",
    );
    expect(
      migrated.slice(adjudication - 3, adjudication).map(({ id }) => id),
    ).toEqual(["play.person-second", "play.person-first", "play.person-third"]);
    expect(
      migrated.filter(({ id }) => id.startsWith("play.person-")),
    ).toHaveLength(3);
  });
});
