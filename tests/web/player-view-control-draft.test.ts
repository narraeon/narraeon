import { describe, expect, test } from "vitest";

import {
  editPlayerViewControl,
  readPlayerViewControl,
} from "../../src/web/player-view-control-draft.ts";

const source = `# Player view notes
format: narraeon.player-views/v1
views:
  - id: status
    title: 'Story' # View title note
    items:
      - id: crossing # First item note
        label: Crossing
        select:
          document: '@almanac'
          locator:
            yaml:
              - location # Chosen node note
          extra: Keep selector data
      - id: crew # Second item note
        label: Crew
        select: { document: 'character.crew', locator: { yaml: [] } }
extra: Keep unrelated data
`;

describe("player-view source edits", () => {
  test("reorders existing nodes, preserves notes, and changes only the chosen selector", () => {
    const moved = editPlayerViewControl(source, {
      kind: "move",
      path: ["views", 0, "items"],
      from: 0,
      to: 1,
    });
    const next = editPlayerViewControl(moved, {
      kind: "set-locator",
      path: ["views", 0, "items", 1, "select", "locator"],
      value: { markdown: ["Almanac", "Crossing"] },
    });

    expect(next).toContain("# Player view notes");
    expect(next).toContain("title: 'Story' # View title note");
    expect(next).toContain("id: crew # Second item note");
    expect(next).toContain("id: crossing # First item note");
    expect(next).toContain("Almanac # Chosen node note");
    expect(next).toContain("extra: Keep selector data");
    expect(next).toContain("extra: Keep unrelated data");
    const items = readPlayerViewControl(next).views?.[0]?.items;
    expect(items?.map(({ id }) => id)).toEqual(["crew", "crossing"]);
    expect(items?.[0]?.select).toEqual({
      document: "character.crew",
      locator: { yaml: [] },
    });
    expect(items?.[1]?.select.locator).toEqual({
      markdown: ["Almanac", "Crossing"],
    });
  });

  test.each([
    "format: narraeon.player-views/v1\nviews: [ # invalid YAML\n",
    "format: narraeon.player-views/v1\nviews: &views []\n",
    source.replace("- location", "- 0"),
    source.replace("id: crew", "id: crossing"),
  ])("directs non-representable source to the raw editor", (contents) => {
    expect(readPlayerViewControl(contents).views).toBeUndefined();
  });
});
