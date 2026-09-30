import type { AppLocale } from "../../protocol/appPreferences.ts";
import type {
  V1PlayCallChainEvent,
  V1PlayCallChainView,
} from "../../protocol/v1.ts";
import type { ModelHostAppendItem } from "../model/ModelHost.ts";
import type {
  FileNativePlayBinding,
  FileNativeRecoveredEndpoint,
} from "../world/FileNativeWorldStore.ts";
import type {
  PersistedPlayCallChainContext,
  PersistedDocumentAuthorizationCheckpoint,
} from "./FileNativePlayTimelineStore.ts";
import {
  FileNativePlayDocuments,
  type PlayDocumentAuthorizationCheckpoint,
} from "./PlayDocumentTools.ts";
import {
  currentPlayPrompt,
  playPromptRunsThroughEvents,
} from "./PlayPromptRun.ts";
import { isPlayerRoundMarker, playerInputAppend } from "./PlayContinuity.ts";
import { PlayCallChainError } from "./PlayCallChainError.ts";

interface TraceEndpoint {
  baseline: FileNativeRecoveredEndpoint;
  selected: FileNativeRecoveredEndpoint;
  binding: FileNativePlayBinding;
}

type RetainedPlayTrace = Omit<
  PersistedPlayCallChainContext,
  | "chainId"
  | "parentHead"
  | "updatedAt"
  | "derivedFrom"
  | "branchedBeforePlayer"
>;

/**
 * Prepare the selected player's prefix at the existing pre-commit seam.
 * Endpoint reads, revision submission and publication belong to the operation.
 */
export function preparePlayerRevisionTrace(
  source: PersistedPlayCallChainContext,
  eventIndex: number,
) {
  const prefix = structuredClone(source.events.slice(0, eventIndex));
  const transcript = transcriptThroughEvents(source.transcript, prefix);
  const player = source.events[eventIndex] as Extract<
    V1PlayCallChainEvent,
    { kind: "player" }
  >;
  return {
    // This append precedes the operation's materialization check, as before.
    withReplacement(
      selected: FileNativeRecoveredEndpoint,
      replacement: {
        head: string;
        exchangeId: string;
        text: string;
        locale: AppLocale;
      },
    ) {
      const events: V1PlayCallChainEvent[] = [
        ...prefix,
        {
          id: player.id,
          kind: "player",
          exchangeId: replacement.exchangeId,
          text: replacement.text,
          context: player.context,
          committedHead: replacement.head,
        },
      ];
      const continuedTranscript = [
        ...transcript,
        ...playerInputAppend({
          history: Object.fromEntries(
            selected.history.map(({ messageId, exactText }) => [
              messageId,
              exactText,
            ]),
          ),
          checkpoint: selected.narrativeCheckpoint,
          text: replacement.text,
          locale: replacement.locale,
          checkpointAvailable: source.tools.some(
            ({ name }) => name === "world_checkpoint",
          ),
        }),
      ];
      return {
        atEndpoint(endpoint: TraceEndpoint): RetainedPlayTrace {
          return assembleRetainedTrace(source, endpoint, {
            events,
            transcript: continuedTranscript,
            toolEvents: prefix,
            authorizationEvents: prefix,
            exchangeEvents: prefix,
            complete: false,
            materials: endpoint.binding.additionalMaterials,
          });
        },
      };
    },
    pagePrefixAtEndpoint(endpoint: TraceEndpoint): RetainedPlayTrace | null {
      if (prefix.length === 0) return null;
      // Preserve the fresh path's post-commit prefix reconstruction seam.
      const prefixTranscript = transcriptThroughEvents(
        source.transcript,
        prefix,
      );
      return assembleRetainedTrace(source, endpoint, {
        events: prefix,
        transcript: prefixTranscript,
        toolEvents: prefix,
        authorizationEvents: prefix,
        exchangeEvents: prefix,
        complete: false,
        materials: endpoint.selected.additionalMaterials,
      });
    },
  };
}

/** A complete context defines its own closure; partial contexts use page events. */
export function prepareForkTrace(
  source: PersistedPlayCallChainContext,
  events: readonly V1PlayCallChainEvent[],
) {
  const complete = events.length === source.events.length;
  const transcript = complete
    ? structuredClone(source.transcript)
    : transcriptThroughEvents(source.transcript, events);
  return {
    atEndpoint(endpoint: TraceEndpoint): RetainedPlayTrace {
      return assembleRetainedTrace(source, endpoint, {
        events,
        transcript,
        toolEvents: events,
        authorizationEvents: events,
        exchangeEvents: events,
        complete,
        materials: endpoint.binding.additionalMaterials,
      });
    },
  };
}

function assembleRetainedTrace(
  source: PersistedPlayCallChainContext,
  endpoint: TraceEndpoint,
  selection: {
    events: readonly V1PlayCallChainEvent[];
    transcript: ModelHostAppendItem[];
    toolEvents: readonly V1PlayCallChainEvent[];
    authorizationEvents: readonly V1PlayCallChainEvent[];
    exchangeEvents: readonly V1PlayCallChainEvent[];
    complete: boolean;
    materials: PersistedPlayCallChainContext["nextMaterials"];
  },
): RetainedPlayTrace {
  const completedKeys = selection.complete
    ? null
    : completedToolKeys(selection.toolEvents);
  const documents = restorePlayDocuments(
    endpoint.binding.files,
    source,
    selection.authorizationEvents,
  );
  return {
    continuityContextId: source.continuityContextId ?? source.chainId,
    baselineHead: source.baselineHead,
    baselineHistoryLength:
      source.baselineHistoryLength ?? endpoint.baseline.history.length,
    promptRuns: playPromptRunsThroughEvents(source, selection.events),
    ...(source.presetFiles === undefined
      ? {}
      : { presetFiles: structuredClone(source.presetFiles) }),
    playPreset: structuredClone(source.playPreset),
    ...(source.followups === undefined
      ? {}
      : { followups: structuredClone(source.followups) }),
    ...(source.playPresetScriptsEnabled === undefined
      ? {}
      : { playPresetScriptsEnabled: source.playPresetScriptsEnabled }),
    ...(source.modelBinding === undefined
      ? {}
      : { modelBinding: structuredClone(source.modelBinding) }),
    status: "ready",
    canRetry: false,
    bootstrap: structuredClone(source.bootstrap),
    tools: structuredClone(source.tools),
    transcript: structuredClone(selection.transcript),
    events: structuredClone([...selection.events]),
    completedTools: source.completedTools
      .filter(({ key }) => completedKeys === null || completedKeys.has(key))
      .map((item) => structuredClone(item)),
    documentAuthorizationCheckpoints: authorizationCheckpointsThroughEvents(
      source,
      selection.events,
      documents.authorizationCheckpoint(),
    ),
    changedDocuments: changedDocumentsAtHead(
      source.changedDocuments,
      endpoint.baseline.state,
      endpoint.selected.state,
    ),
    nextMaterials: structuredClone(selection.materials),
    nextEventId: Math.max(0, ...selection.events.map(({ id }) => id)) + 1,
    exchange: completedAssistantExchange(selection.exchangeEvents),
    lastRequest: null,
    lastRequestAttempt: 0,
    lastFailure: null,
  };
}

export function restorePlayDocuments(
  files: Readonly<Record<string, string>>,
  context: Pick<
    PersistedPlayCallChainContext,
    | "bootstrap"
    | "tools"
    | "playPreset"
    | "followups"
    | "playPresetScriptsEnabled"
    | "promptRuns"
    | "documentAuthorizationCheckpoints"
  >,
  events: readonly V1PlayCallChainEvent[],
): FileNativePlayDocuments {
  const documents = new FileNativePlayDocuments(files);
  try {
    const checkpoint = documentAuthorizationThroughEvents(context, events);
    const runs = playPromptRunsThroughEvents(context, events);
    if (checkpoint === undefined || runs.length > 0)
      documents.bindBootstrap(
        currentPlayPrompt({ ...context, promptRuns: runs }).bootstrap,
      );
    if (checkpoint !== undefined)
      documents.restoreAuthorizationCheckpoint(checkpoint.authorization);
  } catch (error: unknown) {
    throw new PlayCallChainError(
      `Call-chain document authorization could not be restored: ${
        error instanceof Error ? error.message : "invalid checkpoint"
      }。`,
    );
  }
  return documents;
}

function documentAuthorizationThroughEvents(
  context: Pick<
    PersistedPlayCallChainContext,
    "documentAuthorizationCheckpoints"
  >,
  events: readonly V1PlayCallChainEvent[],
): PersistedDocumentAuthorizationCheckpoint | undefined {
  const checkpoints = context.documentAuthorizationCheckpoints;
  if (checkpoints === undefined || checkpoints.length === 0) return undefined;
  const selectedEventIds = new Set(events.map(({ id }) => id));
  const selected = checkpoints.findLast(
    ({ afterEventId }) =>
      afterEventId === 0 || selectedEventIds.has(afterEventId),
  );
  // Legacy V1 records had no durable dynamic authorization. If the selected
  // prefix predates their first lazily-written checkpoint, retain the exact
  // old recovery behavior and rebuild only bootstrap authorization.
  return selected === undefined ? undefined : structuredClone(selected);
}

export function independentContextCopy(
  source: PersistedPlayCallChainContext,
): PersistedPlayCallChainContext {
  const context = structuredClone(source);
  context.continuityContextId ??= source.chainId;
  delete context.derivedFrom;
  delete context.branchedBeforePlayer;
  return context;
}

function authorizationCheckpointsThroughEvents(
  context: PersistedPlayCallChainContext,
  events: readonly V1PlayCallChainEvent[],
  fallback: PlayDocumentAuthorizationCheckpoint,
): PersistedDocumentAuthorizationCheckpoint[] {
  const eventIds = new Set(events.map(({ id }) => id));
  const selected = (context.documentAuthorizationCheckpoints ?? [])
    .filter(
      ({ afterEventId }) => afterEventId === 0 || eventIds.has(afterEventId),
    )
    .map((checkpoint) => structuredClone(checkpoint));
  if (selected.length > 0) return selected;
  return [
    {
      afterEventId: Math.max(0, ...events.map(({ id }) => id)),
      authorization: structuredClone(fallback),
    },
  ];
}

function transcriptThroughEvents(
  transcript: readonly ModelHostAppendItem[],
  events: readonly V1PlayCallChainEvent[],
): ModelHostAppendItem[] {
  const result: ModelHostAppendItem[] = [];
  let cursor = 0;
  for (const [index, event] of events.entries()) {
    if (event.kind === "player") {
      const marker = transcript[cursor];
      if (isPlayerRoundMarker(marker)) {
        result.push(structuredClone(marker));
        cursor += 1;
      }
      const item = transcript[cursor];
      if (item?.kind !== "player" || item.text !== event.text)
        throw new PlayCallChainError(
          "Source call-chain events do not match the model transcript, so a fork cannot be created safely.",
        );
      result.push(structuredClone(item));
      cursor += 1;
      continue;
    }
    if (event.kind === "assistant" && event.status === "completed") {
      const notice = transcript[cursor];
      const hasContinuationNotice =
        notice?.kind === "runtime_notice" && notice.notice === "continuation";
      const item = transcript[cursor + (hasContinuationNotice ? 1 : 0)];
      const hasToolCall = events
        .slice(index + 1)
        .find(
          (candidate) =>
            candidate.kind === "player" ||
            candidate.kind === "assistant" ||
            candidate.kind === "tool_call",
        );
      const recorded =
        event.text.trim().length > 0 ||
        hasToolCall?.kind === "tool_call" ||
        item?.kind === "assistant";
      if (!recorded) continue;
      if (item?.kind !== "assistant" || item.text !== event.text)
        throw new PlayCallChainError(
          "Source call-chain responses do not match the model transcript, so a fork cannot be created safely.",
        );
      // A continuation notice belongs to the generation it precedes, never
      // to a fork ending at the previously completed narrative.
      if (hasContinuationNotice) {
        result.push(structuredClone(notice));
        cursor += 1;
      }
      result.push(structuredClone(item));
      cursor += 1;
      continue;
    }
    if (event.kind === "tool_result") {
      const item = transcript[cursor];
      if (item?.kind !== "tool" || item.toolCallId !== event.callId)
        throw new PlayCallChainError(
          "Source call-chain tool results do not match the model transcript, so a fork cannot be created safely.",
        );
      result.push(structuredClone(item));
      cursor += 1;
      // A tool-step notice follows the entire settled batch and remains part
      // of its closure even when the selected endpoint stops at that batch.
      const notice = transcript[cursor];
      if (notice?.kind === "runtime_notice" && notice.notice === "tool_step") {
        result.push(structuredClone(notice));
        cursor += 1;
      }
    }
  }
  return result;
}

function completedToolKeys(
  events: readonly V1PlayCallChainEvent[],
): Set<string> {
  const keys = new Set<string>();
  let exchange: number | null = null;
  for (const event of events) {
    if (event.kind === "player") exchange = null;
    else if (event.kind === "assistant") exchange = event.exchange;
    else if (event.kind === "tool_call" && exchange !== null)
      keys.add(`${exchange}:${event.callId}`);
  }
  return keys;
}

function changedDocumentsAtHead(
  changes: readonly V1PlayCallChainView["changedDocuments"][number][],
  baseline: readonly { path: string; contents: string }[],
  selected: readonly { path: string; contents: string }[],
): V1PlayCallChainView["changedDocuments"] {
  const before = new Map(baseline.map((file) => [file.path, file.contents]));
  const after = new Map(selected.map((file) => [file.path, file.contents]));
  return changes
    .filter(
      ({ path }) => after.has(path) && before.get(path) !== after.get(path),
    )
    .map((change) => structuredClone(change));
}

function completedAssistantExchange(
  events: readonly V1PlayCallChainEvent[],
): number {
  return Math.max(
    0,
    ...events
      .filter(
        (
          event,
        ): event is Extract<V1PlayCallChainEvent, { kind: "assistant" }> =>
          event.kind === "assistant" && event.status === "completed",
      )
      .map(({ exchange }) => exchange),
  );
}
