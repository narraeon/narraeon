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

const personEntries = [
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
];

describe("narrative-person blocks", () => {
  test("the prose block does not fix the person; three alternatives follow the mechanics block, second person on by default", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      const host = defaultPresetHostFilesForLocale(locale);
      expect(host["blocks/prose.md"]).not.toContain(
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
      const mechanics = ids.indexOf("play.mechanics");
      expect(ids.slice(mechanics, mechanics + 4)).toEqual([
        "play.mechanics",
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

  test("a stored preset without the blocks gains all three right after the mechanics block", () => {
    const files = releasedFiles();
    const migrated = playList(withAlternativePromptBuiltins(files));
    const before = playList(files);
    expect(
      migrated.filter(({ id }) => before.some((old) => old.id === id)),
    ).toEqual(before);
    const mechanics = migrated.findIndex(({ id }) => id === "play.mechanics");
    expect(migrated.slice(mechanics + 1, mechanics + 4)).toEqual(personEntries);
  });

  test("a swapped choice is kept, and without the mechanics block they precede the continuation group", () => {
    const swapped = releasedFiles((items) => {
      const mechanics = items.findIndex(({ id }) => id === "play.mechanics");
      items.splice(mechanics + 1, 0, {
        id: "play.person-first",
        kind: "builtin",
        builtin: "play.person-first",
        enabled: true,
      });
      return items;
    });
    expect(withAlternativePromptBuiltins(swapped)).toBe(swapped);

    const noMechanics = releasedFiles((items) =>
      items.filter(({ id }) => id !== "play.mechanics"),
    );
    const migrated = playList(withAlternativePromptBuiltins(noMechanics));
    const stage = migrated.findIndex(({ id }) => id === "play.continue-stage");
    expect(migrated.slice(stage - 3, stage).map(({ id }) => id)).toEqual([
      "play.person-second",
      "play.person-first",
      "play.person-third",
    ]);
    expect(
      migrated.filter(({ id }) => id.startsWith("play.person-")),
    ).toHaveLength(3);
  });
});
