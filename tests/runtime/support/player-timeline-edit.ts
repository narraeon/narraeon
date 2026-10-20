import type { FileNativeWorldStore } from "../../../src/runtime/world/FileNativeWorldStore.ts";

/**
 * Test-only composition of the player edit's world steps: rewind to the
 * edited message's logical parent, then commit the replacement as an ordinary
 * player step (ADR-0044). Production code goes through PlayCallChain.revisePlayer.
 */
export async function revisePlayerTimeline(
  store: FileNativeWorldStore,
  input: {
    operationId: string;
    worldId: string;
    restoresHead: string;
    replacementText: string;
    /** Accepted for the call sites that name the replaced message's head. */
    expectedCurrentHead?: string;
    replacesHead?: string;
  },
) {
  await store.rewindPlayerRevision(input.worldId, input.restoresHead);
  const binding = await store.bindPlayCallChainAt(
    input.worldId,
    input.restoresHead,
  );
  return store.commitPlayStep({
    operationId: input.operationId,
    worldId: input.worldId,
    parentHead: input.restoresHead,
    historyAppend: [{ role: "player", exactText: input.replacementText }],
    nextMaterials: structuredClone(binding.additionalMaterials),
    stateChanges: [],
  });
}
