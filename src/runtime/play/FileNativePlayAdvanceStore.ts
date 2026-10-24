import {
  isNarrativeOrigin,
  type NarrativeOrigin,
} from "../history/HistoryBackground.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ModelHostExchange } from "../model/ModelHost.ts";

/**
 * A play advance as the in-progress marker records it. The marker holds only
 * what recovery needs to recognize an interrupted advance after a restart
 * (ADR-0044), so it does not grow with the context.
 */
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
 * A player advance in memory. Settlement needs its frozen first request, which
 * is passed to `begin` and never written to the marker.
 */
export type PlayerAdvance = Extract<
  PlayAdvanceBase,
  { advanceKind: "player" }
> & { nextRequest: ModelHostExchange };

/** Written last by the released-record cleanup (ADR-0034); its absence means "not yet run". */
const LAYOUT_MARKER = "play-advance-layout.json";

/**
 * The single in-progress play advance of a call chain, if any.
 *
 * It exists only between `begin` and `markSettled`. A marker that survives a
 * restart means the advance was interrupted; the runtime marks the chain
 * interrupted and the player retries. Released records from earlier layouts
 * never block a world from opening, and the storage upgrade removes them
 * (see `migrateLayout`).
 */
export class FileNativePlayAdvanceStore {
  readonly #worldsRoot: string;

  constructor(dataRoot: string) {
    this.#worldsRoot = join(resolve(dataRoot), "worlds-file-native");
  }

  async begin(advance: PlayAdvanceBase | PlayerAdvance): Promise<void> {
    assertBase(advance);
    const marker = persistedAdvance(advance);
    const current = await this.readCurrent(marker.worldId, marker.chainId);
    if (current !== null) {
      if (!sameAdvance(current, marker))
        throw new Error("Another play advance is still awaiting settlement");
      return;
    }
    await publishJson(this.#markerPath(marker.worldId, marker.chainId), marker);
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

  async markSettled(advance: PlayAdvanceBase): Promise<void> {
    const current = await this.readCurrent(advance.worldId, advance.chainId);
    if (current === null) return;
    if (!sameAdvance(current, advance))
      throw new Error("Play advance is no longer current");
    await rm(this.#markerPath(advance.worldId, advance.chainId), {
      force: true,
    });
  }

  /** Remove the in-progress marker and all advance records of a discarded chain. */
  async discardChain(worldId: string, chainId: string): Promise<void> {
    await rm(dirname(this.#markerPath(worldId, chainId)), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Whether the world's advance records are free of the pre-ADR-0044 layout
   * (ADR-0034). Reads never write: a world with no released records is current
   * without a marker.
   */
  async layoutCurrent(worldId: string): Promise<boolean> {
    assertIdentity(worldId, "World ID");
    if (
      (await readOptionalJson<unknown>(this.#layoutMarkerPath(worldId))) !==
      null
    )
      return true;
    return (await this.#releasedChainRoots(worldId)).length === 0;
  }

  /**
   * Remove the released `records/` and `current.json` of every chain. Each
   * chain's `in-progress.json` stays as it is, and a chain left empty is removed.
   * The marker is written last, so an interrupted run simply runs again.
   */
  async migrateLayout(worldId: string): Promise<void> {
    assertIdentity(worldId, "World ID");
    if (await this.layoutCurrent(worldId)) return;
    for (const chainRoot of await this.#releasedChainRoots(worldId)) {
      await rm(join(chainRoot, "records"), { recursive: true, force: true });
      await rm(join(chainRoot, "current.json"), { force: true });
      if ((await readdir(chainRoot)).length === 0)
        await rm(chainRoot, { recursive: true, force: true });
    }
    await publishJson(this.#layoutMarkerPath(worldId), layoutMarker());
  }

  /** Chain directories that still hold a released record or pointer. */
  async #releasedChainRoots(worldId: string): Promise<string[]> {
    const advancesRoot = join(
      this.#worldsRoot,
      worldId,
      "runtime",
      "play-advances",
    );
    const roots: string[] = [];
    for (const name of await readDirectoryNames(advancesRoot)) {
      const chainRoot = join(advancesRoot, name);
      if (
        (await pathExists(join(chainRoot, "records"))) ||
        (await pathExists(join(chainRoot, "current.json")))
      )
        roots.push(chainRoot);
    }
    return roots;
  }

  #layoutMarkerPath(worldId: string): string {
    return join(this.#worldsRoot, worldId, "runtime", LAYOUT_MARKER);
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

/**
 * Whether two advances are the same one. The marker is confirmed by these
 * identity fields alone; the frozen request is never compared (ADR-0044).
 */
function sameAdvance(left: PlayAdvanceBase, right: PlayAdvanceBase): boolean {
  return (
    left.advanceKind === right.advanceKind &&
    left.worldId === right.worldId &&
    left.chainId === right.chainId &&
    left.advanceId === right.advanceId &&
    left.operationId === right.operationId &&
    left.eventId === right.eventId
  );
}

/** The marker form of an advance: a player advance's frozen request stays in memory. */
function persistedAdvance(
  advance: PlayAdvanceBase | PlayerAdvance,
): PlayAdvanceBase {
  if (!("nextRequest" in advance)) return advance;
  const { nextRequest: _nextRequest, ...marker } = advance;
  void _nextRequest;
  return marker;
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
      Number(value.exchange) < 1
    )
      throw new Error("Player advance has an invalid shape");
    // A marker released before ADR-0044 may still carry `nextRequest`. Recovery
    // never reads it, so the field is tolerated and not validated.
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

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function layoutMarker(): { schemaVersion: 1; kind: "play_advance_layout" } {
  return { schemaVersion: 1, kind: "play_advance_layout" };
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
