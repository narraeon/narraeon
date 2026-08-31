import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  V1PlayCallChainEvent,
  V1PlayCallChainStatus,
  V1PlayCallChainView,
  V1PlayTimelineEventSummary,
  V1PlayTimelineItem,
  V1PlayTimelinePage,
} from "../../protocol/v1.ts";
import type { ModelUsage, ModelUsageField } from "../../protocol/modelUsage.ts";
import type {
  ModelHostAppendItem,
  ModelHostBinding,
  ModelHostExchange,
} from "../model/ModelHost.ts";
import type {
  MaterialSelection,
  PlayFollowupCompilation,
  PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import { cloneFilePhysically } from "../FileNativePhysicalClone.ts";
import type {
  PlayDocumentAuthorizationCheckpoint,
  PlayDocumentToolResult,
} from "./PlayDocumentTools.ts";

export interface PersistedCompletedToolCall {
  key: string;
  name: string;
  signature: string;
  result: PlayDocumentToolResult;
}

export interface PersistedDocumentAuthorizationCheckpoint {
  afterEventId: number;
  authorization: PlayDocumentAuthorizationCheckpoint;
}

export interface PersistedPlayCallChainContext {
  chainId: string;
  baselineHead: string;
  baselineHistoryLength?: number;
  parentHead: string;
  derivedFrom?: { worldId: string; chainId: string; head: string };
  branchedBeforePlayer?: {
    worldId: string;
    chainId: string;
    eventId: number;
  };
  playPreset: V1PlayCallChainView["playPreset"];
  followups?: PlayFollowupCompilation[];
  playPresetScriptsEnabled?: boolean;
  /** Missing only for contexts written before bindings became durable. */
  modelBinding?: ModelHostBinding;
  status: V1PlayCallChainStatus;
  canRetry: boolean;
  bootstrap: PromptCompilation;
  tools: PromptCompilation["tools"];
  transcript: ModelHostAppendItem[];
  events: V1PlayCallChainEvent[];
  completedTools: PersistedCompletedToolCall[];
  documentAuthorizationCheckpoints?: PersistedDocumentAuthorizationCheckpoint[];
  changedDocuments: V1PlayCallChainView["changedDocuments"];
  nextMaterials: MaterialSelection[];
  nextEventId: number;
  exchange: number;
  lastRequest: ModelHostExchange | null;
  lastRequestAttempt: number;
  lastFailure: string | null;
  updatedAt: number;
}

export interface PersistedPlayCallChain extends PersistedPlayCallChainContext {
  schemaVersion: 3;
  kind: "play_call_chain";
  worldId: string;
  previousContexts?: PersistedPlayCallChainContext[];
  previousChainId: string | null;
  timelineGeneration: string;
}

interface PersistedContextIndex {
  schemaVersion: 3;
  kind: "play_context_index";
  worldId: string;
  chainId: string;
  previousChainId: string | null;
  timelineGeneration: string;
  playPreset: PersistedPlayCallChainContext["playPreset"];
}

interface PersistedContextBase {
  schemaVersion: 3;
  kind: "play_context_frozen";
  worldId: string;
  chainId: string;
  baselineHead: string;
  baselineHistoryLength?: number;
  derivedFrom?: PersistedPlayCallChainContext["derivedFrom"];
  branchedBeforePlayer?: PersistedPlayCallChainContext["branchedBeforePlayer"];
  followups?: PlayFollowupCompilation[];
  playPresetScriptsEnabled?: boolean;
  modelBinding?: ModelHostBinding;
  bootstrap: PromptCompilation;
  tools: PromptCompilation["tools"];
}

interface PersistedContextState {
  schemaVersion: 3;
  chainId: string;
  parentHead: string;
  status: V1PlayCallChainStatus;
  canRetry: boolean;
  eventCount: number;
  transcriptCount: number;
  completedToolCount: number;
  authorizationCheckpointCount: number;
  changedDocuments: V1PlayCallChainView["changedDocuments"];
  nextEventId: number;
  exchange: number;
  continuationDigest: string;
  lastRequestAttempt: number;
  lastFailure: string | null;
  updatedAt: number;
}

interface PersistedContextContinuation {
  schemaVersion: 3;
  kind: "play_context_continuation";
  chainId: string;
  nextMaterials: MaterialSelection[];
  lastRequestDigest: string | null;
}

interface PersistedTimelineHead {
  schemaVersion: 3;
  worldId: string;
  chainId: string;
  generation: string;
}

export interface PlayContextPersistenceCursor {
  eventCount: number;
  transcriptCount: number;
  completedToolCount: number;
  authorizationCheckpointCount: number;
}

export interface LoadedPlayContext {
  value: PersistedPlayCallChain;
  cursor: PlayContextPersistenceCursor;
}

interface ReleasedPersistedPlayCallChain extends PersistedPlayCallChainContext {
  schemaVersion: 1 | 2;
  kind: "play_call_chain";
  worldId: string;
  previousContexts?: PersistedPlayCallChainContext[];
}

interface TimelineCursor {
  generation: string;
  chainId: string | null;
  eventId: number;
  boundaryPending: boolean;
  genesisIndex: number;
}

export class FileNativePlayTimelineStore {
  readonly #worldsRoot: string;

  constructor(dataRoot: string) {
    this.#worldsRoot = join(resolve(dataRoot), "worlds-file-native");
  }

  /**
   * Convert the cumulative call-chain record written by every released
   * Narraeon version through v0.1.1 into immutable context segments. The
   * source digest makes interrupted retries reproduce the same generation and
   * identities; callers publish the world-wide storage marker only after this
   * method has completed.
   */
  async migrateReleasedRecord(
    worldId: string,
    value: unknown,
    sourceDigest: string,
  ): Promise<void> {
    assertIdentity(worldId, "World ID");
    if (!/^[a-f0-9]{64}$/u.test(sourceDigest))
      throw new TypeError("Released call-chain source digest is invalid");
    assertReleasedPersistedPlayCallChain(value, worldId);
    const contexts = [
      ...(value.previousContexts ?? []).map((context) =>
        structuredClone(context),
      ),
      releasedCurrentContext(value),
    ];
    const seen = new Set<string>();
    const generation = `released:${sourceDigest}`;
    let previousChainId: string | null = null;
    for (const context of contexts) {
      assertIdentity(context.chainId, "Call-chain ID");
      if (seen.has(context.chainId))
        throw new Error(
          "Released play-call-chain contexts contain a duplicate identity",
        );
      seen.add(context.chainId);
      await this.persist({
        ...structuredClone(context),
        events: context.events.map(normalizePlayEvent),
        schemaVersion: 3,
        kind: "play_call_chain",
        worldId,
        previousChainId,
        timelineGeneration: generation,
        documentAuthorizationCheckpoints: structuredClone(
          context.documentAuthorizationCheckpoints ?? [],
        ),
      });
      previousChainId = context.chainId;
    }
    const migrated = await this.readAllContexts(worldId);
    if (
      migrated.length !== contexts.length ||
      migrated.some(
        (context, index) => context.chainId !== contexts[index]?.chainId,
      )
    )
      throw new Error(
        "Released play-call-chain migration did not reproduce its context chain",
      );
  }

  async persist(
    value: PersistedPlayCallChain,
    cursor?: PlayContextPersistenceCursor,
  ): Promise<PlayContextPersistenceCursor> {
    return this.#persistAtRuntimeRoot(
      this.#worldRuntimeRoot(value.worldId),
      value,
      cursor,
    );
  }

  /** Write a sealed context segment without making it the active timeline. */
  async persistDetached(
    value: PersistedPlayCallChain,
    cursor?: PlayContextPersistenceCursor,
  ): Promise<PlayContextPersistenceCursor> {
    return this.#persistAtRuntimeRoot(
      this.#worldRuntimeRoot(value.worldId),
      value,
      cursor,
      false,
    );
  }

  async persistStaged(
    targetWorldRoot: string,
    value: PersistedPlayCallChain,
    cursor?: PlayContextPersistenceCursor,
  ): Promise<PlayContextPersistenceCursor> {
    return this.#persistAtRuntimeRoot(
      join(resolve(targetWorldRoot), "runtime"),
      value,
      cursor,
    );
  }

  async cloneContextPrefixToStaging(input: {
    sourceWorldId: string;
    targetWorldRoot: string;
    source: PersistedPlayCallChainContext;
    target: PersistedPlayCallChain;
  }): Promise<PlayContextPersistenceCursor> {
    assertIdentity(input.sourceWorldId, "Source world ID");
    assertIdentity(input.source.chainId, "Source call-chain ID");
    const sourceRoot = this.#contextRoot(
      input.sourceWorldId,
      input.source.chainId,
    );
    const targetRuntime = join(resolve(input.targetWorldRoot), "runtime");
    const targetRoot = join(
      targetRuntime,
      "play-contexts",
      createHash("sha256").update(input.target.chainId).digest("hex"),
    );
    const transcriptCount = prefixLength(
      input.source.transcript,
      input.target.transcript,
    );
    const eventCount = prefixLength(input.source.events, input.target.events);
    const completedToolCount = prefixLength(
      input.source.completedTools,
      input.target.completedTools,
    );
    const authorizationCheckpointCount = prefixLength(
      input.source.documentAuthorizationCheckpoints ?? [],
      input.target.documentAuthorizationCheckpoints ?? [],
    );
    await Promise.all([
      cloneNumberedPrefix({
        sourceRoot,
        targetRoot,
        directory: "transcript",
        count: transcriptCount,
        immutable: true,
      }),
      cloneNumberedPrefix({
        sourceRoot,
        targetRoot,
        directory: "events",
        count: eventCount,
        immutable: false,
      }),
      cloneNumberedPrefix({
        sourceRoot,
        targetRoot,
        directory: "summaries",
        count: eventCount,
        immutable: false,
      }),
      cloneNumberedPrefix({
        sourceRoot,
        targetRoot,
        directory: "completed-tools",
        count: completedToolCount,
        immutable: true,
      }),
      cloneNumberedPrefix({
        sourceRoot,
        targetRoot,
        directory: "authorization",
        count: authorizationCheckpointCount,
        immutable: true,
      }),
    ]);
    return this.persistStaged(input.targetWorldRoot, input.target, {
      transcriptCount,
      eventCount,
      completedToolCount,
      authorizationCheckpointCount,
    });
  }

  async #persistAtRuntimeRoot(
    runtimeRoot: string,
    value: PersistedPlayCallChain,
    cursor?: PlayContextPersistenceCursor,
    publishHead = true,
  ): Promise<PlayContextPersistenceCursor> {
    assertIdentity(value.worldId, "World ID");
    assertIdentity(value.chainId, "Call-chain ID");
    const root = join(
      runtimeRoot,
      "play-contexts",
      createHash("sha256").update(value.chainId).digest("hex"),
    );
    const index = contextIndex(value);
    const existingIndex = await readOptionalJson<unknown>(
      join(root, "index.json"),
    );
    if (existingIndex === null)
      await publishImmutableJson(join(root, "index.json"), index);
    else if (!isDeepStrictEqual(existingIndex, index))
      throw new Error("A play context identity is bound to a different index");
    const base = contextBase(value);
    const existingBase = await readOptionalJson<unknown>(
      join(root, "base.json"),
    );
    if (existingBase === null)
      await publishImmutableJson(join(root, "base.json"), base);
    else if (!isDeepStrictEqual(existingBase, base))
      throw new Error(
        "A play context identity is bound to different frozen data",
      );

    const supplied = cursor ?? emptyPersistenceCursor();
    // Recovery may replace the unresolved tail (for example, a generic crash
    // failure becomes the already-returned Provider response). Numbered files
    // beyond the new state counts are unreachable projection residue.
    const previous = {
      eventCount: Math.min(supplied.eventCount, value.events.length),
      transcriptCount: Math.min(
        supplied.transcriptCount,
        value.transcript.length,
      ),
      completedToolCount: Math.min(
        supplied.completedToolCount,
        value.completedTools.length,
      ),
      authorizationCheckpointCount: Math.min(
        supplied.authorizationCheckpointCount,
        value.documentAuthorizationCheckpoints?.length ?? 0,
      ),
    };

    const lastRequestDigest =
      value.lastRequest === null
        ? null
        : await this.#publishRequest(runtimeRoot, value.lastRequest);
    const continuation = {
      schemaVersion: 3,
      kind: "play_context_continuation",
      chainId: value.chainId,
      nextMaterials: structuredClone(value.nextMaterials),
      lastRequestDigest,
    } satisfies PersistedContextContinuation;
    const continuationDigest = createHash("sha256")
      .update(JSON.stringify(continuation))
      .digest("hex");
    await publishImmutableJson(
      join(root, "continuations", `${continuationDigest}.json`),
      continuation,
    );
    for (
      let index = previous.transcriptCount;
      index < value.transcript.length;
      index += 1
    )
      await publishImmutableJson(
        join(root, "transcript", numbered(index + 1)),
        value.transcript[index],
      );

    const eventStart = previous.eventCount === 0 ? 0 : previous.eventCount - 1;
    for (let index = eventStart; index < value.events.length; index += 1) {
      const event = value.events[index]!;
      if (event.id !== index + 1)
        throw new Error("Play call-chain event IDs must be contiguous");
      await publishJson(join(root, "events", numbered(event.id)), event);
      await publishJson(
        join(root, "summaries", numbered(event.id)),
        summarizeEvent(event),
      );
    }
    for (
      let index = previous.completedToolCount;
      index < value.completedTools.length;
      index += 1
    )
      await publishImmutableJson(
        join(root, "completed-tools", numbered(index + 1)),
        value.completedTools[index],
      );
    const checkpoints = value.documentAuthorizationCheckpoints ?? [];
    for (
      let index = previous.authorizationCheckpointCount;
      index < checkpoints.length;
      index += 1
    )
      await publishImmutableJson(
        join(root, "authorization", numbered(index + 1)),
        checkpoints[index],
      );

    const state: PersistedContextState = {
      schemaVersion: 3,
      chainId: value.chainId,
      parentHead: value.parentHead,
      status: value.status,
      canRetry: value.canRetry,
      eventCount: value.events.length,
      transcriptCount: value.transcript.length,
      completedToolCount: value.completedTools.length,
      authorizationCheckpointCount: checkpoints.length,
      changedDocuments: structuredClone(value.changedDocuments),
      nextEventId: value.nextEventId,
      exchange: value.exchange,
      continuationDigest,
      lastRequestAttempt: value.lastRequestAttempt,
      lastFailure: value.lastFailure,
      updatedAt: value.updatedAt,
    };
    await publishJson(join(root, "state.json"), state);
    if (publishHead)
      await publishJson(join(runtimeRoot, "play-timeline-head.json"), {
        schemaVersion: 3,
        worldId: value.worldId,
        chainId: value.chainId,
        generation: value.timelineGeneration,
      } satisfies PersistedTimelineHead);
    return {
      eventCount: value.events.length,
      transcriptCount: value.transcript.length,
      completedToolCount: value.completedTools.length,
      authorizationCheckpointCount: checkpoints.length,
    };
  }

  async readCurrent(worldId: string): Promise<LoadedPlayContext | null> {
    assertIdentity(worldId, "World ID");
    const head = await this.#readTimelineHead(worldId);
    if (head === null) return null;
    const loaded = await this.readContext(worldId, head.chainId);
    if (loaded !== null && loaded.value.timelineGeneration !== head.generation)
      throw new Error("Play timeline head generation is inconsistent");
    return loaded;
  }

  async readContext(
    worldId: string,
    chainId: string,
  ): Promise<LoadedPlayContext | null> {
    assertIdentity(worldId, "World ID");
    assertIdentity(chainId, "Call-chain ID");
    const metadata = await this.#readContextMetadata(worldId, chainId);
    if (metadata === null) return null;
    const { index: indexValue, state: stateValue, root } = metadata;
    const [
      baseValue,
      continuationValue,
      transcript,
      rawEvents,
      completedTools,
      checkpoints,
    ] = await Promise.all([
      readJson<unknown>(join(root, "base.json")),
      readJson<unknown>(
        join(root, "continuations", `${stateValue.continuationDigest}.json`),
      ),
      readNumbered<ModelHostAppendItem>(
        join(root, "transcript"),
        stateValue.transcriptCount,
      ),
      readNumberedValidated<V1PlayCallChainEvent>(
        join(root, "events"),
        stateValue.eventCount,
        assertPlayEvent,
      ),
      readNumbered<PersistedCompletedToolCall>(
        join(root, "completed-tools"),
        stateValue.completedToolCount,
      ),
      readNumbered<PersistedDocumentAuthorizationCheckpoint>(
        join(root, "authorization"),
        stateValue.authorizationCheckpointCount,
      ),
    ]);
    const events = rawEvents.map(normalizePlayEvent);
    assertContextBase(baseValue);
    assertContextContinuation(continuationValue);
    if (
      baseValue.worldId !== worldId ||
      baseValue.chainId !== chainId ||
      continuationValue.chainId !== chainId ||
      createHash("sha256")
        .update(JSON.stringify(continuationValue))
        .digest("hex") !== stateValue.continuationDigest
    )
      throw new Error("Play context durable identity is inconsistent");
    const lastRequest =
      continuationValue.lastRequestDigest === null
        ? null
        : await readJson<ModelHostExchange>(
            join(
              this.#worldRuntimeRoot(worldId),
              "play-requests",
              `${continuationValue.lastRequestDigest}.json`,
            ),
          );
    if (
      lastRequest !== null &&
      (!isRecord(lastRequest) ||
        createHash("sha256")
          .update(JSON.stringify(lastRequest))
          .digest("hex") !== continuationValue.lastRequestDigest)
    )
      throw new Error(
        "Frozen play request does not match its durable identity",
      );
    const value: PersistedPlayCallChain = {
      schemaVersion: 3,
      kind: "play_call_chain",
      worldId,
      chainId,
      previousChainId: indexValue.previousChainId,
      timelineGeneration: indexValue.timelineGeneration,
      baselineHead: baseValue.baselineHead,
      parentHead: stateValue.parentHead,
      ...(baseValue.baselineHistoryLength === undefined
        ? {}
        : { baselineHistoryLength: baseValue.baselineHistoryLength }),
      ...(baseValue.derivedFrom === undefined
        ? {}
        : { derivedFrom: structuredClone(baseValue.derivedFrom) }),
      ...(baseValue.branchedBeforePlayer === undefined
        ? {}
        : {
            branchedBeforePlayer: structuredClone(
              baseValue.branchedBeforePlayer,
            ),
          }),
      playPreset: structuredClone(indexValue.playPreset),
      ...(baseValue.followups === undefined
        ? {}
        : { followups: structuredClone(baseValue.followups) }),
      ...(baseValue.playPresetScriptsEnabled === undefined
        ? {}
        : { playPresetScriptsEnabled: baseValue.playPresetScriptsEnabled }),
      ...(baseValue.modelBinding === undefined
        ? {}
        : { modelBinding: structuredClone(baseValue.modelBinding) }),
      status: stateValue.status,
      canRetry: stateValue.canRetry,
      bootstrap: structuredClone(baseValue.bootstrap),
      tools: structuredClone(baseValue.tools),
      transcript,
      events,
      completedTools,
      documentAuthorizationCheckpoints: checkpoints,
      changedDocuments: structuredClone(stateValue.changedDocuments),
      nextMaterials: structuredClone(continuationValue.nextMaterials),
      nextEventId: stateValue.nextEventId,
      exchange: stateValue.exchange,
      lastRequest,
      lastRequestAttempt: stateValue.lastRequestAttempt,
      lastFailure: stateValue.lastFailure,
      updatedAt: stateValue.updatedAt,
    };
    return {
      value,
      cursor: {
        eventCount: stateValue.eventCount,
        transcriptCount: stateValue.transcriptCount,
        completedToolCount: stateValue.completedToolCount,
        authorizationCheckpointCount: stateValue.authorizationCheckpointCount,
      },
    };
  }

  async readAllContexts(
    worldId: string,
  ): Promise<PersistedPlayCallChainContext[]> {
    const current = await this.readCurrent(worldId);
    if (current === null) return [];
    const reverse: PersistedPlayCallChainContext[] = [current.value];
    let previous = current.value.previousChainId;
    while (previous !== null) {
      const loaded = await this.readContext(worldId, previous);
      if (loaded === null)
        throw new Error("Play timeline points to a missing context");
      reverse.push(loaded.value);
      previous = loaded.value.previousChainId;
    }
    return reverse.reverse();
  }

  async readPage(
    worldId: string,
    limit: number,
    cursor?: string,
  ): Promise<V1PlayTimelinePage> {
    assertIdentity(worldId, "World ID");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Play timeline page limit must be between 1 and 100");
    const head = await this.#readTimelineHead(worldId);
    const generation = head?.generation ?? `genesis:${worldId}`;
    let pointer =
      cursor === undefined
        ? await this.#initialCursor(worldId, generation, head?.chainId ?? null)
        : decodeCursor(cursor);
    if (pointer.generation !== generation)
      throw new Error(
        "Play timeline cursor belongs to a different timeline revision",
      );
    const reverse: V1PlayTimelineItem[] = [];
    const metadata = new Map<
      string,
      {
        root: string;
        index: PersistedContextIndex;
        state: PersistedContextState;
      } | null
    >();
    const readMetadata = async (chainId: string) => {
      if (metadata.has(chainId)) return metadata.get(chainId) ?? null;
      const loaded = await this.#readContextMetadata(worldId, chainId);
      metadata.set(chainId, loaded);
      return loaded;
    };
    while (reverse.length < limit && pointer.chainId !== null) {
      const context = await readMetadata(pointer.chainId);
      if (context === null)
        throw new Error("Play timeline cursor points to a missing context");
      if (pointer.eventId > 0) {
        const summary = await readJson<unknown>(
          join(
            this.#contextRoot(worldId, pointer.chainId),
            "summaries",
            numbered(pointer.eventId),
          ),
        );
        assertTimelineEventSummary(summary);
        if (summary.id !== pointer.eventId)
          throw new Error("Play timeline summary identity is inconsistent");
        reverse.push({
          kind: "event",
          chainId: pointer.chainId,
          current: pointer.chainId === head?.chainId,
          event: summary,
        });
        pointer = { ...pointer, eventId: pointer.eventId - 1 };
        continue;
      }
      if (pointer.boundaryPending) {
        reverse.push({
          kind: "context_boundary",
          chainId: pointer.chainId,
          playPreset: structuredClone(context.index.playPreset),
          changedDocuments: structuredClone(context.state.changedDocuments),
          current: pointer.chainId === head?.chainId,
        });
        pointer = { ...pointer, boundaryPending: false };
        continue;
      }
      if (context.index.previousChainId !== null) {
        const previous = await readMetadata(context.index.previousChainId);
        if (previous === null)
          throw new Error("Play timeline points to a missing previous context");
        pointer = {
          ...pointer,
          chainId: context.index.previousChainId,
          eventId: previous.state.eventCount,
          boundaryPending: true,
        };
      } else {
        pointer = { ...pointer, chainId: null };
      }
    }
    if (
      reverse.length < limit &&
      pointer.chainId === null &&
      pointer.genesisIndex >= 0
    ) {
      const genesis = await this.#readGenesisMessages(worldId);
      while (reverse.length < limit && pointer.genesisIndex >= 0) {
        const message = genesis[pointer.genesisIndex];
        if (message === undefined)
          throw new Error("Play timeline genesis cursor is invalid");
        reverse.push({ kind: "genesis", ...structuredClone(message) });
        pointer = { ...pointer, genesisIndex: pointer.genesisIndex - 1 };
      }
    }
    const active =
      head === null
        ? null
        : await this.#readContextMetadata(worldId, head.chainId);
    return {
      worldId,
      generation,
      activeChainId: head?.chainId ?? null,
      activeStatus: active?.state.status ?? null,
      activeCanRetry: active?.state.canRetry ?? false,
      activeLastFailure: active?.state.lastFailure ?? null,
      items: reverse.reverse(),
      nextCursor:
        pointer.chainId === null && pointer.genesisIndex < 0
          ? null
          : encodeCursor(pointer),
    };
  }

  async readDetail(
    worldId: string,
    chainId: string,
    eventId: number,
  ): Promise<V1PlayCallChainEvent> {
    assertIdentity(worldId, "World ID");
    assertIdentity(chainId, "Call-chain ID");
    if (!Number.isSafeInteger(eventId) || eventId < 1)
      throw new TypeError("Play timeline event ID is invalid");
    const metadata = await this.#readContextMetadata(worldId, chainId);
    if (metadata === null || eventId > metadata.state.eventCount)
      throw new Error("Play timeline event is outside the current context");
    const event = await readJson<unknown>(
      join(this.#contextRoot(worldId, chainId), "events", numbered(eventId)),
    );
    assertPlayEvent(event);
    if (event.id !== eventId)
      throw new Error("Play timeline event identity is inconsistent");
    return normalizePlayEvent(event);
  }

  newGeneration(): string {
    return `timeline:${randomUUID()}`;
  }

  #worldRuntimeRoot(worldId: string): string {
    return join(this.#worldsRoot, worldId, "runtime");
  }

  #contextRoot(worldId: string, chainId: string): string {
    return join(
      this.#worldRuntimeRoot(worldId),
      "play-contexts",
      createHash("sha256").update(chainId).digest("hex"),
    );
  }

  #timelineHeadPath(worldId: string): string {
    return join(this.#worldRuntimeRoot(worldId), "play-timeline-head.json");
  }

  async #readTimelineHead(
    worldId: string,
  ): Promise<PersistedTimelineHead | null> {
    const value = await readOptionalJson<unknown>(
      this.#timelineHeadPath(worldId),
    );
    if (value === null) return null;
    assertTimelineHead(value);
    if (value.worldId !== worldId)
      throw new Error("Play timeline head belongs to a different world");
    assertIdentity(value.chainId, "Call-chain ID");
    return value;
  }

  async #publishRequest(
    runtimeRoot: string,
    request: ModelHostExchange,
  ): Promise<string> {
    const digest = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    await publishImmutableJson(
      join(runtimeRoot, "play-requests", `${digest}.json`),
      request,
    );
    return digest;
  }

  async #initialCursor(
    worldId: string,
    generation: string,
    chainId: string | null,
  ): Promise<TimelineCursor> {
    const genesis = await this.#readGenesisMessages(worldId);
    if (chainId === null)
      return {
        generation,
        chainId: null,
        eventId: 0,
        boundaryPending: false,
        genesisIndex: genesis.length - 1,
      };
    const current = await this.#readContextMetadata(worldId, chainId);
    if (current === null)
      throw new Error("Play timeline head points to a missing context");
    if (current.index.timelineGeneration !== generation)
      throw new Error("Play timeline head generation is inconsistent");
    return {
      generation,
      chainId,
      eventId: current.state.eventCount,
      boundaryPending: true,
      genesisIndex: genesis.length - 1,
    };
  }

  async #readGenesisMessages(
    worldId: string,
  ): Promise<
    { messageId: string; role: "player" | "narrator"; exactText: string }[]
  > {
    const value = await readJson<unknown>(
      join(this.#worldRuntimeRoot(worldId), "play-genesis-timeline.json"),
    );
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.worldId !== worldId ||
      !Array.isArray(value.history) ||
      !value.history.every(
        (message) =>
          isRecord(message) &&
          typeof message.messageId === "string" &&
          (message.role === "player" || message.role === "narrator") &&
          typeof message.exactText === "string",
      )
    )
      throw new Error("World genesis timeline projection is invalid");
    return structuredClone(value.history) as {
      messageId: string;
      role: "player" | "narrator";
      exactText: string;
    }[];
  }

  async #readContextMetadata(
    worldId: string,
    chainId: string,
  ): Promise<{
    root: string;
    index: PersistedContextIndex;
    state: PersistedContextState;
  } | null> {
    const root = this.#contextRoot(worldId, chainId);
    const [indexValue, stateValue] = await Promise.all([
      readOptionalJson<unknown>(join(root, "index.json")),
      readOptionalJson<unknown>(join(root, "state.json")),
    ]);
    if (indexValue === null && stateValue === null) return null;
    assertContextIndex(indexValue);
    assertContextState(stateValue);
    if (
      indexValue.worldId !== worldId ||
      indexValue.chainId !== chainId ||
      stateValue.chainId !== chainId
    )
      throw new Error("Play context durable identity is inconsistent");
    return { root, index: indexValue, state: stateValue };
  }
}

function contextIndex(value: PersistedPlayCallChain): PersistedContextIndex {
  return {
    schemaVersion: 3,
    kind: "play_context_index",
    worldId: value.worldId,
    chainId: value.chainId,
    previousChainId: value.previousChainId,
    timelineGeneration: value.timelineGeneration,
    playPreset: structuredClone(value.playPreset),
  };
}

function contextBase(value: PersistedPlayCallChain): PersistedContextBase {
  return {
    schemaVersion: 3,
    kind: "play_context_frozen",
    worldId: value.worldId,
    chainId: value.chainId,
    baselineHead: value.baselineHead,
    ...(value.baselineHistoryLength === undefined
      ? {}
      : { baselineHistoryLength: value.baselineHistoryLength }),
    ...(value.derivedFrom === undefined
      ? {}
      : { derivedFrom: structuredClone(value.derivedFrom) }),
    ...(value.branchedBeforePlayer === undefined
      ? {}
      : { branchedBeforePlayer: structuredClone(value.branchedBeforePlayer) }),
    ...(value.followups === undefined
      ? {}
      : { followups: structuredClone(value.followups) }),
    ...(value.playPresetScriptsEnabled === undefined
      ? {}
      : { playPresetScriptsEnabled: value.playPresetScriptsEnabled }),
    ...(value.modelBinding === undefined
      ? {}
      : { modelBinding: structuredClone(value.modelBinding) }),
    bootstrap: structuredClone(value.bootstrap),
    tools: structuredClone(value.tools),
  };
}

function summarizeEvent(
  event: V1PlayCallChainEvent,
): V1PlayTimelineEventSummary {
  if (event.kind === "player") return structuredClone(event);
  if (event.kind === "assistant") {
    const { reasoning, toolFragment, ...summary } = event;
    return {
      ...structuredClone(summary),
      hasReasoning: reasoning !== undefined && reasoning.length > 0,
      hasToolFragment: toolFragment !== undefined && toolFragment.length > 0,
      hasUsage: event.usage !== undefined,
      detailsAvailable:
        (reasoning !== undefined && reasoning.length > 0) ||
        (toolFragment !== undefined && toolFragment.length > 0) ||
        event.usage !== undefined ||
        event.stopReason !== undefined ||
        event.continuation !== undefined,
    };
  }
  if (event.kind === "tool_call") {
    const { arguments: _arguments, ...summary } = event;
    void _arguments;
    return { ...structuredClone(summary), detailsAvailable: true };
  }
  if (event.kind === "tool_result") {
    const { markdown: _markdown, ...summary } = event;
    void _markdown;
    return { ...structuredClone(summary), detailsAvailable: true };
  }
  if (event.kind === "followup")
    return {
      id: event.id,
      kind: "followup",
      followupId: event.followupId,
      displayName: event.displayName,
      toolCallCount: event.toolCalls.length,
      failed: event.failure !== undefined,
      ...(event.usage === undefined
        ? {}
        : { usage: structuredClone(event.usage) }),
      detailsAvailable: true,
    };
  return structuredClone(event);
}

function emptyPersistenceCursor(): PlayContextPersistenceCursor {
  return {
    eventCount: 0,
    transcriptCount: 0,
    completedToolCount: 0,
    authorizationCheckpointCount: 0,
  };
}

function numbered(index: number): string {
  return `${String(index).padStart(10, "0")}.json`;
}

function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): TimelineCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.generation !== "string" ||
      (parsed.chainId !== null && typeof parsed.chainId !== "string") ||
      !Number.isSafeInteger(parsed.eventId) ||
      Number(parsed.eventId) < 0 ||
      typeof parsed.boundaryPending !== "boolean" ||
      !Number.isSafeInteger(parsed.genesisIndex) ||
      Number(parsed.genesisIndex) < -1
    )
      throw new Error("invalid cursor");
    return parsed as unknown as TimelineCursor;
  } catch (error: unknown) {
    throw new Error("Play timeline cursor is invalid", { cause: error });
  }
}

function assertContextIndex(
  value: unknown,
): asserts value is PersistedContextIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    value.kind !== "play_context_index" ||
    typeof value.worldId !== "string" ||
    typeof value.chainId !== "string" ||
    (value.previousChainId !== null &&
      typeof value.previousChainId !== "string") ||
    typeof value.timelineGeneration !== "string" ||
    !isRecord(value.playPreset)
  )
    throw new Error("Play context index has an invalid shape");
}

function assertContextBase(
  value: unknown,
): asserts value is PersistedContextBase {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    value.kind !== "play_context_frozen" ||
    typeof value.worldId !== "string" ||
    typeof value.chainId !== "string" ||
    typeof value.baselineHead !== "string" ||
    (value.modelBinding !== undefined &&
      !validModelHostBinding(value.modelBinding)) ||
    !isRecord(value.bootstrap) ||
    !Array.isArray(value.tools)
  )
    throw new Error("Play context frozen data has an invalid shape");
}

function assertContextState(
  value: unknown,
): asserts value is PersistedContextState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    typeof value.chainId !== "string" ||
    typeof value.parentHead !== "string" ||
    (value.status !== "ready" &&
      value.status !== "running" &&
      value.status !== "interrupted") ||
    typeof value.canRetry !== "boolean" ||
    !validCount(value.eventCount) ||
    !validCount(value.transcriptCount) ||
    !validCount(value.completedToolCount) ||
    !validCount(value.authorizationCheckpointCount) ||
    !Array.isArray(value.changedDocuments) ||
    !validCount(value.nextEventId) ||
    !validCount(value.exchange) ||
    typeof value.continuationDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.continuationDigest) ||
    !validCount(value.lastRequestAttempt) ||
    (value.lastFailure !== null && typeof value.lastFailure !== "string") ||
    typeof value.updatedAt !== "number"
  )
    throw new Error("Play context state has an invalid shape");
}

function assertContextContinuation(
  value: unknown,
): asserts value is PersistedContextContinuation {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    value.kind !== "play_context_continuation" ||
    typeof value.chainId !== "string" ||
    !Array.isArray(value.nextMaterials) ||
    (value.lastRequestDigest !== null &&
      (typeof value.lastRequestDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.lastRequestDigest)))
  )
    throw new Error("Play context continuation has an invalid shape");
}

function assertTimelineHead(
  value: unknown,
): asserts value is PersistedTimelineHead {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    typeof value.worldId !== "string" ||
    typeof value.chainId !== "string" ||
    typeof value.generation !== "string"
  )
    throw new Error("Play timeline head has an invalid shape");
}

function assertReleasedPersistedPlayCallChain(
  value: unknown,
  worldId: string,
): asserts value is ReleasedPersistedPlayCallChain {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== "play_call_chain" ||
    value.worldId !== worldId ||
    !isReleasedPlayContext(value) ||
    (value.previousContexts !== undefined &&
      (!Array.isArray(value.previousContexts) ||
        value.previousContexts.some(
          (context) => !isReleasedPlayContext(context),
        )))
  )
    throw new Error(
      "Released play-call-chain durable data has an invalid shape",
    );
}

function isReleasedPlayContext(
  value: unknown,
): value is PersistedPlayCallChainContext {
  if (!isRecord(value)) return false;
  if (
    typeof value.chainId !== "string" ||
    typeof value.baselineHead !== "string" ||
    (value.baselineHistoryLength !== undefined &&
      !validCount(value.baselineHistoryLength)) ||
    typeof value.parentHead !== "string" ||
    !validReleasedDerivedFrom(value.derivedFrom) ||
    !validReleasedBranchedBeforePlayer(value.branchedBeforePlayer) ||
    !isRecord(value.playPreset) ||
    (value.followups !== undefined && !Array.isArray(value.followups)) ||
    (value.playPresetScriptsEnabled !== undefined &&
      typeof value.playPresetScriptsEnabled !== "boolean") ||
    (value.modelBinding !== undefined &&
      !validModelHostBinding(value.modelBinding)) ||
    (value.status !== "ready" &&
      value.status !== "running" &&
      value.status !== "interrupted") ||
    typeof value.canRetry !== "boolean" ||
    !isRecord(value.bootstrap) ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.transcript) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.completedTools) ||
    !Array.isArray(value.changedDocuments) ||
    !Array.isArray(value.nextMaterials) ||
    !validCount(value.nextEventId) ||
    !validCount(value.exchange) ||
    (value.lastRequest !== null && !isRecord(value.lastRequest)) ||
    !validCount(value.lastRequestAttempt) ||
    (value.lastFailure !== null && typeof value.lastFailure !== "string") ||
    typeof value.updatedAt !== "number"
  )
    return false;
  try {
    for (const event of value.events) assertPlayEvent(event);
  } catch {
    return false;
  }
  return validReleasedAuthorizationCheckpoints(
    value.documentAuthorizationCheckpoints,
    value.events,
  );
}

function validModelHostBinding(value: unknown): value is ModelHostBinding {
  return (
    isRecord(value) &&
    (value.provider === "chat_completions" ||
      value.provider === "openai_responses" ||
      value.provider === "anthropic_messages") &&
    typeof value.endpointFingerprint === "string" &&
    value.endpointFingerprint.length > 0 &&
    typeof value.modelId === "string" &&
    value.modelId.length > 0 &&
    typeof value.contextWindowTokens === "number" &&
    validCount(value.contextWindowTokens) &&
    value.contextWindowTokens > 0 &&
    typeof value.maxOutputTokens === "number" &&
    validCount(value.maxOutputTokens) &&
    value.maxOutputTokens > 0 &&
    typeof value.protocolConfigFingerprint === "string" &&
    value.protocolConfigFingerprint.length > 0 &&
    (value.cacheStrategy === undefined ||
      value.cacheStrategy === "explicit_anthropic_blocks" ||
      value.cacheStrategy === "explicit_cliproxyapi_message" ||
      value.cacheStrategy === "provider_managed")
  );
}

function validReleasedDerivedFrom(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.worldId === "string" &&
      typeof value.chainId === "string" &&
      typeof value.head === "string")
  );
}

function validReleasedBranchedBeforePlayer(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.worldId === "string" &&
      typeof value.chainId === "string" &&
      Number.isSafeInteger(value.eventId) &&
      Number(value.eventId) > 0)
  );
}

function validReleasedAuthorizationCheckpoints(
  value: unknown,
  events: unknown[],
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100_000) return false;
  const eventIds = new Set(
    events.flatMap((event) =>
      isRecord(event) && Number.isSafeInteger(event.id) && Number(event.id) > 0
        ? [Number(event.id)]
        : [],
    ),
  );
  let previousEventId = -1;
  for (const checkpoint of value) {
    if (
      !isRecord(checkpoint) ||
      Object.keys(checkpoint).length !== 2 ||
      !Object.hasOwn(checkpoint, "afterEventId") ||
      !Object.hasOwn(checkpoint, "authorization") ||
      !Number.isSafeInteger(checkpoint.afterEventId) ||
      Number(checkpoint.afterEventId) < 0 ||
      Number(checkpoint.afterEventId) <= previousEventId ||
      (Number(checkpoint.afterEventId) !== 0 &&
        !eventIds.has(Number(checkpoint.afterEventId))) ||
      !isRecord(checkpoint.authorization)
    )
      return false;
    previousEventId = Number(checkpoint.afterEventId);
  }
  return true;
}

function releasedCurrentContext(
  value: ReleasedPersistedPlayCallChain,
): PersistedPlayCallChainContext {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    worldId: _worldId,
    previousContexts: _previousContexts,
    ...context
  } = value;
  void _schemaVersion;
  void _kind;
  void _worldId;
  void _previousContexts;
  return structuredClone(context);
}

function assertPlayEvent(
  value: unknown,
): asserts value is V1PlayCallChainEvent {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1
  )
    throw new Error("Play timeline event has an invalid identity");
  if (value.kind === "player") {
    if (
      typeof value.exchangeId !== "string" ||
      typeof value.text !== "string" ||
      (value.context !== "fresh" && value.context !== "append") ||
      !validOptionalString(value.committedHead)
    )
      throw new Error("Player timeline event has an invalid shape");
    return;
  }
  if (value.kind === "assistant") {
    if (
      !validAssistantEventCore(value) ||
      !validOptionalAssistantResponseKind(value.responseKind) ||
      !validOptionalString(value.reasoning) ||
      !validOptionalString(value.toolFragment) ||
      !validOptionalUsage(value.usage) ||
      !validOptionalString(value.stopReason) ||
      (value.continuation !== undefined &&
        value.continuation !== "available" &&
        value.continuation !== "unavailable") ||
      !validOptionalString(value.committedHead)
    )
      throw new Error("Assistant timeline event has an invalid shape");
    return;
  }
  if (value.kind === "tool_call") {
    if (
      typeof value.callId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.replayed !== "boolean"
    )
      throw new Error("Tool-call timeline event has an invalid shape");
    return;
  }
  if (value.kind === "tool_result") {
    if (
      typeof value.callId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.ok !== "boolean" ||
      typeof value.markdown !== "string" ||
      typeof value.replayed !== "boolean"
    )
      throw new Error("Tool-result timeline event has an invalid shape");
    return;
  }
  if (value.kind === "followup") {
    if (
      typeof value.followupId !== "string" ||
      typeof value.displayName !== "string" ||
      typeof value.text !== "string" ||
      !validOptionalString(value.reasoning) ||
      !validOptionalUsage(value.usage) ||
      !Array.isArray(value.toolCalls) ||
      !value.toolCalls.every(validFollowupToolCall) ||
      !validOptionalString(value.failure)
    )
      throw new Error("Follow-up timeline event has an invalid shape");
    return;
  }
  if (
    (value.kind !== "failure" && value.kind !== "cancellation") ||
    typeof value.message !== "string"
  )
    throw new Error("Play timeline event has an invalid kind");
}

function assertTimelineEventSummary(
  value: unknown,
): asserts value is V1PlayTimelineEventSummary {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1
  )
    throw new Error("Play timeline summary has an invalid identity");
  if (
    value.kind === "player" ||
    value.kind === "failure" ||
    value.kind === "cancellation"
  ) {
    assertPlayEvent(value);
    return;
  }
  if (value.kind === "assistant") {
    if (
      !validAssistantEventCore(value) ||
      !validOptionalAssistantResponseKind(value.responseKind) ||
      !validOptionalString(value.committedHead) ||
      !validOptionalString(value.stopReason) ||
      !validOptionalUsage(value.usage) ||
      (value.continuation !== undefined &&
        value.continuation !== "available" &&
        value.continuation !== "unavailable") ||
      typeof value.hasReasoning !== "boolean" ||
      typeof value.hasToolFragment !== "boolean" ||
      typeof value.hasUsage !== "boolean" ||
      typeof value.detailsAvailable !== "boolean"
    )
      throw new Error("Assistant timeline summary has an invalid shape");
    return;
  }
  if (value.kind === "tool_call") {
    if (
      typeof value.callId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.replayed !== "boolean" ||
      value.detailsAvailable !== true
    )
      throw new Error("Tool-call timeline summary has an invalid shape");
    return;
  }
  if (value.kind === "tool_result") {
    if (
      typeof value.callId !== "string" ||
      typeof value.name !== "string" ||
      typeof value.ok !== "boolean" ||
      typeof value.replayed !== "boolean" ||
      value.detailsAvailable !== true
    )
      throw new Error("Tool-result timeline summary has an invalid shape");
    return;
  }
  if (
    value.kind !== "followup" ||
    typeof value.followupId !== "string" ||
    typeof value.displayName !== "string" ||
    !validCount(value.toolCallCount) ||
    typeof value.failed !== "boolean" ||
    !validOptionalUsage(value.usage) ||
    value.detailsAvailable !== true
  )
    throw new Error("Follow-up timeline summary has an invalid shape");
}

function validAssistantEventCore(value: Record<string, unknown>): boolean {
  return (
    typeof value.text === "string" &&
    (value.status === "streaming" ||
      value.status === "completed" ||
      value.status === "interrupted") &&
    validCount(value.exchange) &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) >= 1
  );
}

function validOptionalAssistantResponseKind(value: unknown): boolean {
  return (
    value === undefined ||
    value === "pending" ||
    value === "narrative" ||
    value === "tool_step" ||
    value === "empty"
  );
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validOptionalUsage(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      validUsageToken(value.inputTokens) &&
      validUsageToken(value.outputTokens) &&
      (value.provenance === undefined || validFullUsage(value)))
  );
}

/**
 * v0.1.1 stored only input/output usage. Keep that released shape readable,
 * but expose one current protocol projection with honest unavailable fields.
 */
function normalizePlayEvent(event: V1PlayCallChainEvent): V1PlayCallChainEvent {
  if (
    (event.kind !== "assistant" && event.kind !== "followup") ||
    event.usage === undefined ||
    validFullUsage(event.usage)
  )
    return structuredClone(event);
  const legacy = event.usage as unknown as {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  const unavailable: ModelUsageField = "unavailable";
  const provider = (value: number | null): ModelUsageField =>
    value === null ? unavailable : "provider";
  const usage: ModelUsage = {
    inputTokens: legacy.inputTokens,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    outputTokens: legacy.outputTokens,
    totalTokens: null,
    provenance: {
      inputTokens: provider(legacy.inputTokens),
      uncachedInputTokens: unavailable,
      cacheReadTokens: unavailable,
      cacheWriteTokens: unavailable,
      reasoningTokens: unavailable,
      outputTokens: provider(legacy.outputTokens),
      totalTokens: unavailable,
    },
  };
  return { ...structuredClone(event), usage };
}

function validFullUsage(value: unknown): value is ModelUsage {
  if (!isRecord(value) || !isRecord(value.provenance)) return false;
  const provenance = value.provenance;
  const fields = [
    "inputTokens",
    "uncachedInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "outputTokens",
    "totalTokens",
  ] as const;
  return fields.every(
    (field) =>
      validUsageToken(value[field]) && validUsageField(provenance[field]),
  );
}

function validUsageToken(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function validUsageField(value: unknown): value is ModelUsageField {
  return (
    value === "provider" ||
    value === "unavailable" ||
    value === "derived_provider_fields"
  );
}

function validFollowupToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    typeof value.name === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.markdown === "string"
  );
}

function validCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value))
    throw new TypeError(`${label} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function prefixLength<T>(source: readonly T[], target: readonly T[]): number {
  return isDeepStrictEqual(source.slice(0, target.length), target)
    ? target.length
    : 0;
}

async function cloneNumberedPrefix(input: {
  sourceRoot: string;
  targetRoot: string;
  directory: string;
  count: number;
  immutable: boolean;
}): Promise<void> {
  for (let index = 1; index <= input.count; index += 1)
    await cloneTimelineFile(
      join(input.sourceRoot, input.directory, numbered(index)),
      join(input.targetRoot, input.directory, numbered(index)),
      input.immutable,
    );
}

async function cloneTimelineFile(
  source: string,
  target: string,
  immutable: boolean,
): Promise<void> {
  await cloneFilePhysically({
    source,
    target,
    immutable,
    onTargetExists: assertSameFileBytes,
  });
}

async function assertSameFileBytes(
  source: string,
  target: string,
): Promise<void> {
  const [sourceBytes, targetBytes] = await Promise.all([
    readFile(source),
    readFile(target),
  ]);
  if (!sourceBytes.equals(targetBytes))
    throw new Error("Cloned play timeline prefix conflicts in target staging");
}

async function readNumbered<T>(root: string, count: number): Promise<T[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      readJson<T>(join(root, numbered(index + 1))),
    ),
  );
}

async function readNumberedValidated<T>(
  root: string,
  count: number,
  assertValue: (value: unknown) => asserts value is T,
): Promise<T[]> {
  const values = await readNumbered<unknown>(root, count);
  const validated: T[] = [];
  for (const value of values) {
    assertValue(value);
    validated.push(value);
  }
  return validated;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function publishJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function publishImmutableJson(
  path: string,
  value: unknown,
): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await syncFile(temporary);
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== contents)
        throw new Error("Immutable play timeline record conflicts", {
          cause: error,
        });
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
