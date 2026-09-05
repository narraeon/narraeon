import type {
  ListProviderModelsInput,
  ModelProviderKind,
  SaveModelConnectionInput,
} from "./modelConnections.ts";
import type { AppLocale, AppReadingPreferences } from "./appPreferences.ts";
import type { ModelUsage } from "./modelUsage.ts";
import { maxPortableContentArchiveBase64Characters } from "./contentTree.ts";

export interface ContentTreeFile {
  path: string;
  contents: string;
  encoding?: "base64";
}

export interface ModelBinding {
  provider: ModelProviderKind;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export const v1Protocol = "narraeon.runtime/v1" as const;

export interface V1Envelope {
  protocol: typeof v1Protocol;
  request: V1Request;
}

export type V1Request =
  | { type: "workspace.read" }
  | { type: "preferences.read" }
  | {
      type: "preferences.save";
      locale?: AppLocale;
      reading?: AppReadingPreferences;
    }
  | { type: "model.read" }
  | {
      type: "model.save";
      connection: SaveModelConnectionInput;
    }
  | { type: "model.copy"; connectionId: string; name: string }
  | { type: "model.select"; connectionId: string }
  | { type: "model.delete"; connectionId: string }
  | ({ type: "model.models" } & ListProviderModelsInput)
  | { type: "content.create" }
  | { type: "content.read"; packageId: string }
  | { type: "content.replace"; packageId: string; files: ContentTreeFile[] }
  | { type: "content.copy"; packageId: string }
  | { type: "content.delete"; packageId: string }
  | { type: "content.rename"; packageId: string; name: string }
  | { type: "content.import"; archiveBase64: string; title?: string }
  | { type: "content.export"; packageId: string }
  | { type: "setting-improvement.read"; packageId: string }
  | {
      type: "setting-improvement.status";
      packageId: string;
      sessionId?: string;
    }
  | { type: "setting-improvement.overview"; packageId: string }
  | {
      type: "setting-improvement.session.read";
      packageId: string;
      sessionId: string;
    }
  | {
      type: "setting-improvement.session.delete";
      packageId: string;
      sessionId: string;
    }
  | {
      type: "setting-improvement.rollback";
      packageId: string;
      sessionId: string;
      changeSetId: string;
      path: string;
    }
  | {
      type: "setting-improvement.message";
      packageId: string;
      requestId: string;
      message: string;
      continuation:
        | { kind: "fresh_context" }
        | { kind: "continue_context"; sessionId: string };
    }
  | { type: "setting-improvement.cancel"; sessionId: string }
  | { type: "play.read" }
  | { type: "play.create"; name: string; files?: Record<string, string> }
  | { type: "play.copy"; presetId: string }
  | {
      type: "play.save";
      presetId: string;
      name: string;
      files: Record<string, string>;
      structure?: Record<string, unknown>;
    }
  | { type: "play.rename"; presetId: string; name: string }
  | { type: "play.delete"; presetId: string }
  | { type: "play.enable"; presetId: string; enabled: boolean }
  | { type: "play.scripts"; presetId: string; enabled: boolean }
  | { type: "play.select"; presetId: string }
  | { type: "play.export"; presetId: string }
  | {
      type: "play.import";
      name: string;
      files: ContentTreeFile[];
    }
  | { type: "play.workbench.read"; presetId?: string; revision?: string }
  | {
      type: "prompt.preview";
      packageId: string;
      playerInput: string;
      model: ModelBinding;
      playPresetId?: string;
      playPresetRevision?: string;
    }
  | {
      type: "world.create";
      operationId: string;
      packageId: string;
      model: ModelBinding;
    }
  | { type: "world.read"; worldId: string }
  | { type: "world.rename"; worldId: string; name: string }
  | { type: "world.delete"; worldId: string }
  | { type: "artifacts.read"; worldId: string; channel?: string }
  | { type: "artifacts.debug"; worldId: string; operationId?: string }
  | { type: "world.creation-outcome"; operationId: string }
  | { type: "world.repair-materialization"; worldId: string }
  | {
      type: "world.control-draft.save";
      worldId: string;
      files: ContentTreeFile[];
    }
  | { type: "world.control-draft.preview"; worldId: string }
  | { type: "world.control-draft.apply"; worldId: string }
  | {
      type: "world.derive";
      operationId: string;
      sourceWorldId: string;
      sourceHead: string;
    }
  | {
      type: "play.chain.revise-player";
      operationId: string;
      worldId: string;
      chainId: string;
      eventId: number;
      replacementExchangeId: string;
      replacementText: string;
      continuation: "continue_context" | "fresh_context";
    }
  | {
      type: "play.chain.start";
      worldId: string;
      chainId: string;
      exchangeId: string;
      playerText: string;
    }
  | {
      type: "play.chain.append";
      worldId: string;
      chainId: string;
      exchangeId: string;
      playerText: string;
    }
  | {
      type: "play.chain.cancel";
      worldId: string;
      chainId: string;
      exchangeId: string;
    }
  | { type: "play.chain.inspect"; worldId: string }
  | {
      type: "play.timeline.page";
      worldId: string;
      limit: number;
      cursor?: string;
    }
  | {
      type: "play.timeline.detail";
      worldId: string;
      chainId: string;
      eventId: number;
    }
  | { type: "world.play-context.read"; worldId: string }
  | {
      type: "world.surface.read";
      worldId: string;
      surface: "state" | "control" | "history" | "runtime";
    }
  | { type: "world.play-decorations.read"; worldId: string }
  | { type: "correction.begin"; worldId: string; operationId: string }
  | { type: "correction.read"; candidateId: string; document: string }
  | {
      type: "correction.patch";
      candidateId: string;
      expectedVersion: number;
      target: string;
      expectedHash: string;
      edits: unknown[];
    }
  | {
      type: "correction.replace";
      candidateId: string;
      expectedVersion: number;
      target: string;
      expectedHash: string;
      contents: string;
    }
  | {
      type: "correction.preview";
      candidateId: string;
      expectedVersion: number;
    }
  | {
      type: "correction.apply";
      candidateId: string;
      expectedVersion: number;
    }
  | {
      type: "correction.cancel";
      candidateId: string;
      expectedVersion: number;
    };

export interface V1Response {
  protocol: typeof v1Protocol;
  result: unknown;
}

export interface V1SettingConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface V1SettingConversationToolCall {
  callId: string;
  name: string;
  arguments: unknown;
  result: {
    markdown: string;
    isError: boolean;
    /** Changes already published to the content package current tree. */
    changes: V1SettingAuthoringDiff[];
    /** Stable identity of this successful, non-empty historical change set. */
    changeSetId: string | null;
  } | null;
}

export interface V1SettingConversationExchange {
  id: string;
  exchange: number;
  text: string;
  /** Exact Provider-returned reasoning only; never inferred chain of thought. */
  reasoning?: string;
  toolCalls: V1SettingConversationToolCall[];
}

export interface V1SettingConversationTurn {
  id: string;
  user: V1SettingConversationMessage;
  exchanges: V1SettingConversationExchange[];
}

export interface V1SettingImprovementHistoryItem {
  sessionId: string;
  runStatus: "ready" | "running" | "interrupted";
  createdAt: number;
  updatedAt: number;
  excerpt: string;
  turnCount: number;
  exchangeCount: number;
  toolCallCount: number;
  changedFileCount: number;
}

export interface V1SettingImprovementOverview {
  latest: V1SettingImprovementView | null;
  history: V1SettingImprovementHistoryItem[];
}

export interface V1SettingImprovementStatus {
  /** Changes only when durable conversation/history state changes. */
  revision: string;
  selected: null | {
    sessionId: string;
    runStatus: "ready" | "running" | "interrupted";
    progress: V1SettingImprovementView["progress"];
  };
}

export interface V1SettingAuthoringDiff {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string | null;
  after: string | null;
}

export interface V1SettingImprovementRollbackResult {
  status: "rolled_back" | "already_rolled_back";
  changeSetId: string;
  path: string;
  /** The inverse diff published by this rollback; empty for an idempotent retry. */
  changes: V1SettingAuthoringDiff[];
}

export interface V1SettingPromptPreview {
  diagnosticBinding: {
    endpoint: string;
    commit: string;
    hostPresetId: string;
    controlFingerprint: string;
    modelId: string;
  };
  compilation: {
    logicalMessages: {
      role: string;
      markdown: string;
      blocks: { source: string; markdown: string }[];
    }[];
    provider: unknown;
    tools: { name: string; description: string; inputSchema: object }[];
    coverage: {
      slot: string;
      source: string;
      status: string;
      complete: boolean;
      continuation: string | null;
      readAuthorization?: {
        shortRef: string;
        locator:
          | { yaml: readonly (string | number)[] }
          | { markdown: readonly string[] }
          | null;
      };
      catalogEntries?: string[];
    }[];
    budget: {
      estimator: "conservative_utf8_bytes" | "disabled";
      messageTokens: number;
      toolTokens: number;
      outputReserveTokens: number;
      forcedTailReserveTokens: number;
      safetyMarginTokens: number;
      requiredTokens: number;
      contextWindowTokens: number;
      status: "fits" | "over_budget" | "not_checked";
    };
    cache: {
      strategy:
        | "explicit_anthropic_blocks"
        | "explicit_cliproxyapi_message"
        | "provider_managed";
      stablePrefixFingerprint: string;
      breakpoints: string[];
      estimatedCacheableBytes: number;
      firstDynamicByte: number;
    };
  };
  leakage: { status: "clean"; checkedFields: string[] };
}

export interface V1PlayContextReadingView {
  worldId: string;
  worldHead: string;
  currentContext: {
    chainId: string;
    baselineHead: string;
    parentHead: string;
    stale: boolean;
    playPreset: V1PlayCallChainContextView["playPreset"];
    updatedAt: number;
    bootstrap: Pick<
      V1SettingPromptPreview["compilation"],
      "logicalMessages" | "coverage"
    >;
    reads: {
      eventId: number;
      callId: string;
      ref: string;
      ok: boolean;
      complete: boolean | null;
      markdown: string | null;
      locator:
        | { yaml: readonly (string | number)[] }
        | { markdown: readonly string[] }
        | null;
    }[];
  } | null;
  nextFreshContext: {
    head: string;
    preview: V1SettingPromptPreview;
  } | null;
}

export interface V1SettingImprovementView {
  sessionId: string;
  packageId: string;
  runStatus: "ready" | "running" | "interrupted";
  messages: V1SettingConversationMessage[];
  turns: V1SettingConversationTurn[];
  /** Audit-only changes from a pre-v2 isolated draft; never auto-applied. */
  legacyDraft: null | {
    outcome:
      "applied" | "discarded" | "unapplied_dropped" | "apply_outcome_unknown";
    changes: V1SettingAuthoringDiff[];
  };
  usage: ModelUsage;
  progress: {
    exchange: number;
    toolCalls: number;
    streaming: {
      reasoningChars: number;
      textChars: number;
      toolChars: number;
      tail: string;
      /** Current incomplete Provider-returned reasoning, available in-process. */
      reasoningText?: string;
      /** Current incomplete visible model text, available in-process. */
      visibleText?: string;
      /** Current incomplete tool-call argument fragments, available in-process. */
      toolFragment?: string;
      receivedAt: number;
    } | null;
    updatedAt: number;
  };
  lastFailure: string | null;
}

export type V1PlayCallChainStatus = "ready" | "running" | "interrupted";

export type V1PlayRunPhase =
  | "preparing"
  | "waiting"
  | "reasoning"
  | "text"
  | "tool"
  | "followup"
  | "cancelling";

/** Ephemeral observation of the one model invocation currently owned by Runtime. */
export interface V1PlayRunProgress {
  chainId: string;
  exchangeId: string;
  phase: V1PlayRunPhase;
  startedAt: number;
  lastActivityAt: number;
  reasoningChars: number;
  textChars: number;
  toolChars: number;
  toolCalls: number;
  dispatches: number;
}

export type V1AssistantResponseKind =
  "pending" | "narrative" | "tool_step" | "empty";

export type V1PlayCallChainEvent =
  | {
      id: number;
      kind: "player";
      exchangeId: string;
      text: string;
      context: "fresh" | "append";
      committedHead?: string;
    }
  | {
      id: number;
      kind: "assistant";
      text: string;
      status: "streaming" | "completed" | "interrupted";
      /**
       * Runtime's settlement classification for the response text. Optional
       * only for timelines written before this classification was persisted.
       */
      responseKind?: V1AssistantResponseKind;
      /** AI checkpoint declaration made effective by this narrative commit. */
      checkpoint?: true;
      exchange: number;
      attempt: number;
      reasoning?: string;
      toolFragment?: string;
      usage?: ModelUsage;
      stopReason?: string;
      continuation?: "available" | "unavailable";
      committedHead?: string;
    }
  | {
      id: number;
      kind: "tool_call";
      callId: string;
      name: string;
      arguments: unknown;
      replayed: boolean;
    }
  | {
      id: number;
      kind: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      markdown: string;
      replayed: boolean;
    }
  | {
      /**
       * One derived request run after the model exchange settled. It is shown
       * in the trace but is not part of the chain transcript: it never enters a
       * later model request, and the next player message follows the narrative.
       */
      id: number;
      kind: "followup";
      followupId: string;
      displayName: string;
      text: string;
      reasoning?: string;
      usage?: ModelUsage;
      toolCalls: {
        callId: string;
        name: string;
        arguments: unknown;
        ok: boolean;
        markdown: string;
      }[];
      failure?: string;
    }
  | {
      id: number;
      kind: "failure";
      message: string;
    }
  | {
      id: number;
      kind: "cancellation";
      message: string;
    };

export type V1PlayTimelineEventSummary =
  | Extract<V1PlayCallChainEvent, { kind: "player" }>
  | (Omit<
      Extract<V1PlayCallChainEvent, { kind: "assistant" }>,
      "reasoning" | "toolFragment"
    > & {
      hasReasoning: boolean;
      hasToolFragment: boolean;
      hasUsage: boolean;
      detailsAvailable: boolean;
    })
  | (Omit<Extract<V1PlayCallChainEvent, { kind: "tool_call" }>, "arguments"> & {
      detailsAvailable: true;
    })
  | (Omit<
      Extract<V1PlayCallChainEvent, { kind: "tool_result" }>,
      "markdown"
    > & { detailsAvailable: true })
  | {
      id: number;
      kind: "followup";
      followupId: string;
      displayName: string;
      toolCallCount: number;
      failed: boolean;
      usage?: ModelUsage;
      detailsAvailable: true;
    }
  | Extract<V1PlayCallChainEvent, { kind: "failure" | "cancellation" }>;

export type V1PlayTimelineItem =
  | {
      kind: "context_boundary";
      chainId: string;
      playPreset: { id: string; name: string; revision: string };
      changedDocuments: V1PlayCallChainContextView["changedDocuments"];
      current: boolean;
    }
  | {
      kind: "event";
      chainId: string;
      current: boolean;
      event: V1PlayTimelineEventSummary;
    }
  | {
      kind: "genesis";
      messageId: string;
      role: "player" | "narrator";
      exactText: string;
    };

export interface V1PlayTimelinePage {
  worldId: string;
  generation: string;
  activeChainId: string | null;
  activeStatus: V1PlayCallChainStatus | null;
  activeCanRetry: boolean;
  activeLastFailure: string | null;
  items: V1PlayTimelineItem[];
  nextCursor: string | null;
}

/** One model context as projected into the durable player-visible timeline. */
export interface V1PlayCallChainContextView {
  chainId: string;
  baselineHead: string;
  /** Number of committed messages that precede the first event in this chain. */
  baselineHistoryLength?: number;
  parentHead: string;
  playPreset: { id: string; name: string; revision: string };
  status: V1PlayCallChainStatus;
  canRetry: boolean;
  events: V1PlayCallChainEvent[];
  changedDocuments: {
    kind: "create" | "replace";
    ref: string;
    path: string;
  }[];
  lastFailure: string | null;
  updatedAt: number;
}

/**
 * Durable model-directed play context. Starting fresh replaces only the
 * active model transcript; previous contexts remain available to the player
 * as an append-only display timeline.
 */
export interface V1PlayCallChainView extends V1PlayCallChainContextView {
  worldId: string;
  previousContexts: V1PlayCallChainContextView[];
  /** Present only while this Runtime process owns the active invocation. */
  activeInvocation?: V1PlayRunProgress;
}

/** Incremental browser projection of the Provider stream. */
export type V1PlayCallChainStreamFrame =
  | {
      kind: "snapshot";
      value: V1PlayCallChainView;
      final: boolean;
    }
  | {
      kind: "assistant_delta";
      eventId: number;
      deltaKind: "reasoning" | "text" | "tool";
      text: string;
      updatedAt: number;
    }
  | {
      kind: "error";
      message: string;
    };

export class V1ProtocolError extends Error {
  readonly code: "incompatible_data" | "invalid_request";

  constructor(
    code: V1ProtocolError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "V1ProtocolError";
    this.code = code;
  }
}

export function parseV1Envelope(value: unknown): V1Envelope {
  if (!isRecord(value) || value.protocol !== v1Protocol)
    throw new V1ProtocolError(
      "incompatible_data",
      "Requests must use the current narraeon.runtime/v1 protocol",
    );
  if (!isRecord(value.request) || typeof value.request.type !== "string")
    throw new V1ProtocolError(
      "invalid_request",
      "V1 request is missing request.type",
    );
  if (!requestTypes.has(value.request.type))
    throw new V1ProtocolError(
      "invalid_request",
      `V1 does not support command: ${value.request.type}`,
    );
  validateRequestFields(value.request);
  return value as unknown as V1Envelope;
}

const requiredFields: Record<
  string,
  Record<string, "string" | "number" | "boolean" | "object" | "array">
> = {
  "preferences.save": {},
  "model.save": { connection: "object" },
  "model.copy": { connectionId: "string", name: "string" },
  "model.select": { connectionId: "string" },
  "model.delete": { connectionId: "string" },
  "model.models": { provider: "string", baseUrl: "string" },
  "content.read": { packageId: "string" },
  "content.replace": { packageId: "string", files: "array" },
  "content.copy": { packageId: "string" },
  "content.delete": { packageId: "string" },
  "content.rename": { packageId: "string", name: "string" },
  "content.import": { archiveBase64: "string" },
  "content.export": { packageId: "string" },
  "setting-improvement.read": { packageId: "string" },
  "setting-improvement.status": { packageId: "string" },
  "setting-improvement.overview": { packageId: "string" },
  "setting-improvement.session.read": {
    packageId: "string",
    sessionId: "string",
  },
  "setting-improvement.session.delete": {
    packageId: "string",
    sessionId: "string",
  },
  "setting-improvement.rollback": {
    packageId: "string",
    sessionId: "string",
    changeSetId: "string",
    path: "string",
  },
  "setting-improvement.message": {
    packageId: "string",
    requestId: "string",
    message: "string",
    continuation: "object",
  },
  "setting-improvement.cancel": { sessionId: "string" },
  "play.create": { name: "string" },
  "play.copy": { presetId: "string" },
  "play.save": { presetId: "string", name: "string", files: "object" },
  "play.rename": { presetId: "string", name: "string" },
  "play.delete": { presetId: "string" },
  "play.enable": { presetId: "string", enabled: "boolean" },
  "play.scripts": { presetId: "string", enabled: "boolean" },
  "play.select": { presetId: "string" },
  "play.export": { presetId: "string" },
  "play.import": { name: "string", files: "array" },
  "play.workbench.read": {},
  "prompt.preview": {
    packageId: "string",
    playerInput: "string",
    model: "object",
  },
  "world.create": {
    operationId: "string",
    packageId: "string",
    model: "object",
  },
  "world.read": { worldId: "string" },
  "world.rename": { worldId: "string", name: "string" },
  "world.delete": { worldId: "string" },
  "artifacts.read": { worldId: "string" },
  "artifacts.debug": { worldId: "string" },
  "world.creation-outcome": { operationId: "string" },
  "world.repair-materialization": { worldId: "string" },
  "world.control-draft.save": { worldId: "string", files: "array" },
  "world.control-draft.preview": { worldId: "string" },
  "world.control-draft.apply": { worldId: "string" },
  "world.derive": {
    operationId: "string",
    sourceWorldId: "string",
    sourceHead: "string",
  },
  "play.chain.revise-player": {
    operationId: "string",
    worldId: "string",
    chainId: "string",
    eventId: "number",
    replacementExchangeId: "string",
    replacementText: "string",
    continuation: "string",
  },
  "play.chain.start": {
    worldId: "string",
    chainId: "string",
    exchangeId: "string",
    playerText: "string",
  },
  "play.chain.append": {
    worldId: "string",
    chainId: "string",
    exchangeId: "string",
    playerText: "string",
  },
  "play.chain.cancel": {
    worldId: "string",
    chainId: "string",
    exchangeId: "string",
  },
  "play.chain.inspect": { worldId: "string" },
  "play.timeline.page": { worldId: "string", limit: "number" },
  "play.timeline.detail": {
    worldId: "string",
    chainId: "string",
    eventId: "number",
  },
  "world.play-context.read": { worldId: "string" },
  "world.surface.read": { worldId: "string", surface: "string" },
  "world.play-decorations.read": { worldId: "string" },
  "correction.begin": { worldId: "string", operationId: "string" },
  "correction.read": { candidateId: "string", document: "string" },
  "correction.patch": {
    candidateId: "string",
    expectedVersion: "number",
    target: "string",
    expectedHash: "string",
    edits: "array",
  },
  "correction.replace": {
    candidateId: "string",
    expectedVersion: "number",
    target: "string",
    expectedHash: "string",
    contents: "string",
  },
  "correction.preview": { candidateId: "string", expectedVersion: "number" },
  "correction.apply": { candidateId: "string", expectedVersion: "number" },
  "correction.cancel": { candidateId: "string", expectedVersion: "number" },
};

function validateRequestFields(request: Record<string, unknown>): void {
  for (const [field, kind] of Object.entries(
    requiredFields[request.type as string] ?? {},
  )) {
    const value = request[field];
    const valid =
      kind === "array"
        ? Array.isArray(value)
        : kind === "object"
          ? isRecord(value)
          : typeof value === kind;
    const allowsEmptyString =
      request.type === "play.chain.append" && field === "playerText";
    if (!valid || (kind === "string" && value === "" && !allowsEmptyString))
      throw new V1ProtocolError(
        "invalid_request",
        `${String(request.type)}.${field} is invalid`,
      );
  }
  if (request.type === "preferences.save") {
    if (
      (request.locale === undefined && request.reading === undefined) ||
      Object.keys(request).some(
        (key) => key !== "type" && key !== "locale" && key !== "reading",
      )
    )
      throw new V1ProtocolError(
        "invalid_request",
        "preferences.save must update locale or reading preferences",
      );
    if (
      request.locale !== undefined &&
      request.locale !== "en" &&
      request.locale !== "zh-CN"
    )
      throw new V1ProtocolError(
        "invalid_request",
        "preferences.save.locale must be en or zh-CN",
      );
    if (
      request.reading !== undefined &&
      !isValidReadingPreferences(request.reading)
    )
      throw new V1ProtocolError(
        "invalid_request",
        "preferences.save.reading is invalid",
      );
  }
  if (request.type === "content.import") {
    const archiveBase64 = request.archiveBase64 as string;
    if (
      archiveBase64.length > maxPortableContentArchiveBase64Characters ||
      archiveBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        archiveBase64,
      )
    )
      throw new V1ProtocolError(
        "invalid_request",
        "content.import.archiveBase64 is not a supported content-package ZIP",
      );
    if (
      request.title !== undefined &&
      (typeof request.title !== "string" ||
        request.title.trim().length === 0 ||
        !/^[^\r\n]{1,160}$/u.test(request.title.trim()))
    )
      throw new V1ProtocolError(
        "invalid_request",
        "content.import.title is invalid",
      );
    const unexpectedFields = Object.keys(request).filter(
      (field) =>
        field !== "type" && field !== "archiveBase64" && field !== "title",
    );
    if (unexpectedFields.length > 0)
      throw new V1ProtocolError(
        "invalid_request",
        `content.import contains unsupported fields: ${unexpectedFields.join(", ")}`,
      );
    return;
  }
  if (request.type === "prompt.preview" && request.playPresetId !== undefined) {
    if (typeof request.playPresetId !== "string" || request.playPresetId === "")
      throw new V1ProtocolError(
        "invalid_request",
        "prompt.preview.playPresetId is invalid",
      );
  }
  if (
    request.type === "prompt.preview" &&
    request.playPresetRevision !== undefined &&
    (typeof request.playPresetRevision !== "string" ||
      request.playPresetRevision === "")
  )
    throw new V1ProtocolError(
      "invalid_request",
      "prompt.preview.playPresetRevision is invalid",
    );
  if (
    request.type === "prompt.preview" &&
    request.playPresetRevision !== undefined &&
    request.playPresetId === undefined
  )
    throw new V1ProtocolError(
      "invalid_request",
      "prompt.preview.playPresetRevision must be provided with playPresetId",
    );
  if (request.type === "play.create" && request.files !== undefined) {
    if (
      !isRecord(request.files) ||
      !Object.values(request.files).every(
        (contents) => typeof contents === "string",
      )
    )
      throw new V1ProtocolError(
        "invalid_request",
        "play.create.files must be Record<string,string>",
      );
  }
  if (
    request.type === "play.save" &&
    !Object.values(request.files as Record<string, unknown>).every(
      (contents) => typeof contents === "string",
    )
  )
    throw new V1ProtocolError(
      "invalid_request",
      "play.save.files must be Record<string,string>",
    );
  if (
    request.type === "play.save" &&
    request.structure !== undefined &&
    !isRecord(request.structure)
  )
    throw new V1ProtocolError(
      "invalid_request",
      "play.save.structure must be a structured map",
    );
  if (request.type === "play.workbench.read") {
    if (
      request.presetId !== undefined &&
      (typeof request.presetId !== "string" || request.presetId === "")
    )
      throw new V1ProtocolError(
        "invalid_request",
        "play.workbench.read.presetId is invalid",
      );
    if (
      request.revision !== undefined &&
      (typeof request.revision !== "string" || request.revision === "")
    )
      throw new V1ProtocolError(
        "invalid_request",
        "play.workbench.read.revision is invalid",
      );
    if (request.revision !== undefined && request.presetId === undefined)
      throw new V1ProtocolError(
        "invalid_request",
        "play.workbench.read.revision must be provided with presetId",
      );
  }
  if (request.type === "play.import") {
    if (
      !(request.files as unknown[]).every(
        (file) =>
          isRecord(file) &&
          typeof file.path === "string" &&
          typeof file.contents === "string" &&
          file.encoding === undefined,
      )
    )
      throw new V1ProtocolError(
        "invalid_request",
        "play.import.files is invalid",
      );
  }
  if (
    (request.type === "artifacts.read" || request.type === "artifacts.debug") &&
    "channel" in request &&
    request.channel !== undefined &&
    (typeof request.channel !== "string" || request.channel.length === 0)
  )
    throw new V1ProtocolError(
      "invalid_request",
      `${request.type}.channel is invalid`,
    );
  if (
    request.type === "artifacts.debug" &&
    request.operationId !== undefined &&
    (typeof request.operationId !== "string" || request.operationId === "")
  )
    throw new V1ProtocolError(
      "invalid_request",
      "artifacts.debug.operationId is invalid",
    );
  if (request.type === "play.timeline.page") {
    if (
      !Number.isSafeInteger(request.limit) ||
      Number(request.limit) < 1 ||
      Number(request.limit) > 100 ||
      (request.cursor !== undefined &&
        (typeof request.cursor !== "string" || request.cursor === ""))
    )
      throw new V1ProtocolError(
        "invalid_request",
        "play.timeline.page pagination is invalid",
      );
  }
  if (
    request.type === "play.timeline.detail" &&
    (!Number.isSafeInteger(request.eventId) || Number(request.eventId) < 1)
  )
    throw new V1ProtocolError(
      "invalid_request",
      "play.timeline.detail.eventId is invalid",
    );
  if (
    request.type === "play.chain.revise-player" &&
    request.continuation !== "continue_context" &&
    request.continuation !== "fresh_context"
  )
    throw new V1ProtocolError(
      "invalid_request",
      "play.chain.revise-player.continuation is invalid",
    );
  if (
    request.type === "world.surface.read" &&
    request.surface !== "state" &&
    request.surface !== "control" &&
    request.surface !== "history" &&
    request.surface !== "runtime"
  )
    throw new V1ProtocolError(
      "invalid_request",
      "world.surface.read.surface is invalid",
    );
  if (request.type === "setting-improvement.message") {
    const continuation = request.continuation;
    if (
      !isRecord(continuation) ||
      (continuation.kind !== "fresh_context" &&
        continuation.kind !== "continue_context") ||
      (continuation.kind === "continue_context" &&
        typeof continuation.sessionId !== "string") ||
      (continuation.kind === "fresh_context" && "sessionId" in continuation)
    )
      throw new V1ProtocolError(
        "invalid_request",
        "setting-improvement.message.continuation is invalid",
      );
  }
  if (
    request.type === "setting-improvement.rollback" &&
    (typeof request.changeSetId !== "string" ||
      !/^change-set:(0|[1-9][0-9]*)$/u.test(request.changeSetId))
  )
    throw new V1ProtocolError(
      "invalid_request",
      "setting-improvement.rollback.changeSetId is invalid",
    );
}

const requestTypes = new Set([
  "workspace.read",
  "preferences.read",
  "preferences.save",
  "model.read",
  "model.save",
  "model.copy",
  "model.select",
  "model.delete",
  "model.models",
  "content.create",
  "content.read",
  "content.replace",
  "content.copy",
  "content.delete",
  "content.rename",
  "content.import",
  "content.export",
  "setting-improvement.read",
  "setting-improvement.status",
  "setting-improvement.overview",
  "setting-improvement.session.read",
  "setting-improvement.session.delete",
  "setting-improvement.rollback",
  "setting-improvement.message",
  "setting-improvement.cancel",
  "play.read",
  "play.create",
  "play.copy",
  "play.save",
  "play.rename",
  "play.delete",
  "play.enable",
  "play.scripts",
  "play.select",
  "play.export",
  "play.import",
  "play.workbench.read",
  "prompt.preview",
  "world.create",
  "world.read",
  "world.rename",
  "world.delete",
  "artifacts.read",
  "artifacts.debug",
  "world.creation-outcome",
  "world.repair-materialization",
  "world.control-draft.save",
  "world.control-draft.preview",
  "world.control-draft.apply",
  "world.derive",
  "play.chain.revise-player",
  "play.chain.start",
  "play.chain.append",
  "play.chain.cancel",
  "play.chain.inspect",
  "play.timeline.page",
  "play.timeline.detail",
  "world.play-context.read",
  "world.surface.read",
  "world.play-decorations.read",
  "correction.begin",
  "correction.read",
  "correction.patch",
  "correction.replace",
  "correction.preview",
  "correction.apply",
  "correction.cancel",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidReadingPreferences(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 5 &&
    (value.density === "compact" ||
      value.density === "standard" ||
      value.density === "relaxed") &&
    isFiniteRange(value.fontSize, 15, 24) &&
    isFiniteRange(value.lineHeight, 1.4, 2.4) &&
    isFiniteRange(value.letterSpacing, 0, 0.12) &&
    isFiniteRange(value.measure, 32, 72)
  );
}

function isFiniteRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}
