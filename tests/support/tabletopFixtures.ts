import { gameplayFile, type Gameplay } from "../../src/protocol/gameplay.ts";
import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import {
  createMinimalFileNativePreviewInput,
  type FileNativePromptInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

/**
 * The minimal interactive-fiction request, with its world's control tree
 * carrying the given gameplay. Fiction adds no control/gameplay.json at all.
 */
export function previewInputWithGameplay(
  gameplay: Gameplay,
  options: {
    playerInputPlacement?: FileNativePromptInput["playerInputPlacement"];
    locale?: AppLocale;
  } = {},
): FileNativePromptInput {
  const base = createMinimalFileNativePreviewInput({
    provider: "anthropic_messages",
    modelId: "tabletop-fixture-model",
    contextWindowTokens: 200_000,
    maxOutputTokens: 4096,
    playerInput: "我推开石门。",
    playerInputPlacement: options.playerInputPlacement ?? "bootstrap",
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  });
  const files = base.world.documentSnapshot.files.map(({ path, contents }) => ({
    path,
    contents,
  }));
  if (gameplay.mode === "tabletop") {
    const identity = gameplayFile(gameplay);
    files.push({ path: identity.path, contents: identity.contents });
  }
  return {
    ...base,
    world: {
      ...base.world,
      documentSnapshot: WorldDocumentStore.open({
        layout: "world_state",
        files,
      }),
    },
  };
}

/** Logical names of the tools a request would send to the model. */
export function toolNames(tools: readonly { name: string }[]): string[] {
  return tools.map(({ name }) => name);
}
