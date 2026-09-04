import { randomUUID } from "node:crypto";

import {
  aggregateModelUsage,
  type ModelUsage,
} from "../../protocol/modelUsage.ts";
import type {
  ModelHost,
  ModelHostAppendItem,
  ModelHostBinding,
  ModelHostDelta,
  ModelHostResponse,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import { ModelHostCancelledError } from "../model/ModelHost.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";

const maximumExchangesPerMessage = 64;
const maximumStreamTailCharacters = 240;

export interface AuthoringConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

/**
 * Target-neutral durable state required by one model-directed authoring
 * conversation. Target Modules own every additional field and all publication
 * semantics; this Module owns only the Provider/tool exchange lifecycle.
 */
export interface ModelToolConversationState {
  sessionId: string;
  runStatus: "ready" | "running" | "interrupted";
  updatedAt: number;
  bootstrap: PromptCompilation;
  modelBinding: ModelHostBinding;
  modelItems: ModelHostAppendItem[];
  messages: AuthoringConversationMessage[];
  usage: ModelUsage;
  exchange: number;
  toolCalls: number;
  activeRequestId: string | null;
  completedRequestIds: string[];
  lastFailure: string | null;
}

export interface ModelToolConversationStreaming {
  reasoningChars: number;
  textChars: number;
  toolChars: number;
  tail: string;
  reasoningText?: string;
  visibleText?: string;
  toolFragment?: string;
  receivedAt: number;
}

interface LiveRun<View> {
  requestId: string;
  controller: AbortController;
  promise: Promise<View>;
  streaming: ModelToolConversationStreaming;
}

export interface ModelToolConversationRun<
  Session extends ModelToolConversationState,
  View,
> {
  session: Session;
  host: ModelHost;
  requestId: string;
  save: (session: Session) => Promise<void>;
  settleToolResponse: (
    session: Session,
    assistantItemIndex: number,
    calls: readonly ModelHostToolCall[],
  ) => Promise<void>;
  view: (session: Session) => View;
  failure?: {
    emptyResponse?: string;
    exchangeLimit?: string;
    cancelled?: string;
    interrupted?: string;
  };
}

/**
 * Deep Module for the shared authoring-conversation loop. Its Interface leaves
 * content-package and world-revision publication behind the settlement seam.
 */
export class ModelToolConversation<
  Session extends ModelToolConversationState,
  View,
> {
  readonly #runs = new Map<string, LiveRun<View>>();

  isRunning(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  runningRequestId(sessionId: string): string | null {
    return this.#runs.get(sessionId)?.requestId ?? null;
  }

  running(
    sessionId: string,
  ): { requestId: string; promise: Promise<View> } | null {
    const run = this.#runs.get(sessionId);
    return run === undefined
      ? null
      : { requestId: run.requestId, promise: run.promise };
  }

  streaming(sessionId: string): ModelToolConversationStreaming | null {
    const streaming = this.#runs.get(sessionId)?.streaming;
    return streaming === undefined ? null : structuredClone(streaming);
  }

  run(input: ModelToolConversationRun<Session, View>): Promise<View> {
    const existing = this.#runs.get(input.session.sessionId);
    if (existing !== undefined) {
      if (existing.requestId !== input.requestId)
        throw new Error(
          "Another message in this authoring conversation is still running",
        );
      return existing.promise;
    }
    const live: LiveRun<View> = {
      requestId: input.requestId,
      controller: new AbortController(),
      promise: Promise.resolve(undefined as View),
      streaming: emptyStreaming(),
    };
    live.promise = this.#execute(input, live).finally(() => {
      if (this.#runs.get(input.session.sessionId) === live)
        this.#runs.delete(input.session.sessionId);
    });
    this.#runs.set(input.session.sessionId, live);
    return live.promise;
  }

  cancel(sessionId: string): Promise<View> | null {
    const running = this.#runs.get(sessionId);
    if (running === undefined) return null;
    running.controller.abort();
    return running.promise;
  }

  async #execute(
    input: ModelToolConversationRun<Session, View>,
    live: LiveRun<View>,
  ): Promise<View> {
    const { session } = input;
    try {
      for (let round = 0; round < maximumExchangesPerMessage; round += 1) {
        session.exchange += 1;
        live.streaming = emptyStreaming();
        session.updatedAt = Date.now();
        await input.save(session);
        const response = await input.host.exchange(
          {
            bootstrap: session.bootstrap,
            toolUniverse: session.bootstrap.toolUniverse,
            allowedTools: session.bootstrap.toolUniverse.map(
              ({ name }) => name,
            ),
            toolStrategy: session.bootstrap.toolStrategy,
            tools: session.bootstrap.tools,
            appended: session.modelItems,
            requestId: live.requestId,
            operationId: session.sessionId,
            requestAttempt: 1,
            exchange: session.exchange,
            maxOutputTokens: session.modelBinding.maxOutputTokens,
          },
          {
            signal: live.controller.signal,
            onDelta: (delta) => recordDelta(live, delta),
          },
        );
        assertCompleteResponse(response);
        const toolCalls = response.toolCalls ?? [];
        assertUniqueToolCallIds(toolCalls);
        const visibleText = response.text ?? "";
        if (toolCalls.length === 0 && visibleText.trim().length === 0)
          throw new Error(
            input.failure?.emptyResponse ??
              "The model returned an empty tool-free authoring response",
          );
        session.usage = aggregateModelUsage(session.usage, response.usage);
        session.modelItems.push({
          kind: "assistant",
          text: visibleText,
          ...(response.reasoningContent === undefined
            ? {}
            : { reasoningContent: response.reasoningContent }),
          providerState: response.providerState!,
          toolCalls: structuredClone(toolCalls),
        });
        session.updatedAt = Date.now();
        if (toolCalls.length === 0) {
          session.messages.push({
            id: `message-${randomUUID()}`,
            role: "assistant",
            text: visibleText,
            createdAt: session.updatedAt,
          });
          session.runStatus = "ready";
          session.activeRequestId = null;
          session.completedRequestIds = rememberRequest(
            session.completedRequestIds,
            live.requestId,
          );
          session.lastFailure = null;
          await input.save(session);
          return input.view(session);
        }
        await input.settleToolResponse(
          session,
          session.modelItems.length - 1,
          toolCalls,
        );
      }
      throw new Error(
        input.failure?.exchangeLimit ??
          `Authoring exceeded ${maximumExchangesPerMessage} model exchanges for one user message`,
      );
    } catch (error: unknown) {
      session.runStatus = "interrupted";
      session.activeRequestId = null;
      session.completedRequestIds = rememberRequest(
        session.completedRequestIds,
        live.requestId,
      );
      session.lastFailure =
        error instanceof ModelHostCancelledError
          ? (input.failure?.cancelled ??
            "The authoring response was cancelled. Complete tool responses already settled were retained.")
          : error instanceof Error
            ? error.message
            : (input.failure?.interrupted ??
              "The authoring response was interrupted");
      session.updatedAt = Date.now();
      await input.save(session);
      return input.view(session);
    }
  }
}

export function appendAuthoringUserMessage(
  session: ModelToolConversationState,
  message: string,
  requestId: string,
): void {
  const now = Date.now();
  session.messages.push({
    id: `message-${randomUUID()}`,
    role: "user",
    text: requiredAuthoringMessage(message),
    createdAt: now,
  });
  session.modelItems.push({ kind: "user", text: message });
  session.runStatus = "running";
  session.activeRequestId = requiredAuthoringRequestId(requestId);
  session.lastFailure = null;
  session.updatedAt = now;
}

export function requiredAuthoringMessage(message: string): string {
  if (message.trim().length === 0)
    throw new Error("An authoring message cannot be empty");
  if (message.length > 64 * 1024)
    throw new Error("The authoring message is too large");
  return message;
}

export function requiredAuthoringRequestId(requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId))
    throw new Error("Invalid authoring request ID");
  return requestId;
}

export function rememberAuthoringRequest(
  existing: readonly string[],
  requestId: string,
): string[] {
  return rememberRequest(existing, requestId);
}

function assertCompleteResponse(response: ModelHostResponse): void {
  if (response.providerState === undefined)
    throw new Error(
      "The complete authoring response is missing provider continuation state",
    );
}

function assertUniqueToolCallIds(
  calls: readonly { id: string; name: string }[],
): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (call.id.length === 0 || call.name.length === 0 || ids.has(call.id))
      throw new Error("The model returned invalid or duplicate tool-call IDs");
    ids.add(call.id);
  }
}

function rememberRequest(
  existing: readonly string[],
  requestId: string,
): string[] {
  return [
    ...existing.filter((candidate) => candidate !== requestId),
    requestId,
  ];
}

function emptyStreaming(): ModelToolConversationStreaming {
  return {
    reasoningChars: 0,
    textChars: 0,
    toolChars: 0,
    tail: "",
    reasoningText: "",
    visibleText: "",
    toolFragment: "",
    receivedAt: Date.now(),
  };
}

function recordDelta<View>(live: LiveRun<View>, delta: ModelHostDelta): void {
  if (delta.kind === "reasoning") {
    live.streaming.reasoningChars += delta.text.length;
    live.streaming.reasoningText = `${live.streaming.reasoningText ?? ""}${delta.text}`;
  } else if (delta.kind === "text") {
    live.streaming.textChars += delta.text.length;
    live.streaming.visibleText = `${live.streaming.visibleText ?? ""}${delta.text}`;
  } else {
    live.streaming.toolChars += delta.text.length;
    live.streaming.toolFragment = `${live.streaming.toolFragment ?? ""}${delta.text}`;
  }
  if (delta.kind === "text")
    live.streaming.tail = `${live.streaming.tail}${delta.text}`.slice(
      -maximumStreamTailCharacters,
    );
  live.streaming.receivedAt = Date.now();
}
