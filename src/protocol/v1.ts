import type {
  ListProviderModelsInput,
  ModelProviderKind,
  SaveModelConnectionInput,
} from "./modelConnections.ts";
import type { AppLocale } from "./appPreferences.ts";
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

export type SettingImprovementStartMode = "plan_first" | "direct_candidate";

export interface V1Envelope {
  protocol: typeof v1Protocol;
  request: V1Request;
}

export type V1Request =
  | { type: "workspace.read" }
  | { type: "preferences.read" }
  | { type: "preferences.save"; locale: AppLocale }
  | { type: "model.read" }
  | {
      type: "model.save";
      connection: SaveModelConnectionInput;
    }
  | { type: "model.select"; connectionId: string }
  | { type: "model.delete"; connectionId: string }
  | ({ type: "model.models" } & ListProviderModelsInput)
  | { type: "content.create" }
  | { type: "content.read"; packageId: string }
  | { type: "content.replace"; packageId: string; files: ContentTreeFile[] }
  | { type: "content.copy"; packageId: string }
  | { type: "content.delete"; packageId: string }
  | { type: "content.rename"; packageId: string; name: string }
  | { type: "content.import"; archiveBase64: string }
  | { type: "content.export"; packageId: string }
  | {
      type: "setting-improvement.start";
      improvementId: string;
      packageId: string;
      goal: string;
      mode: SettingImprovementStartMode;
      contextPaths: string[];
    }
  | { type: "setting-improvement.confirm"; improvementId: string }
  | { type: "setting-improvement.progress"; improvementId: string }
  | {
      type: "setting-improvement.revise-plan";
      improvementId: string;
      feedback: string;
    }
  | {
      type: "setting-improvement.revise-candidate";
      improvementId: string;
      feedback: string;
    }
  | { type: "setting-improvement.apply"; improvementId: string }
  | { type: "setting-improvement.discard"; improvementId: string }
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

export type V1PlayCallChainStatus = "ready" | "running" | "interrupted";

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
      exchange: number;
      attempt: number;
      reasoning?: string;
      toolFragment?: string;
      usage?: { inputTokens: number | null; outputTokens: number | null };
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
      usage?: { inputTokens: number | null; outputTokens: number | null };
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
    };

export type V1PlayTimelineEventSummary =
  | Extract<V1PlayCallChainEvent, { kind: "player" }>
  | (Omit<
      Extract<V1PlayCallChainEvent, { kind: "assistant" }>,
      "reasoning" | "toolFragment" | "usage"
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
      detailsAvailable: true;
    }
  | Extract<V1PlayCallChainEvent, { kind: "failure" }>;

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
  "preferences.save": { locale: "string" },
  "model.save": { connection: "object" },
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
  "setting-improvement.start": {
    improvementId: "string",
    packageId: "string",
    goal: "string",
    mode: "string",
    contextPaths: "array",
  },
  "setting-improvement.confirm": { improvementId: "string" },
  "setting-improvement.progress": { improvementId: "string" },
  "setting-improvement.revise-plan": {
    improvementId: "string",
    feedback: "string",
  },
  "setting-improvement.revise-candidate": {
    improvementId: "string",
    feedback: "string",
  },
  "setting-improvement.apply": { improvementId: "string" },
  "setting-improvement.discard": { improvementId: "string" },
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
  "play.chain.inspect": { worldId: "string" },
  "play.timeline.page": { worldId: "string", limit: "number" },
  "play.timeline.detail": {
    worldId: "string",
    chainId: "string",
    eventId: "number",
  },
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
  if (
    request.type === "preferences.save" &&
    request.locale !== "en" &&
    request.locale !== "zh-CN"
  )
    throw new V1ProtocolError(
      "invalid_request",
      "preferences.save.locale must be en or zh-CN",
    );
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
    const unexpectedFields = Object.keys(request).filter(
      (field) => field !== "type" && field !== "archiveBase64",
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
  if (request.type !== "setting-improvement.start") return;
  if (request.mode !== "plan_first" && request.mode !== "direct_candidate")
    throw new V1ProtocolError(
      "invalid_request",
      "setting-improvement.start.mode is invalid",
    );
  if (
    !(request.contextPaths as unknown[]).every(
      (path) => typeof path === "string" && path.length > 0,
    )
  )
    throw new V1ProtocolError(
      "invalid_request",
      "setting-improvement.start.contextPaths is invalid",
    );
}

const requestTypes = new Set([
  "workspace.read",
  "preferences.read",
  "preferences.save",
  "model.read",
  "model.save",
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
  "setting-improvement.start",
  "setting-improvement.confirm",
  "setting-improvement.progress",
  "setting-improvement.revise-plan",
  "setting-improvement.revise-candidate",
  "setting-improvement.apply",
  "setting-improvement.discard",
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
  "play.chain.inspect",
  "play.timeline.page",
  "play.timeline.detail",
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
