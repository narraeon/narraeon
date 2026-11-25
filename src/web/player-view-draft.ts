import { PlayerViewRenderer } from "../shared/PlayerViewRenderer.ts";
import {
  exceedsRestrictedYamlShape,
  parseRestrictedYamlDocument,
} from "../shared/restricted-yaml.ts";
import type { WorldDocumentFile } from "../shared/world-documents/WorldDocumentTypes.ts";
import {
  buildWorldDocumentDraft,
  type WorldDocumentDraftLayout,
} from "./world-document-draft-index.ts";
export type { WorldDocumentDraftLocator as PlayerViewDraftLocator } from "./world-document-draft-index.ts";

type WorldDocumentDraft = ReturnType<typeof buildWorldDocumentDraft>;
type PlayerViewDraft = WorldDocumentDraft & {
  render(control: string): ReturnType<PlayerViewRenderer["render"]>;
};
const playerViewDrafts = new WeakMap<WorldDocumentDraft, PlayerViewDraft>();
const renderer = new PlayerViewRenderer();
const invalidControl = {
  code: "invalid_control",
  message: "The player-view control file has an invalid format",
} as const;

export function buildPlayerViewDraft(
  files: readonly WorldDocumentFile[],
  layout: WorldDocumentDraftLayout,
): PlayerViewDraft {
  const draft = buildWorldDocumentDraft(files, layout);
  const previous = playerViewDrafts.get(draft);
  if (previous !== undefined) return previous;
  const playerView: PlayerViewDraft = {
    ...draft,
    render(control) {
      if (!safeControl(control))
        return { views: [], diagnostics: [invalidControl] };
      return renderer.render({
        control,
        snapshot: { query: (request) => draft.snapshot.queryExact(request) },
      });
    },
  };
  playerViewDrafts.set(draft, playerView);
  return playerView;
}

function safeControl(source: string): boolean {
  try {
    const { document } = parseRestrictedYamlDocument(source, {
      rejectRawControlCharacters: true,
    });
    return (
      document !== undefined &&
      !exceedsRestrictedYamlShape(document.toJS({ maxAliasCount: 0 }))
    );
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}
