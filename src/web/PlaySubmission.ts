import type {
  V1PlayCallChainView,
  V1PlayTimelinePage,
  V1Request,
} from "../protocol/v1.ts";
import { activePlayExchangeId } from "./PlayRunProgressState.ts";
import { RuntimeRequestError } from "./RuntimeResponse.ts";
import { ProjectionRefreshError } from "./RequestOutcome.ts";

type PlayCommand = Extract<
  V1Request,
  { type: "play.chain.start" | "play.chain.append" }
>;
type PlayState = Pick<
  V1PlayCallChainView,
  | "status"
  | "lastFailure"
  | "lastFailureKind"
  | "canRetry"
  | "canContinuePartial"
  | "lastCancelled"
>;

export type PlaySubmissionOutcome =
  | { kind: "unconfirmed"; error: unknown; retryRejected: boolean }
  | { kind: "ready" | "cancelled" | "running" }
  | { kind: "interrupted"; failure: PlayState };

interface WorldProjection {
  playCallChain: V1PlayCallChainView | null;
  playTimeline?: V1PlayTimelinePage;
}

function observedState(page: V1PlayTimelinePage): PlayState | null {
  if (page.activeStatus === null) return null;
  const lastItem = page.items.findLast(
    (item) => item.kind === "event" && item.chainId === page.activeChainId,
  );
  return {
    status: page.activeStatus,
    lastFailure: page.activeLastFailure,
    ...(page.activeLastFailureKind === undefined
      ? {}
      : { lastFailureKind: page.activeLastFailureKind }),
    canRetry: page.activeCanRetry,
    canContinuePartial: page.activeCanContinuePartial ?? false,
    ...(lastItem?.kind === "event" && lastItem.event.kind === "cancellation"
      ? { lastCancelled: true }
      : {}),
  };
}

/** Dispatch once. Only a receipt or this exchange's durable/live identity can confirm the submission. */
export async function submitPlay<T extends WorldProjection>(
  client: { request(request: V1Request): Promise<unknown> },
  command: PlayCommand,
  readWorld: () => Promise<T>,
) {
  let receipt: V1PlayCallChainView | null = null;
  let chain: V1PlayCallChainView | null;
  let sendError: unknown;
  try {
    receipt = (await client.request(command)) as V1PlayCallChainView;
    chain = receipt;
  } catch (error) {
    sendError = error;
    chain = (await client
      .request({ type: "play.chain.inspect", worldId: command.worldId })
      .catch(() => null)) as V1PlayCallChainView | null;
  }

  // A second read recovers a dropped projection response. Never replay the command.
  let projectionError: unknown;
  const world = await readWorld()
    .catch(() => readWorld())
    .catch((error: unknown) => {
      projectionError = error;
      return null;
    });
  const timeline =
    world === null
      ? ((await client
          .request({
            type: "play.timeline.page",
            worldId: command.worldId,
            limit: 40,
          })
          .catch(() => undefined)) as V1PlayTimelinePage | undefined)
      : world.playTimeline;
  chain = world?.playCallChain ?? chain;
  const observed = timeline === undefined ? chain : observedState(timeline);
  const sameChain =
    (timeline === undefined ? chain?.chainId : timeline.activeChainId) ===
    command.chainId;
  const player =
    chain?.chainId === command.chainId
      ? chain.events.findLast((event) => event.kind === "player")
      : undefined;
  const playerRecorded =
    (activePlayExchangeId(null, timeline ?? null, command.chainId) ??
      player?.exchangeId) === command.exchangeId;
  const accepted =
    receipt !== null ||
    (sameChain &&
      (playerRecorded ||
        (observed?.status === "running" &&
          chain?.activeInvocation?.exchangeId === command.exchangeId)));
  const state = receipt ?? observed;
  let outcome: PlaySubmissionOutcome;
  if (!accepted || state === null) {
    outcome = {
      kind: "unconfirmed",
      error: sendError,
      retryRejected:
        command.playerText.trim() === "" &&
        sameChain &&
        observed?.status === "interrupted" &&
        !(
          sendError instanceof RuntimeRequestError &&
          sendError.protocolCode === "model_protocol_mismatch"
        ),
    };
  } else if (
    state.lastCancelled === true ||
    (timeline === undefined && chain?.events.at(-1)?.kind === "cancellation")
  ) {
    outcome = { kind: "cancelled" };
  } else if (state.status === "interrupted") {
    outcome = { kind: "interrupted", failure: state };
  } else {
    outcome = { kind: state.status };
  }
  return {
    world,
    chain,
    timeline,
    outcome,
    playerAccepted: receipt !== null || (playerRecorded && sameChain),
    projectionFailure:
      world === null && accepted
        ? new ProjectionRefreshError(projectionError)
        : null,
  };
}
