import { createHash, randomUUID } from "node:crypto";
import type { NarrativeCheckpointDeclaration } from "./PlayContinuity.ts";
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

import type { V1PlayCallChainEvent } from "../../protocol/v1.ts";
import type {
  ModelHostAppendItem,
  ModelHostExchange,
  ModelHostResponse,
} from "../model/ModelHost.ts";
import type { FileNativeStateChange } from "../world/FileNativeWorldStore.ts";
import type { PlayDocumentAuthorizationCheckpoint } from "./PlayDocumentTools.ts";
import type { PersistedCompletedToolCall } from "./FileNativePlayTimelineStore.ts";

export type DurableModelHostResponse = Omit<ModelHostResponse, "diagnostics">;

export interface PreparedPlayResponseSettlement {
  playContext?: string;
  worldClock?: string;
  narrativeCheckpoint?: NarrativeCheckpointDeclaration;
  assistantEvent: Extract<V1PlayCallChainEvent, { kind: "assistant" }>;
  trailingEvents: V1PlayCallChainEvent[];
  transcriptStart: number;
  transcriptAppend: ModelHostAppendItem[];
  completedTools: PersistedCompletedToolCall[];
  authorizationCheckpoint: PlayDocumentAuthorizationCheckpoint;
  stateChanges: FileNativeStateChange[];
  /** Legacy field name: true only for tool-free text eligible for narrative. */
  visibleText: boolean;
}

export type PlayAdvanceBase =
  | {
      schemaVersion: 1;
      kind: "play_advance";
      advanceKind: "player";
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

interface ProviderCompletedFact {
  schemaVersion: 1;
  stage: "provider_completed";
  response: DurableModelHostResponse;
  recordedAt: number;
}

interface SettlementPreparedFact {
  schemaVersion: 1;
  stage: "settlement_prepared";
  settlement: PreparedPlayResponseSettlement;
  recordedAt: number;
}

interface SettledFact {
  schemaVersion: 1;
  stage: "settled";
  head: string;
  recordedAt: number;
}

interface CurrentAdvancePointer {
  schemaVersion: 1;
  worldId: string;
  chainId: string;
  advanceId: string;
}

export interface LoadedPlayAdvance {
  base: PlayAdvanceBase;
  providerCompleted: ProviderCompletedFact | null;
  settlementPrepared: SettlementPreparedFact | null;
  settled: SettledFact | null;
}

/**
 * Durable progress facts for the one play advance currently being settled.
 *
 * Every stage is immutable. `current.json` is only a small lookup projection;
 * deleting it cannot change Authority and a repeated user operation keeps the
 * same deterministic advance identity.
 */
export class FileNativePlayAdvanceStore {
  readonly #worldsRoot: string;

  constructor(dataRoot: string) {
    this.#worldsRoot = join(resolve(dataRoot), "worlds-file-native");
  }

  async begin(base: PlayAdvanceBase): Promise<void> {
    assertBase(base);
    const current = await this.readCurrent(base.worldId, base.chainId);
    if (current !== null && current.settled === null) {
      if (!sameAdvanceBase(current.base, base))
        throw new Error("Another play advance is still awaiting settlement");
      return;
    }
    const basePath = this.#factPath(base, "base.json");
    const existing = await readOptionalJson<unknown>(basePath);
    if (existing === null) await publishImmutableJson(basePath, base);
    else {
      assertBase(existing);
      if (!sameAdvanceBase(existing, base))
        throw new Error("A play advance identity is bound to different data");
    }
    await publishJson(this.#currentPath(base.worldId, base.chainId), {
      schemaVersion: 1,
      worldId: base.worldId,
      chainId: base.chainId,
      advanceId: base.advanceId,
    } satisfies CurrentAdvancePointer);
  }

  async recordProviderCompleted(
    base: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
    response: DurableModelHostResponse,
  ): Promise<void> {
    const durableBase = await this.#assertCurrent(base);
    await publishImmutableJson(
      this.#factPath(base, "provider-completed.json"),
      {
        schemaVersion: 1,
        stage: "provider_completed",
        response: structuredClone(response),
        recordedAt: durableBase.createdAt,
      } satisfies ProviderCompletedFact,
    );
  }

  async recordSettlementPrepared(
    base: Extract<PlayAdvanceBase, { advanceKind: "response" }>,
    settlement: PreparedPlayResponseSettlement,
  ): Promise<void> {
    const durableBase = await this.#assertCurrent(base);
    await publishImmutableJson(
      this.#factPath(base, "settlement-prepared.json"),
      {
        schemaVersion: 1,
        stage: "settlement_prepared",
        settlement: structuredClone(settlement),
        recordedAt: durableBase.createdAt,
      } satisfies SettlementPreparedFact,
    );
  }

  async markSettled(base: PlayAdvanceBase, head: string): Promise<void> {
    const durableBase = await this.#assertCurrent(base);
    await publishImmutableJson(this.#factPath(base, "settled.json"), {
      schemaVersion: 1,
      stage: "settled",
      head,
      recordedAt: durableBase.createdAt,
    } satisfies SettledFact);
  }

  async readCurrent(
    worldId: string,
    chainId: string,
  ): Promise<LoadedPlayAdvance | null> {
    assertIdentity(worldId, "World ID");
    assertIdentity(chainId, "Call-chain ID");
    const pointer = await readOptionalJson<unknown>(
      this.#currentPath(worldId, chainId),
    );
    if (pointer === null) return null;
    assertPointer(pointer);
    if (pointer.worldId !== worldId || pointer.chainId !== chainId)
      throw new Error("Play advance pointer belongs to another context");
    const recordRoot = this.#recordRoot(worldId, chainId, pointer.advanceId);
    const [base, providerCompleted, settlementPrepared, settled] =
      await Promise.all([
        readJson<unknown>(join(recordRoot, "base.json")),
        readOptionalJson<ProviderCompletedFact>(
          join(recordRoot, "provider-completed.json"),
        ),
        readOptionalJson<SettlementPreparedFact>(
          join(recordRoot, "settlement-prepared.json"),
        ),
        readOptionalJson<SettledFact>(join(recordRoot, "settled.json")),
      ]);
    assertBase(base);
    if (
      base.worldId !== worldId ||
      base.chainId !== chainId ||
      base.advanceId !== pointer.advanceId
    )
      throw new Error("Play advance durable identity is inconsistent");
    assertProviderCompleted(providerCompleted);
    assertSettlementPrepared(settlementPrepared);
    assertSettled(settled);
    return { base, providerCompleted, settlementPrepared, settled };
  }

  async #assertCurrent(base: PlayAdvanceBase): Promise<PlayAdvanceBase> {
    const current = await this.readCurrent(base.worldId, base.chainId);
    if (current === null || !sameAdvanceBase(current.base, base))
      throw new Error("Play advance is no longer current");
    return current.base;
  }

  #currentPath(worldId: string, chainId: string): string {
    return join(
      this.#worldsRoot,
      worldId,
      "runtime",
      "play-advances",
      digest(chainId),
      "current.json",
    );
  }

  #recordRoot(worldId: string, chainId: string, advanceId: string): string {
    return join(
      this.#worldsRoot,
      worldId,
      "runtime",
      "play-advances",
      digest(chainId),
      "records",
      digest(advanceId),
    );
  }

  #factPath(base: PlayAdvanceBase, name: string): string {
    return join(
      this.#recordRoot(base.worldId, base.chainId, base.advanceId),
      name,
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

function assertPointer(value: unknown): asserts value is CurrentAdvancePointer {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.worldId !== "string" ||
    typeof value.chainId !== "string" ||
    typeof value.advanceId !== "string"
  )
    throw new Error("Play advance pointer has an invalid shape");
}

function assertProviderCompleted(value: ProviderCompletedFact | null): void {
  if (
    value !== null &&
    (value.schemaVersion !== 1 ||
      value.stage !== "provider_completed" ||
      !isRecord(value.response) ||
      typeof value.recordedAt !== "number")
  )
    throw new Error("Provider-completed play fact has an invalid shape");
}

function assertSettlementPrepared(value: SettlementPreparedFact | null): void {
  if (
    value !== null &&
    (value.schemaVersion !== 1 ||
      value.stage !== "settlement_prepared" ||
      !isRecord(value.settlement) ||
      typeof value.recordedAt !== "number")
  )
    throw new Error("Settlement-prepared play fact has an invalid shape");
}

function assertSettled(value: SettledFact | null): void {
  if (
    value !== null &&
    (value.schemaVersion !== 1 ||
      value.stage !== "settled" ||
      typeof value.head !== "string" ||
      typeof value.recordedAt !== "number")
  )
    throw new Error("Settled play fact has an invalid shape");
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await readOptionalJson<unknown>(path);
  if (existing !== null) {
    if (!isDeepStrictEqual(existing, value))
      throw new Error("Immutable play-advance fact already has different data");
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await syncFile(temporary);
  try {
    await link(temporary, path);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const published = await readJson<unknown>(path);
    if (!isDeepStrictEqual(published, value))
      throw new Error("Concurrent immutable play-advance fact conflicts", {
        cause: error,
      });
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(dirname(path));
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
