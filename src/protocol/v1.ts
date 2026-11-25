import { maxPortableContentArchiveBase64Characters } from "./contentTree.ts";
import type { ModelRetryEvidence } from "./modelRetry.ts";
import type { ContentSelection } from "./sillyTavernContent.ts";
import type { Gameplay, ResolutionScheme } from "./gameplay.ts";
import type { ResolutionReceipt } from "./resolution.ts";
import type { SaveProtagonistTemplateInput } from "./protagonistTemplates.ts";
import type { WorldArchiveErrorCode } from "./worldArchives.ts";
import type { WorldExtensionChoice } from "./worldExtensions.ts";
import type { WorldPromptPrefixComparison } from "./worldPromptDiagnostics.ts";
import type { WorldPromptMaintenance } from "./worldMaintenance.ts";
import type {
  ListProviderModelsInput,
  ModelProviderKind,
  SaveModelConnectionInput,
} from "./modelConnections.ts";
import type { AppLocale, AppReadingPreferences } from "./appPreferences.ts";
import type { ModelUsage } from "./modelUsage.ts";
import type { FreshContextReason, PlayFailureKind } from "./playFailure.ts";
import { isV1RequestType, validateV1Request } from "./v1RequestValidation.ts";
import { v1Protocol } from "./v1Version.ts";

export { v1Protocol } from "./v1Version.ts";

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

export const v1RuntimeRequestBodyLimit =
  maxPortableContentArchiveBase64Characters + 64 * 1024;

export type V1StoryExportFormat = "markdown" | "text";

export interface V1StoryExport {
  fileName: string;
  content: string;
}

export interface V1Envelope {
  protocol: typeof v1Protocol;
  request: V1Request;
}

export type V1Request =
  | { type: "world.revision.preview"; worldId: string; sessionId?: string }
  | {
      type: "setting-improvement.call.context";
      packageId: string;
      sessionId: string;
      callId: string;
    }
  | {
      type: "world.revision.call.context";
      worldId: string;
      sessionId: string;
      callId: string;
    }
  | {
      type: "setting-improvement.request.preview";
      packageId: string;
      sessionId: string;
      requestId: string;
    }
  | {
      type: "world.revision.request.preview";
      worldId: string;
      sessionId: string;
      requestId: string;
    }
  | {
      type: "setting-improvement.preview";
      packageId: string;
      sessionId?: string;
    }
  | { type: "workspace.read" }
  | { type: "preferences.read" }
  | {
      type: "preferences.save";
      locale?: AppLocale;
      reading?: AppReadingPreferences;
    }
  | { type: "protagonist-templates.read" }
  | ({ type: "protagonist-templates.save" } & SaveProtagonistTemplateInput)
  | { type: "protagonist-templates.copy"; id: string }
  | { type: "protagonist-templates.delete"; id: string }
  | { type: "model.read" }
  | {
      type: "model.save";
      connection: SaveModelConnectionInput;
    }
  | { type: "model.copy"; connectionId: string; name: string }
  | { type: "model.select"; connectionId: string }
  | { type: "model.delete"; connectionId: string }
  | ({ type: "model.models" } & ListProviderModelsInput)
  | { type: "content.create"; gameplay?: Gameplay }
  | {
      type: "content.gameplay.set";
      packageId: string;
      scheme: ResolutionScheme;
    }
  | { type: "content.create-sample"; locale: AppLocale }
  | { type: "content.scripts.read"; packageId: string }
  | { type: "content.scripts.set"; packageId: string; enabled: boolean }
  | { type: "world.package-scripts.read"; worldId: string }
  | { type: "world.package-scripts.set"; worldId: string; enabled: boolean }
  | { type: "content.read"; packageId: string }
  | {
      type: "content.replace";
      packageId: string;
      files: ContentTreeFile[];
      /** The `treeRevision` the draft was opened from; a stale base is rejected with `content_conflict`. */
      baseTreeRevision: string;
    }
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
  | {
      type: "setting-improvement.message.edit";
      packageId: string;
      sessionId: string;
      requestId: string;
      messageId: string;
      message: string;
      filePolicy: "keep" | "revert";
    }
  | { type: "setting-improvement.cancel"; sessionId: string }
  | {
      type: "setting-improvement.resume";
      recovery?: "continue_partial";
      packageId: string;
      sessionId: string;
      requestId: string;
    }
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
  | { type: "content.sillytavern.inspect"; source: string }
  | {
      type: "content.sillytavern.preview" | "content.sillytavern.import";
      source: string;
      name: string;
      selection: ContentSelection;
    }
  | { type: "play.sillytavern.inspect"; source: string; groupId?: string }
  | {
      type: "play.sillytavern.preview" | "play.sillytavern.import";
      source: string;
      groupId?: string;
      selected: string[];
      name: string;
    }
  | {
      type: "play.workbench.read";
      presetId?: string;
      revision?: string;
      worldId?: string;
      draft?: {
        files: Record<string, string>;
        structure?: Record<string, unknown>;
      };
    }
  | {
      type: "prompt.preview";
      packageId: string;
      playerInput: string;
      turnNote?: string;
      model: ModelBinding;
      playPresetId?: string;
      playPresetRevision?: string;
    }
  | {
      type: "world.create";
      operationId: string;
      packageId: string;
      /** Older callers can still request a preview with the active connection. */
      model?: ModelBinding;
    }
  | { type: "world.archive.export"; worldId: string; operationId: string }
  | { type: "world.archive.import"; operationId: string; uploadId: string }
  | { type: "world.read"; worldId: string }
  | { type: "world.rename"; worldId: string; name: string }
  | {
      type: "world.story.export";
      worldId: string;
      format: V1StoryExportFormat;
    }
  | { type: "world.delete"; worldId: string }
  | { type: "artifacts.read"; worldId: string; channel?: string }
  | { type: "artifacts.debug"; worldId: string; operationId?: string }
  | { type: "world.creation-outcome"; operationId: string }
  | {
      type: "world.control-draft.save";
      worldId: string;
      files: ContentTreeFile[];
    }
  | { type: "world.control-draft.preview"; worldId: string }
  | { type: "world.control-draft.apply"; worldId: string }
  | { type: "world.revision.open"; worldId: string }
  | { type: "world.revision.overview"; worldId: string }
  | { type: "world.revision.status"; worldId: string; sessionId?: string }
  | {
      type: "world.revision.session.read";
      worldId: string;
      sessionId: string;
    }
  | {
      type: "world.revision.session.delete";
      worldId: string;
      sessionId: string;
    }
  | {
      type: "world.revision.message";
      worldId: string;
      requestId: string;
      message: string;
      continuation:
        | { kind: "fresh_context" }
        | { kind: "continue_context"; sessionId: string };
    }
  | {
      type: "world.revision.message.edit";
      worldId: string;
      sessionId: string;
      requestId: string;
      messageId: string;
      message: string;
      filePolicy: "keep" | "revert";
    }
  | { type: "world.revision.cancel"; sessionId: string }
  | {
      type: "world.revision.resume";
      recovery?: "continue_partial";
      worldId: string;
      sessionId: string;
      requestId: string;
    }
  | {
      type: "world.revision.files.replace";
      worldId: string;
      epochId: string;
      expectedRevision: string;
      files: ContentTreeFile[];
    }
  | {
      type: "world.revision.rollback";
      worldId: string;
      epochId: string;
      changeSetId: string;
      path: string;
    }
  | {
      type: "world.revision.apply";
      worldId: string;
      epochId: string;
      expectedRevision: string;
    }
  | {
      type: "world.revision.discard";
      worldId: string;
      epochId: string;
      expectedRevision?: string;
    }
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
      turnNote?: string;
      continuation: "auto" | "continue_context" | "fresh_context";
      requireCompatible?: boolean;
      sendAfterRevision?: boolean;
    }
  | {
      type: "play.chain.regenerate-narrative";
      operationId: string;
      worldId: string;
      chainId: string;
      eventId: number;
    }
  | {
      type: "play.chain.start";
      worldId: string;
      chainId: string;
      exchangeId: string;
      playerText: string;
      turnNote?: string;
    }
  | {
      type: "play.chain.append";
      recovery?: "continue_partial";
      worldId: string;
      chainId: string;
      exchangeId: string;
      playerText: string;
      turnNote?: string;
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
      type: "play.timeline.detail" | "play.timeline.context";
      worldId: string;
      chainId: string;
      eventId: number;
    }
  | { type: "world.play-context.read"; worldId: string }
  | {
      type: "world.surface.read";
      worldId: string;
      surface: "state" | "control" | "history" | "runtime" | "revision";
      head?: string;
    }
  | { type: "world.extensions.read"; worldId: string }
  | {
      type: "world.extensions.set";
      worldId: string;
      key: string;
      value: WorldExtensionChoice;
    }
  | { type: "world.play-decorations.read"; worldId: string };

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
  status?: "streaming" | "completed" | "interrupted" | "cancelled";
  retryOf?: string;
  failure?: string;
  toolFragment?: string;
  retries?: ModelRetryEvidence[];
  /** Null means this dispatch received no usage; absent on older records. */
  usage?: ModelUsage | null;
  toolCalls: V1SettingConversationToolCall[];
}

export interface V1SettingConversationTurn {
  id: string;
  user: V1SettingConversationMessage;
  exchanges: V1SettingConversationExchange[];
}

export interface V1SettingImprovementHistoryItem {
  sessionId: string;
  unavailableReason?: string;
  runStatus: "ready" | "running" | "paused" | "interrupted";
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
    runStatus: "ready" | "running" | "paused" | "interrupted";
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
    maintenance?: WorldPromptMaintenance;
    /** The per-send suffix: header applied, one line per contributing entry. */
    turnGuide?: { text: string; lines: { source: string; text: string }[] };
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
    promptHistory?: {
      exchange: number;
      head: string;
      playPreset: V1PlayCallChainContextView["playPreset"];
      bootstrap: Pick<
        V1SettingPromptPreview["compilation"],
        "logicalMessages" | "coverage"
      >;
    }[];
    requestExchange?: number;
    requestHead?: string;
    prefixDiagnostics?: WorldPromptPrefixComparison;
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
    contextMode?: "append" | "fresh";
    prefixDiagnostics?: WorldPromptPrefixComparison;
    head: string;
    preview: V1SettingPromptPreview;
  } | null;
}

export interface V1AuthoringRequestIdentity {
  legacyBootstrap?: boolean;
  requestId: string;
}

export interface V1AuthoringRequestPreview extends V1AuthoringRequestIdentity {
  compilation: V1SettingPromptPreview["compilation"];
  wireRequest?: {
    provider: string;
    method: string;
    endpointPath: string;
    headerNames: string[];
    body: unknown;
    systemInstructionSources?: { promptId?: string; sources: string[] }[];
    redactedProviderContinuation?: true;
  };
}

export interface V1SettingImprovementView {
  freshContextReason?: FreshContextReason;
  canRetry?: boolean;
  canContinuePartial?: boolean;
  requestPreviews?: V1AuthoringRequestIdentity[];
  /** Accepted command receipts, independent of diagnostics retained for display. */
  confirmedRequestIds?: string[];
  sessionId: string;
  packageId: string;
  runStatus: "ready" | "running" | "paused" | "interrupted";
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
      callId?: string;
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
      retries?: ModelRetryEvidence[];
      receivedAt: number;
    } | null;
    updatedAt: number;
  };
  lastFailure: string | null;
}

export interface V1WorldRevisionChangeSet {
  changeSetId: string;
  source: "manual" | "ai" | "rollback";
  createdAt: number;
  changes: V1SettingAuthoringDiff[];
}

export interface V1WorldRevisionEpochView {
  epochId: string;
  worldId: string;
  lifecycle: "active" | "applying" | "applied" | "discarded";
  locked: boolean;
  baseHead: string;
  revision: string;
  files: ContentTreeFile[];
  diff: V1SettingAuthoringDiff[];
  diagnostics: { code: string; path: string; message: string }[];
  changes: V1WorldRevisionChangeSet[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  appliedHead: string | null;
}

export interface V1WorldRevisionHistoryItem extends V1SettingImprovementHistoryItem {
  epochId: string;
}

export interface V1WorldRevisionSealedEpochView {
  epochId: string;
  worldId: string;
  lifecycle: "applied" | "discarded";
  baseHead: string;
  diff: V1SettingAuthoringDiff[];
  changes: V1WorldRevisionChangeSet[];
  createdAt: number;
  finishedAt: number;
  appliedHead: string | null;
}

export interface V1WorldRevisionView {
  freshContextReason?: FreshContextReason;
  canRetry?: boolean;
  canContinuePartial?: boolean;
  requestPreviews?: V1AuthoringRequestIdentity[];
  /** Accepted command receipts, independent of diagnostics retained for display. */
  confirmedRequestIds?: string[];
  sessionId: string;
  worldId: string;
  epochId: string;
  runStatus: "ready" | "running" | "paused" | "interrupted";
  messages: V1SettingConversationMessage[];
  turns: V1SettingConversationTurn[];
  usage: ModelUsage;
  progress: V1SettingImprovementView["progress"];
  lastFailure: string | null;
}

export interface V1WorldRevisionOverview {
  epoch: V1WorldRevisionEpochView | null;
  sealedEpochs: V1WorldRevisionSealedEpochView[];
  latest: V1WorldRevisionView | null;
  history: V1WorldRevisionHistoryItem[];
}

export interface V1WorldRevisionStatus {
  /** Changes only when durable epoch or conversation history changes. */
  revision: string;
  selected: null | {
    sessionId: string;
    runStatus: "ready" | "running" | "paused" | "interrupted";
    progress: V1WorldRevisionView["progress"];
  };
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
      /** Previous attempt of this same logical step; absent in older timelines. */
      retryOf?: number;
      usageRecorded?: true;
      /** Lightweight projections retain the availability of the stored reasoning. */
      reasoningRecorded?: true;
      reasoning?: string;
      toolFragment?: string;
      retries?: ModelRetryEvidence[];
      usage?: ModelUsage;
      stopReason?: string;
      continuation?: "available" | "unavailable";
      committedHead?: string;
    }
  | {
      id: number;
      kind: "tool_call";
      callId: string;
      /** The name the model sent. */
      name: string;
      /** Present only when Runtime restored the call to another declared tool. */
      executedName?: string;
      arguments: unknown;
      replayed: boolean;
    }
  | {
      id: number;
      kind: "tool_result";
      /** Present only for tabletop resolution tools; never a preformatted string. */
      resolution?: ResolutionReceipt;
      callId: string;
      /** The name the model sent. */
      name: string;
      /** Present only when Runtime restored the call to another declared tool. */
      executedName?: string;
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
      replyEventId?: number;
      status?: "streaming" | "completed" | "interrupted" | "cancelled";
      text: string;
      reasoningRecorded?: true;
      reasoning?: string;
      toolFragment?: string;
      retries?: ModelRetryEvidence[];
      usage?: ModelUsage;
      /** Small locator; the encoding itself follows the bounded diagnostic window. */
      requestPreviewExchange?: number;
      requestPreviewStatus?: "attempted" | "completed" | "cancelled";
      requestPreview?:
        | { status: "unavailable" }
        | {
            status: "attempted" | "completed" | "cancelled";
            wireRequest: NonNullable<V1AuthoringRequestPreview["wireRequest"]>;
          };
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
      failureKind?: PlayFailureKind;
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
      replyEventId?: number;
      status?: "streaming" | "completed" | "interrupted" | "cancelled";
      toolCallCount: number;
      retries?: ModelRetryEvidence[];
      hasReasoning?: boolean;
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
      requiresFreshContext?: true;
      event: V1PlayTimelineEventSummary;
    }
  | {
      kind: "genesis";
      messageId: string;
      role: "player" | "narrator";
      exactText: string;
    };

export interface V1PlayTimelinePage {
  supersededEvents?: { chainId: string; eventIds: number[] }[];
  worldId: string;
  generation: string;
  activeChainId: string | null;
  activeStatus: V1PlayCallChainStatus | null;
  activeParentHead?: string | undefined;
  /** Provider protocol from the active context's persisted model binding. */
  activeModelProtocol?: ModelProviderKind | undefined;
  /** Live invocation identity; null when this Runtime owns none. Absent in legacy views. */
  activeInvocationExchangeId?: string | null;
  activeCanRetry: boolean;
  activeCanContinuePartial?: boolean;
  activeFreshContextReason?: FreshContextReason | undefined;
  activeLastFailure: string | null;
  activeLastFailureKind?: PlayFailureKind | undefined;
  items: V1PlayTimelineItem[];
  nextCursor: string | null;
}

/** One model context as projected into the durable player-visible timeline. */
export interface V1PlayCallChainContextView {
  /** Tombstones remove superseded attempts from already loaded event projections. */
  supersededEventIds?: number[];
  freshContextReason?: FreshContextReason;
  requiresFreshContext?: true;
  chainId: string;
  baselineHead: string;
  /** Number of committed messages that precede the first event in this chain. */
  baselineHistoryLength?: number;
  parentHead: string;
  playPreset: { id: string; name: string; revision: string };
  /** Provider window from this context's frozen model binding, if recorded. */
  contextWindowTokens?: number;
  /** Keeps the latest complete input report available beyond the event tail. */
  latestCompletedResponse?: { id: number; usage?: ModelUsage };
  status: V1PlayCallChainStatus;
  canRetry: boolean;
  canContinuePartial?: boolean;
  events: V1PlayCallChainEvent[];
  changedDocuments: {
    kind: "create" | "replace";
    ref: string;
    path: string;
  }[];
  lastFailure: string | null;
  lastFailureKind?: PlayFailureKind;
  updatedAt: number;
}

/**
 * Durable model-directed play context. Starting fresh replaces only the
 * active model transcript; previous contexts remain available to the player
 * as an append-only display timeline.
 */
export interface V1PlayCallChainView extends V1PlayCallChainContextView {
  worldId: string;
  /** Provider protocol from this context's persisted model binding. */
  modelProtocol?: ModelProviderKind;
  previousContexts: V1PlayCallChainContextView[];
  /**
   * Present when the chain's last ending was the player's cancellation
   * (ADR-0030). Absent otherwise, so views from before this field still parse.
   */
  lastCancelled?: true;
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

export interface V1ProtocolErrorOptions extends ErrorOptions {
  /** Structured data the client needs to recover, such as the current tree on a conflict. */
  details?: Readonly<Record<string, unknown>>;
}

export class V1ProtocolError extends Error {
  readonly code:
    | "incompatible_data"
    | "invalid_request"
    | WorldArchiveErrorCode
    | "operation_conflict"
    | "endpoint_discarded"
    | "endpoint_read_conflict"
    | "content_conflict"
    | "inconsistent_materialization"
    | "model_protocol_mismatch";
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly httpStatus: 400 | 409;

  constructor(
    code: V1ProtocolError["code"],
    message: string,
    options: V1ProtocolErrorOptions = {},
  ) {
    super(message, options);
    this.name = "V1ProtocolError";
    this.code = code;
    this.details = options.details;
    this.httpStatus =
      code === "endpoint_discarded" ||
      code === "endpoint_read_conflict" ||
      code === "content_conflict"
        ? 409
        : 400;
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
  assertV1RequestType(value.request.type);
  const failure = validateV1Request(value.request.type, value.request);
  if (failure !== undefined)
    throw new V1ProtocolError(
      "invalid_request",
      failure.message,
      failure.cause === undefined ? {} : { cause: failure.cause },
    );
  return value as unknown as V1Envelope;
}

export function assertV1RequestType(
  type: string,
): asserts type is V1Request["type"] {
  if (!isV1RequestType(type))
    throw new V1ProtocolError(
      "invalid_request",
      `V1 does not support command: ${type}`,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
