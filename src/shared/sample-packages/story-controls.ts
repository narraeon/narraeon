import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ContentTreeFile } from "../../protocol/v1.ts";

export interface PlayerViewItemSpec {
  id: string;
  label: string;
  document: string;
  locator: readonly string[];
}

export interface PlayerViewSpec {
  id: string;
  title: string;
  items: readonly PlayerViewItemSpec[];
}

export interface StoryControlOptions {
  catalogDirectories?: readonly { directory: string; maxEntries: number }[];
  extraViews?: readonly PlayerViewSpec[];
}

function renderPlayerViewItem(item: PlayerViewItemSpec): string {
  return `      - id: ${item.id}
        label: ${item.label}
        select:
          document: "@${item.document}"
          locator: { yaml: [${item.locator.join(", ")}] }
`;
}

function renderPlayerView(view: PlayerViewSpec): string {
  return `  - id: ${view.id}
    title: ${view.title}
    items:
${view.items.map(renderPlayerViewItem).join("")}`;
}

export function storyControlFiles(
  locale: AppLocale,
  location: string,
  guidance: string,
  documents: readonly string[] = [],
  publicClues?: { document: string; key: string },
  options: StoryControlOptions = {},
): ContentTreeFile[] {
  const zh = locale === "zh-CN";
  const background = zh ? "背景" : "background";
  const time = zh ? "时间" : "Time";
  const place = zh ? "地点" : "Place";
  const present = zh ? "在场" : "Present";
  const extraCatalogs = (options.catalogDirectories ?? [])
    .map(
      ({ directory, maxEntries }) =>
        `  - slot: { kind: catalog, directory: ${directory}, maxEntries: ${maxEntries} }\n`,
    )
    .join("");
  const extraViews = (options.extraViews ?? []).map(renderPlayerView).join("");
  return [
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 8 }
  - slot: { kind: catalog, directory: locations, maxEntries: 8 }
${extraCatalogs}  - slot: { kind: document, document: "@${location}" }
${documents.map((ref) => `  - slot: { kind: document, document: "@${ref}" }\n`).join("")}  - slot:
      kind: reference_targets
      from:
        document: "@current-situation"
        locator: { yaml: [${present}] }
      maxEntries: 6
  - slot: { kind: catalog, directory: continuity, maxEntries: 3 }
  - slot: { kind: document, document: "@pending-matters" }
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
`,
    },
    { path: "control/blocks/world.md", contents: guidance },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1
views:
  - id: scene-status
    title: ${zh ? "此刻" : "Right now"}
    items:
      - id: time
        label: ${time}
        select:
          document: "@current-situation"
          locator: { yaml: [${background}, ${time}] }
      - id: place
        label: ${place}
        select:
          document: "@current-situation"
          locator: { yaml: [${background}, ${place}] }
${
  publicClues === undefined
    ? ""
    : `      - id: known-clues
        label: ${zh ? "已知线索" : "Known clues"}
        select:
          document: "@${publicClues.document}"
          locator: { yaml: [${publicClues.key}] }
`
}${extraViews}`,
    },
  ];
}
