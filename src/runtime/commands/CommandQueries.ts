import { type V1PlayTimelinePage } from "../../protocol/v1.ts";
import { type PlayCallChain } from "../play/PlayCallChain.ts";
import {
  FileNativeWorldCreationError,
  type FileNativeWorldStore,
} from "../world/FileNativeWorldStore.ts";

// 先取得当前端点再按它读取的请求，在端点被回退丢弃时最多重做这么多次（#94）。
const currentEndpointReadAttempts = 3;

export async function readPlayTimeline(
  worlds: FileNativeWorldStore,
  playCallChains: PlayCallChain,
  worldId: string,
  limit: number,
  cursor?: string,
): Promise<V1PlayTimelinePage> {
  const page = await worlds.playTimeline.readPage(worldId, limit, cursor);
  const activeInvocationExchangeId = playCallChains.currentInvocationExchangeId(
    worldId,
    page.activeChainId,
  );
  // Followups keep the live context running after the durable main reply settles.
  return {
    ...page,
    activeInvocationExchangeId,
    ...(activeInvocationExchangeId === null
      ? {}
      : {
          activeStatus: "running",
          activeCanRetry: false,
          activeCanContinuePartial: false,
          activeLastFailure: null,
          activeLastFailureKind: undefined,
          activeFreshContextReason: undefined,
        }),
  };
}

export async function readingCurrentEndpoint<T>(
  read: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error: unknown) {
      if (
        !(
          error instanceof FileNativeWorldCreationError &&
          (error.code === "endpoint_discarded" ||
            error.code === "endpoint_read_conflict")
        ) ||
        attempt >= currentEndpointReadAttempts
      )
        throw error;
    }
  }
}
