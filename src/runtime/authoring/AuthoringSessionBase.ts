import { readAuthoringCallContext } from "./AuthoringCallDetails.ts";
import { completedAuthoringEdit } from "./AuthoringEditPlan.ts";
import {
  authoringRequestIdentities,
  authoringRequestPreviews,
  confirmedAuthoringRequestIds,
  type AuthoringRequestSnapshot,
} from "./AuthoringRequestSnapshot.ts";
import {
  assertCompatibleAuthoring,
  canRetryAuthoringDispatch,
  checkpointNextAuthoringDispatch,
} from "./AuthoringRetry.ts";
import {
  appendAuthoringUserMessage,
  authoringExchange,
  type ModelToolConversation,
  rememberAuthoringRequest,
  resumePausedAuthoringConversation,
  type ModelToolConversationState,
  type ModelToolConversationStreaming,
} from "./ModelToolConversation.ts";
import { prepareAuthoringPartial } from "../model/AssistantPrefill.ts";
import type { ModelHost, ModelHostExchange } from "../model/ModelHost.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";

const unknownGoogleOutcome =
  "The Google request outcome is unknown; start a fresh model context.";

export type AuthoringContinuation =
  { kind: "fresh_context" } | { kind: "continue_context"; sessionId: string };

type Progress = Pick<
  ModelToolConversationState,
  "sessionId" | "runStatus" | "exchange" | "toolCalls" | "updatedAt"
>;

type RequestPreviewBoundaries = ModelHostExchange["worldRevisionBoundaries"];

interface AuthoringSessionTarget<Session> {
  name: string;
  inputError: new (message: string) => Error;
  read: (sessionId: string, targetId: string) => Promise<Session>;
  assertOwner: (session: Session, targetId: string) => void;
  bindModelHost: () => Promise<ModelHost>;
  compilePreview: (
    targetId: string,
    host: ModelHost,
  ) => Promise<PromptCompilation>;
}

/** Worktree operations and storage stay behind the target's read and compile callbacks. */
export class AuthoringSessionBase<
  Session extends ModelToolConversationState & { creationRequestId: string },
  View,
> {
  readonly conversation: ModelToolConversation<Session, View>;
  readonly #target: AuthoringSessionTarget<Session>;
  readonly #mutations: { tail: Promise<void> };

  constructor(
    conversation: ModelToolConversation<Session, View>,
    target: AuthoringSessionTarget<Session>,
    mutations = { tail: Promise.resolve() },
  ) {
    this.conversation = conversation;
    this.#target = target;
    this.#mutations = mutations;
  }

  message(value: string): string {
    if (value.trim().length === 0)
      throw new this.#target.inputError(
        `A ${this.#target.name} message cannot be empty`,
      );
    if (value.length > 64 * 1024)
      throw new this.#target.inputError(
        `The ${this.#target.name} message is too large`,
      );
    return value;
  }

  requestId(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value))
      throw new this.#target.inputError(
        `Invalid ${this.#target.name} request ID`,
      );
    return value;
  }

  async read(targetId: string, sessionId: string): Promise<Session> {
    const session = await this.#target.read(sessionId, targetId);
    this.#target.assertOwner(session, targetId);
    return session;
  }

  async readCallContext(targetId: string, sessionId: string, callId: string) {
    return readAuthoringCallContext(
      await this.read(targetId, sessionId),
      callId,
    );
  }

  async readRequestPreviews(targetId: string, sessionId: string) {
    return authoringRequestPreviews(await this.read(targetId, sessionId));
  }

  async preview(targetId: string, sessionId?: string) {
    const session =
      sessionId === undefined ? null : await this.read(targetId, sessionId);
    const host = await this.#target.bindModelHost();
    if (session !== null)
      assertCompatibleAuthoring(session.modelBinding, session.modelItems, host);
    return this.#target.compilePreview(targetId, host);
  }

  async mutate<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#mutations.tail;
    let release: () => void = () => undefined;
    this.#mutations.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  cancel(sessionId: string, readIdleView: () => Promise<View>): Promise<View> {
    return this.conversation.cancel(sessionId) ?? this.mutate(readIdleView);
  }

  existingRequest(
    session: Session,
    requestId: string,
    checkGoogleConflict = false,
  ) {
    if (session.completedRequestIds.includes(requestId))
      return { session, run: null };
    return this.#runningRequest(session, requestId, checkGoogleConflict);
  }

  existingEdit(
    session: Session & Parameters<typeof completedAuthoringEdit>[0],
    edit: Parameters<typeof completedAuthoringEdit>[1],
  ) {
    if (completedAuthoringEdit(session, edit)) return { session, run: null };
    return this.#runningRequest(session, edit.requestId, false);
  }

  #runningRequest(
    session: Session,
    requestId: string,
    checkGoogleConflict: boolean,
  ) {
    const running = this.conversation.running(session.sessionId);
    if (running === null) return null;
    if (running.requestId !== requestId) {
      if (checkGoogleConflict) assertKnownAuthoringOutcome(session);
      throw new Error(
        `Another message in this ${this.#target.name} conversation is still running`,
      );
    }
    return { session, run: running.promise };
  }

  observeProgress<
    Status extends {
      selected: {
        sessionId: string;
        progress: { streaming: ModelToolConversationStreaming | null };
      } | null;
    },
  >(status: Status): Status {
    const selected = status.selected;
    if (selected === null) return status;
    return {
      ...status,
      selected: {
        ...selected,
        progress: {
          ...selected.progress,
          streaming: this.conversation.streaming(selected.sessionId),
        },
      },
    };
  }

  progress(session: Progress, observe = session.runStatus === "running") {
    const streaming = observe
      ? this.conversation.streaming(session.sessionId)
      : null;
    return {
      sessionId: session.sessionId,
      runStatus: streaming === null ? session.runStatus : ("running" as const),
      progress: {
        exchange: session.exchange,
        toolCalls: session.toolCalls,
        streaming,
        updatedAt: session.updatedAt,
      },
    };
  }

  view(session: Session) {
    return {
      ...this.progress(session),
      requestPreviews: authoringRequestIdentities(session),
      confirmedRequestIds: confirmedAuthoringRequestIds(session),
      messages: structuredClone(session.messages),
      usage: structuredClone(session.usage),
      lastFailure: session.lastFailure,
    };
  }
}

/** Shares live state across Runtime instances for one durable store. */
export class AuthoringLiveScopes<Value extends object> {
  readonly #scopes = new Map<string, WeakRef<Value>>();
  readonly #release = new FinalizationRegistry<{
    scope: string;
    reference: WeakRef<Value>;
  }>(({ scope, reference }) => {
    if (this.#scopes.get(scope) === reference) this.#scopes.delete(scope);
  });

  get(scope: string, create: () => Value): Value {
    const existing = this.#scopes.get(scope)?.deref();
    if (existing !== undefined) return existing;
    const value = create();
    const reference = new WeakRef(value);
    this.#scopes.set(scope, reference);
    this.#release.register(value, { scope, reference });
    return value;
  }
}

export function assertKnownAuthoringOutcome(
  session: ModelToolConversationState,
): void {
  if (session.googleOutcomeUnknown) throw new Error(unknownGoogleOutcome);
}

export function assertCanSendAuthoringMessage(
  session: ModelToolConversationState,
): void {
  if (session.runStatus === "paused" || canRetryAuthoringDispatch(session))
    throw new Error(
      "Resume the paused authoring request before sending another message",
    );
}

export function assertAuthoringFilePolicy(value: string): void {
  if (value !== "keep" && value !== "revert")
    throw new Error("Invalid file policy");
}

export function beginAuthoringRequest(
  session: ModelToolConversationState,
  host: ModelHost,
  requestId: string,
  message: string,
  compilation: Pick<AuthoringRequestSnapshot, "bootstrap" | "playPreset"> & {
    modelPrompt: AuthoringRequestSnapshot["modelPrompt"];
    preload: AuthoringRequestSnapshot["preload"];
  },
): void {
  session.requests ??= [];
  session.requests.push({
    requestId,
    modelBinding: structuredClone(host.binding()),
    modelItemStart: session.modelItems.length,
    bootstrap: compilation.bootstrap,
    ...(compilation.playPreset === undefined
      ? {}
      : { playPreset: structuredClone(compilation.playPreset) }),
    ...(compilation.modelPrompt === undefined
      ? {}
      : { modelPrompt: compilation.modelPrompt }),
    ...(compilation.preload === undefined
      ? {}
      : { preload: structuredClone(compilation.preload) }),
  });
  delete session.retryDispatch;
  appendAuthoringUserMessage(session, message, requestId);
  checkpointNextAuthoringDispatch(session, "dispatching");
  if (session.modelBinding.provider === "google_interactions")
    session.googleOutcomeUnknown = false;
}

export function captureAuthoringRequestPreview(
  session: ModelToolConversationState,
  host: ModelHost,
  requestId: string,
  boundaries?: RequestPreviewBoundaries,
): void {
  const snapshot = session.requests?.at(-1);
  if (
    snapshot?.requestId === requestId &&
    session.modelBinding.provider === "google_interactions" &&
    host.previewAuthoringRequest !== undefined
  )
    snapshot.wireRequest = host.previewAuthoringRequest(
      authoringExchange(session, requestId, boundaries, host.binding()),
    );
}

export function resumeAuthoringRequest(
  session: ModelToolConversationState,
  host: ModelHost,
  recovery?: "continue_partial",
): void {
  if (recovery === "continue_partial") prepareAuthoringPartial(session, host);
  else delete session.partialResponse;
  if (recovery !== "continue_partial" && !canRetryAuthoringDispatch(session)) {
    resumePausedAuthoringConversation(session);
    return;
  }
  session.runStatus = "running";
  session.activeRequestId = session.requests?.at(-1)?.requestId ?? null;
  session.lastFailure = null;
  session.updatedAt = Date.now();
}

/** Clears the live operation while retaining the request ID used for deduplication. */
export function finishInterruptedAuthoringRun(
  session: ModelToolConversationState,
  status: "paused" | "interrupted",
  message: string,
): void {
  const requestId = session.activeRequestId;
  session.runStatus = status;
  session.activeRequestId = null;
  if (requestId !== null)
    session.completedRequestIds = rememberAuthoringRequest(
      session.completedRequestIds,
      requestId,
    );
  session.lastFailure = session.googleOutcomeUnknown
    ? unknownGoogleOutcome
    : message;
  session.updatedAt = Date.now();
}

/** Reconstructs a retry marker only from a saved request and a complete transcript boundary. */
export function recoverLegacyGoogleDispatch(
  session: ModelToolConversationState,
  enableRetrySchema: () => void,
): boolean {
  const lastItem = session.modelItems.at(-1);
  if (
    session.pendingSettlement !== null ||
    session.modelBinding.provider !== "google_interactions" ||
    session.runStatus !== "interrupted" ||
    session.googleOutcomeUnknown === false ||
    session.retryDispatch !== undefined ||
    (lastItem?.kind !== "user" && lastItem?.kind !== "tool")
  )
    return false;
  if (session.requests?.at(-1) !== undefined) {
    enableRetrySchema();
    checkpointNextAuthoringDispatch(session, "retryable");
    session.googleOutcomeUnknown = false;
    session.lastFailure =
      "The previous model response was incomplete; retry from the last settled step.";
  } else {
    session.googleOutcomeUnknown = true;
    session.lastFailure =
      "The saved request is unavailable; start a fresh model context.";
  }
  session.updatedAt = Date.now();
  return true;
}
