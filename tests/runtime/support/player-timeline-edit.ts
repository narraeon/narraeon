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

export async function advanceOutsidePlay(
  worlds: FileNativeWorldStore,
  worldId: string,
  operationId: string,
  parentHead: string,
): Promise<void> {
  const lock = await worlds.acquireWorldRevisionLock(worldId, operationId);
  if (lock.kind !== "acquired") throw new Error("Missing world revision lock");
  try {
    const { additionalMaterials } = await worlds.recoverEndpoint(
      worldId,
      parentHead,
    );
    const control = await worlds.readSurface(worldId, "control", parentHead);
    await worlds.commitWorldRevisionApply({
      worldId,
      operationId,
      parentHead,
      nextMaterials: additionalMaterials,
      stateChanges: [],
      control,
      worldRevisionLock: lock.handle,
    });
  } finally {
    await worlds.releaseWorldRevisionLock(lock.handle);
  }
}
