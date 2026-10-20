import {
  isNarrativeOrigin,
  type NarrativeOrigin,
} from "../history/HistoryBackground.ts";
import { createHash, randomUUID } from "node:crypto";
import type { NarrativeCheckpointDeclaration } from "./PlayContinuity.ts";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { V1PlayCallChainEvent } from "../../protocol/v1.ts";
import type {
  ModelHostAppendItem,
  ModelHostExchange,
} from "../model/ModelHost.ts";
import type { FileNativeStateChange } from "../world/FileNativeWorldStore.ts";
import type { PersistedCompletedToolCall } from "./FileNativePlayTimelineStore.ts";
import type { HistoryBackground } from "../history/HistoryBackground.ts";

/**
 * In-memory result of settling one model response. It is never persisted:
 * a process that dies mid-generation is recovered by marking the exchange
 * interrupted and letting the player retry (ADR-0044).
 */
export interface PreparedPlayResponseSettlement {
  background?: HistoryBackground;
  playContext?: string;
  worldClock?: string;
  narrativeCheckpoint?: NarrativeCheckpointDeclaration;
  assistantEvent: Extract<V1PlayCallChainEvent, { kind: "assistant" }>;
  trailingEvents: V1PlayCallChainEvent[];
  transcriptStart: number;
  transcriptAppend: ModelHostAppendItem[];
  completedTools: PersistedCompletedToolCall[];
  stateChanges: FileNativeStateChange[];
  /** Legacy field name: true only for tool-free text eligible for narrative. */
  visibleText: boolean;
}

export type PlayAdvanceBase =
  | {
      schemaVersion: 1;
      kind: "play_advance";
      advanceKind: "player";
      narrativeOrigin?: NarrativeOrigin;
      playContext?: string;
      worldId: string;
      chainId: string;
      advanceId: string;
      operationId: string;
      parentHead: string;
      eventId: number;
      exchangeId: string;
      playerText: string;
      context: "fresh" | "append";
      transcriptStart: number;
      exchange: number;
      nextRequest: ModelHostExchange;
      createdAt: number;
    }
  | {
      schemaVersion: 1;
      kind: "play_advance";
      advanceKind: "response";
      narrativeOrigin?: NarrativeOrigin;
      worldId: string;
      chainId: string;
      advanceId: string;
      operationId: string;
      parentHead: string;
      eventId: number;
      exchange: number;
      attempt: number;
      createdAt: number;
    };

/**
 * The single in-progress play advance of a call chain, if any.
 *
 * It exists only between `begin` and `markSettled`. A marker that survives a
 * restart means the advance was interrupted; the runtime marks the chain
 * interrupted and the player retries. Legacy records from earlier layouts are
 * ignored, so they never block a world from opening.
 */
export class FileNativePlayAdvanceStore {
  readonly #worldsRoot: string;

  constructor(dataRoot: string) {
    this.#worldsRoot = join(resolve(dataRoot), "worlds-file-native");
  }

  async begin(base: PlayAdvanceBase): Promise<void> {
    assertBase(base);
    const current = await this.readCurrent(base.worldId, base.chainId);
    if (current !== null) {
      if (!sameAdvanceBase(current, base))
        throw new Error("Another play advance is still awaiting settlement");
      return;
    }
    await publishJson(this.#markerPath(base.worldId, base.chainId), base);
  }

  async readCurrent(
    worldId: string,
    chainId: string,
  ): Promise<PlayAdvanceBase | null> {
    assertIdentity(worldId, "World ID");
    assertIdentity(chainId, "Call-chain ID");
    const value = await readOptionalJson<unknown>(
      this.#markerPath(worldId, chainId),
    );
    if (value === null) return null;
    assertBase(value);
    if (value.worldId !== worldId || value.chainId !== chainId)
      throw new Error("Play advance marker belongs to another context");
    return value;
  }

  async markSettled(base: PlayAdvanceBase): Promise<void> {
    const current = await this.readCurrent(base.worldId, base.chainId);
    if (current === null) return;
    if (!sameAdvanceBase(current, base))
      throw new Error("Play advance is no longer current");
    await rm(this.#markerPath(base.worldId, base.chainId), { force: true });
  }

  /** Remove the in-progress marker and all advance records of a discarded chain. */
  async discardChain(worldId: string, chainId: string): Promise<void> {
    await rm(dirname(this.#markerPath(worldId, chainId)), {
      recursive: true,
      force: true,
    });
  }

  #markerPath(worldId: string, chainId: string): string {
    return join(
      this.#worldsRoot,
      worldId,
      "runtime",
      "play-advances",
      digest(chainId),
      "in-progress.json",
    );
  }
}

function sameAdvanceBase(
  left: PlayAdvanceBase,
  right: PlayAdvanceBase,
): boolean {
  const { createdAt: leftCreatedAt, ...leftIdentity } = left;
  const { createdAt: rightCreatedAt, ...rightIdentity } = right;
  void leftCreatedAt;
  void rightCreatedAt;
  return isDeepStrictEqual(leftIdentity, rightIdentity);
}

function assertBase(value: unknown): asserts value is PlayAdvanceBase {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "play_advance" ||
    (value.advanceKind !== "player" && value.advanceKind !== "response") ||
    (value.narrativeOrigin !== undefined &&
      !isNarrativeOrigin(value.narrativeOrigin)) ||
    typeof value.worldId !== "string" ||
    typeof value.chainId !== "string" ||
    typeof value.advanceId !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.parentHead !== "string" ||
    !Number.isSafeInteger(value.eventId) ||
    Number(value.eventId) < 1 ||
    typeof value.createdAt !== "number"
  )
    throw new Error("Play advance base has an invalid shape");
  assertIdentity(value.worldId, "World ID");
  assertIdentity(value.chainId, "Call-chain ID");
  assertIdentity(value.advanceId, "Advance ID");
  assertIdentity(value.operationId, "Operation ID");
  if (value.advanceKind === "player") {
    if (
      typeof value.exchangeId !== "string" ||
      typeof value.playerText !== "string" ||
      (value.context !== "fresh" && value.context !== "append") ||
      !Number.isSafeInteger(value.transcriptStart) ||
      Number(value.transcriptStart) < 0 ||
      !Number.isSafeInteger(value.exchange) ||
      Number(value.exchange) < 1 ||
      !isRecord(value.nextRequest)
    )
      throw new Error("Player advance has an invalid shape");
  } else if (
    !Number.isSafeInteger(value.exchange) ||
    Number(value.exchange) < 0 ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1
  )
    throw new Error("Response advance has an invalid shape");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentity(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value))
    throw new TypeError(`${label} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Atomic publish: write a temporary file, then rename over the target. */
async function publishJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
