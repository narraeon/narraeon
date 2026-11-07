import {
  prepareAuthoringDispatch,
  failAuthoringDispatch,
  type AuthoringDispatchPhase,
} from "./AuthoringRetry.ts";
import type { AuthoringRequestSnapshot } from "./AuthoringRequestSnapshot.ts";
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
  ModelHostExchange,
  ModelHostResponse,
  ModelHostToolCall,
  GoogleHopEvidence,
} from "../model/ModelHost.ts";
import { ModelHostCancelledError } from "../model/ModelHost.ts";
import { withGoogleHop } from "../model/GoogleRequestPreview.ts";
import {
  retargetFrozenCompilation,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";

const maximumExchangesPerMessage = 64;
const maximumStreamTailCharacters = 240;

export interface AuthoringConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

/**
 * `paused` means the per-run exchange budget ran out after a fully settled tool
 * response; the conversation can continue without a new user message.
 */
export type AuthoringRunStatus = "ready" | "running" | "paused" | "interrupted";

/**
 * Target-neutral durable state required by one model-directed authoring
 * conversation. Target Modules own every additional field and all publication
 * semantics; this Module owns only the Provider/tool exchange lifecycle.
 */
export interface ModelToolConversationState {
  sessionId: string;
  runStatus: AuthoringRunStatus;
  updatedAt: number;
  bootstrap: PromptCompilation;
  requests?: AuthoringRequestSnapshot[];
  modelBinding: ModelHostBinding;
  modelItems: ModelHostAppendItem[];
  messages: AuthoringConversationMessage[];
  usage: ModelUsage;
  exchange: number;
  toolCalls: number;
  activeRequestId: string | null;
  completedRequestIds: string[];
  lastFailure: string | null;
  googleOutcomeUnknown?: boolean;
  retryDispatch?: {
    requestId: string;
    exchange: number;
    modelItemCount: number;
    state: "dispatching" | "retryable" | "blocked";
  };
  pendingSettlement: unknown;
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
  /** A continuation may use a distinct idempotency key for the run. */
  exchangeRequestId?: string;
  worldRevisionBoundaries?: ModelHostExchange["worldRevisionBoundaries"];
  save: (session: Session) => Promise<void>;
  recordGoogleHop?: (
    requestId: string,
    hop: GoogleHopEvidence,
  ) => Promise<void>;
  settleToolResponse: (
    session: Session,
    assistantItemIndex: number,
    calls: readonly ModelHostToolCall[],
  ) => Promise<void>;
  view: (session: Session) => View;
  changed?: (durable: boolean) => void;
  failure?: {
    emptyResponse?: string;
    cancelled?: string;
    interrupted?: string;
  };
  /** Whether this persisted schema supports durable retry checkpoints. */
  retrySupported: boolean;
}

export function authoringExchange(
  session: ModelToolConversationState,
  requestId: string,
  boundaries?: ModelHostExchange["worldRevisionBoundaries"],
  binding: ModelHostBinding = session.modelBinding,
): ModelHostExchange {
  const bootstrap = retargetFrozenCompilation(
    session.requests?.at(-1)?.bootstrap ?? session.bootstrap,
    binding,
  );
  return {
    bootstrap,
    toolUniverse: bootstrap.toolUniverse,
    allowedTools: bootstrap.toolUniverse.map(({ name }) => name),
    toolStrategy: bootstrap.toolStrategy,
    tools: bootstrap.tools,
    appended: session.modelItems,
    ...(boundaries === undefined
      ? {}
      : { worldRevisionBoundaries: boundaries }),
    requestId,
    operationId: session.sessionId,
    requestAttempt: 1,
    exchange: session.exchange + 1,
    maxOutputTokens: binding.maxOutputTokens,
  };
}

export function recordAuthoringRetryPreview(
  session: ModelToolConversationState,
  host: ModelHost,
  retryId: string,
  boundaries?: ModelHostExchange["worldRevisionBoundaries"],
): void {
  const snapshot = session.requests?.at(-1);
  if (snapshot === undefined) return;
  const request = authoringExchange(
    session,
    snapshot.requestId,
    boundaries,
    host.binding(),
  );
  if (session.retryDispatch !== undefined)
    request.exchange = session.retryDispatch.exchange;
  request.requestAttempt = (snapshot.retryAttempts?.length ?? 0) + 2;
  snapshot.retryAttempts ??= [];
  if (!snapshot.retryAttempts.some((item) => item.requestId === retryId))
    snapshot.retryAttempts.push({
      requestId: retryId,
      compilation: structuredClone(request.bootstrap),
      modelBinding: structuredClone(host.binding()),
      ...(host.binding().provider === "google_interactions" &&
      host.previewAuthoringRequest !== undefined
        ? { wireRequest: host.previewAuthoringRequest(request) }
        : {}),
    });
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
      input.changed?.(true);
    });
    this.#runs.set(input.session.sessionId, live);
    input.changed?.(true);
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
    let phase: AuthoringDispatchPhase = "settling";
    try {
      for (let round = 0; round < maximumExchangesPerMessage; round += 1) {
        let request = authoringExchange(
          session,
          input.exchangeRequestId ?? live.requestId,
          input.worldRevisionBoundaries,
          input.host.binding(),
        );
        if (input.retrySupported)
          request = prepareAuthoringDispatch(session, request);
        const retryAttempt = session.requests
          ?.at(-1)
          ?.retryAttempts?.find((item) => item.requestId === live.requestId);
        if (retryAttempt !== undefined)
          request.requestAttempt =
            (session.requests?.at(-1)?.retryAttempts?.indexOf(retryAttempt) ??
              0) + 2;
        session.exchange = Math.max(
          session.exchange,
          request.exchange ?? session.exchange + 1,
        );
        if (session.modelBinding.provider === "google_interactions")
          session.googleOutcomeUnknown = true;
        live.streaming = emptyStreaming();
        session.updatedAt = Date.now();
        phase = "preparing";
        await input.save(session);
        input.changed?.(true);
        phase = "dispatched";
        const response = await input.host.exchange(request, {
          signal: live.controller.signal,
          onGoogleHop: (hop) => {
            const requestId = input.exchangeRequestId ?? live.requestId;
            const snapshot = session.requests?.findLast(
              (entry) => entry.requestId === requestId,
            );
            const retry = snapshot?.retryAttempts?.find(
              (item) => item.requestId === live.requestId,
            );
            if (retry?.wireRequest !== undefined) {
              retry.wireRequest = withGoogleHop(retry.wireRequest, hop);
              return input.recordGoogleHop?.(retry.requestId, hop);
            }
            if (snapshot?.wireRequest === undefined) return;
            snapshot.wireRequest = withGoogleHop(snapshot.wireRequest, hop);
            return input.recordGoogleHop?.(requestId, hop);
          },
          onDelta: (delta) => {
            recordDelta(live, delta);
            input.changed?.(false);
          },
        });
        if (live.controller.signal.aborted)
          throw new ModelHostCancelledError(
            "The authoring request was cancelled",
          );
        phase = "validating";
        assertCompleteResponse(response);
        const toolCalls = response.toolCalls ?? [];
        assertUniqueToolCallIds(toolCalls);
        const visibleText = response.text ?? "";
        session.usage = aggregateModelUsage(session.usage, response.usage);
        if (toolCalls.length === 0 && visibleText.trim().length === 0) {
          phase = "dispatched";
          throw new Error(
            input.failure?.emptyResponse ??
              "The model returned an empty tool-free authoring response",
          );
        }
        delete session.retryDispatch;
        phase = "settling";
        session.modelItems.push({
          kind: "assistant",
          text: visibleText,
          ...(response.reasoningContent === undefined
            ? {}
            : { reasoningContent: response.reasoningContent }),
          providerState: response.providerState!,
          toolCalls: structuredClone(toolCalls),
        });
        if (session.modelBinding.provider === "google_interactions")
          session.googleOutcomeUnknown = false;
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
          input.changed?.(true);
          return input.view(session);
        }
        await input.settleToolResponse(
          session,
          session.modelItems.length - 1,
          toolCalls,
        );
        input.changed?.(true);
      }
      // The exchange budget only bounds a runaway loop. Every tool response is
      // already settled, so the conversation pauses and can resume unchanged.
      delete session.retryDispatch;
      session.runStatus = "paused";
      session.activeRequestId = null;
      session.completedRequestIds = rememberRequest(
        session.completedRequestIds,
        live.requestId,
      );
      session.lastFailure = null;
      session.updatedAt = Date.now();
      await input.save(session);
      return input.view(session);
    } catch (error: unknown) {
      failAuthoringDispatch(session, error, phase);
      if (
        session.modelBinding.provider === "google_interactions" &&
        session.retryDispatch?.state === "retryable"
      )
        session.googleOutcomeUnknown = false;
      session.runStatus = "interrupted";
      session.activeRequestId = null;
      session.completedRequestIds = rememberRequest(
        session.completedRequestIds,
        live.requestId,
      );
      session.lastFailure =
        session.googleOutcomeUnknown === true
          ? "The Google request outcome is unknown; start a fresh model context before sending again."
          : error instanceof ModelHostCancelledError
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

/**
 * Starts another exchange budget for a paused conversation without appending a
 * user message; the next request replays the settled transcript as-is. The run
 * still belongs to the paused user request, so that request stays active; the
 * caller's resume request ID only deduplicates the resume itself.
 */
export function resumePausedAuthoringConversation(
  session: ModelToolConversationState,
): void {
  if (session.runStatus !== "paused")
    throw new Error("Only a paused authoring conversation can be continued");
  const last = session.modelItems.at(-1);
  if (
    last?.kind !== "tool" &&
    !(
      session.modelBinding.provider === "google_interactions" &&
      session.googleOutcomeUnknown === false &&
      last?.kind === "user"
    )
  )
    throw new Error(
      "The paused authoring conversation does not end with settled tool results",
    );
  session.runStatus = "running";
  session.activeRequestId = session.requests?.at(-1)?.requestId ?? null;
  session.lastFailure = null;
  session.updatedAt = Date.now();
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
