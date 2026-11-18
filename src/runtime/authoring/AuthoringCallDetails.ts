import type { PlayRequestContext } from "../../protocol/playRequestContext.ts";
import type {
  V1SettingAuthoringDiff,
  V1SettingConversationExchange,
  V1SettingConversationToolCall,
  V1SettingConversationTurn,
} from "../../protocol/v1.ts";
import { retargetFrozenCompilation } from "../prompt/FileNativePromptCompiler.ts";
import {
  contextDigest,
  projectRequestContext,
} from "../play/PlayRequestContext.ts";
import type {
  ModelToolConversationState,
  ModelToolConversationStreaming,
} from "./ModelToolConversation.ts";
import type { ModelHostAppendItem } from "../model/ModelHost.ts";

type ToolItem = Extract<ModelHostAppendItem, { kind: "tool" }> & {
  changes: V1SettingAuthoringDiff[];
};
type AuthoringHistory = ModelToolConversationState & {
  createdAt: number;
  modelItems: (Exclude<ModelHostAppendItem, { kind: "tool" }> | ToolItem)[];
};

/** Projects only call results and small receipts for conversation views. */
export function authoringConversationTurns<T extends AuthoringHistory>(
  session: T,
  streaming: ModelToolConversationStreaming | null,
  changeSetId: (
    item: Extract<T["modelItems"][number], { kind: "tool" }>,
    index: number,
  ) => string | null,
): V1SettingConversationTurn[] {
  const userMessages = session.messages.filter(({ role }) => role === "user");
  const snapshots = new Map(
    session.requests?.map((snapshot) => [snapshot.modelItemStart, snapshot]),
  );
  const turns: V1SettingConversationTurn[] = [];
  let userIndex = 0;
  let exchange = 0;
  let current: V1SettingConversationTurn | undefined;
  let currentTools = new Map<string, V1SettingConversationToolCall>();
  let tracked = new Map<number, V1SettingConversationExchange>();
  for (const [index, item] of session.modelItems.entries()) {
    if (item.kind === "user") {
      const user = userMessages[userIndex++] ?? {
        id: `${session.sessionId}:user:${index}`,
        role: "user",
        text: item.text,
        createdAt: session.createdAt,
      };
      current = { id: user.id, user: structuredClone(user), exchanges: [] };
      turns.push(current);
      currentTools = new Map();
      tracked = new Map();
      for (const call of snapshots.get(index)?.calls ?? []) {
        const live =
          call.status === "attempted" && streaming?.callId === call.id
            ? streaming
            : null;
        const response: V1SettingConversationExchange = {
          id: call.id,
          exchange: call.exchange,
          status:
            live !== null
              ? "streaming"
              : call.status === "attempted"
                ? "interrupted"
                : call.status,
          text: live?.visibleText ?? "",
          ...(live?.reasoningText ? { reasoning: live.reasoningText } : {}),
          ...(live?.toolFragment ? { toolFragment: live.toolFragment } : {}),
          ...(call.failure === undefined ? {} : { failure: call.failure }),
          ...(call.retryOf === undefined ? {} : { retryOf: call.retryOf }),
          ...(call.usage === undefined
            ? {}
            : { usage: structuredClone(call.usage) }),
          toolCalls: [],
        };
        current.exchanges.push(response);
        if (call.assistantItemIndex !== undefined)
          tracked.set(call.assistantItemIndex, response);
      }
    } else if (item.kind === "assistant" && current !== undefined) {
      exchange += 1;
      let response = tracked.get(index);
      if (response === undefined) {
        response = {
          id: `${session.sessionId}:exchange:${index}`,
          exchange,
          text: "",
          toolCalls: [],
        };
        current.exchanges.push(response);
      }
      response.text = item.text;
      if (item.reasoningContent !== undefined)
        response.reasoning = item.reasoningContent;
      response.toolCalls = item.toolCalls.map((call) => ({
        callId: call.id,
        name: call.name,
        arguments: structuredClone(call.arguments),
        result: null,
      }));
      currentTools = new Map(
        response.toolCalls.map((call) => [call.callId, call]),
      );
    } else if (item.kind === "tool") {
      const call = currentTools.get(item.toolCallId);
      if (call?.result === null)
        call.result = {
          markdown: item.markdown,
          isError: item.isError === true,
          changes: structuredClone((item as ToolItem).changes),
          changeSetId: changeSetId(
            item as Extract<T["modelItems"][number], { kind: "tool" }>,
            index,
          ),
        };
    }
  }
  return turns;
}

export function readAuthoringCallContext(
  session: ModelToolConversationState,
  callId: string,
): PlayRequestContext {
  const unavailable: PlayRequestContext = {
    status: "unavailable",
    messages: [],
  };
  const requests = session.requests ?? [];
  for (const [index, snapshot] of requests.entries()) {
    const call = snapshot.calls?.find(({ id }) => id === callId);
    if (call === undefined) continue;
    const retry = snapshot.retryAttempts?.find(
      ({ requestId }) => requestId === call.retryRequestId,
    );
    const saved = retry?.compilation ?? snapshot.bootstrap;
    const binding =
      retry?.modelBinding ?? snapshot.modelBinding ?? session.modelBinding;
    const bootstrap = retargetFrozenCompilation(saved, binding);
    const evidence = call.evidence;
    if (
      evidence?.exchange === call.exchange &&
      evidence.attempt === call.requestAttempt &&
      evidence.transcriptCount > snapshot.modelItemStart &&
      evidence.transcriptCount <=
        (requests[index + 1]?.modelItemStart ?? session.modelItems.length) &&
      contextDigest(bootstrap) === evidence.bootstrapDigest &&
      contextDigest(bootstrap.toolUniverse) === evidence.toolsDigest
    ) {
      const prefix = session.modelItems.slice(0, evidence.transcriptCount);
      if (contextDigest(prefix) === evidence.transcriptDigest)
        return {
          status: "available",
          messages: projectRequestContext(
            bootstrap,
            [...prefix, ...evidence.suffix],
            bootstrap.toolUniverse,
            evidence.continuation,
            call.boundaries,
          ),
        };
    }
    return { status: "incomplete", messages: projectRequestContext(saved, []) };
  }

  // Old sessions persisted complete assistant responses without a dispatch
  // boundary. Identify their frozen send by the response's transcript index.
  const legacyPrefix = `${session.sessionId}:exchange:`;
  if (!callId.startsWith(legacyPrefix)) return unavailable;
  const itemIndex = Number(callId.slice(legacyPrefix.length));
  if (
    !Number.isSafeInteger(itemIndex) ||
    `${legacyPrefix}${itemIndex}` !== callId ||
    session.modelItems[itemIndex]?.kind !== "assistant" ||
    requests.some((snapshot) =>
      snapshot.calls?.some(
        ({ assistantItemIndex }) => assistantItemIndex === itemIndex,
      ),
    )
  )
    return unavailable;
  const snapshot = requests.findLast(
    ({ modelItemStart }) => modelItemStart < itemIndex,
  );
  return {
    status: "incomplete",
    messages: projectRequestContext(
      snapshot?.bootstrap ?? session.bootstrap,
      [],
    ),
  };
}
