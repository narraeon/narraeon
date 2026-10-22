import {
  validPromptCompilation,
  validPromptTools,
  validPlayFollowup,
} from "../prompt/PromptCompilationCodec.ts";
import { createHash } from "node:crypto";
import type { PersistedPlayCallChainContext } from "./FileNativePlayTimelineStore.ts";

/** Complete compiler output owned by one active send, including renderer resources. */
export interface PlayPromptRun {
  schemaVersion: 1;
  firstEventId: number;
  head: string;
  exchange: number;
  playPreset: PersistedPlayCallChainContext["playPreset"];
  bootstrap: PersistedPlayCallChainContext["bootstrap"];
  tools: PersistedPlayCallChainContext["tools"];
  followups: NonNullable<PersistedPlayCallChainContext["followups"]>;
  playPresetScriptsEnabled: boolean;
  /** Immutable source files required by preset-scoped renderer and asset references. */
  presetFiles: Record<string, string>;
}

type PromptSource = Pick<
  PersistedPlayCallChainContext,
  | "bootstrap"
  | "tools"
  | "playPreset"
  | "followups"
  | "playPresetScriptsEnabled"
  | "promptRuns"
>;

export function currentPlayPrompt(
  source: PromptSource,
): Omit<PromptSource, "promptRuns"> {
  return source.promptRuns?.at(-1) ?? source;
}

export function recordedPlayPrompt(
  source: PromptSource & Pick<PersistedPlayCallChainContext, "events">,
): Omit<PromptSource, "promptRuns"> {
  const lastEvent = source.events.at(-1)?.id ?? 0;
  return (
    source.promptRuns?.findLast((run) => run.firstEventId <= lastEvent) ??
    source
  );
}

/** Shared runs are frozen, so the returned runs are the context's own. */
export function playPromptRunsThroughEvents(
  context: Pick<PersistedPlayCallChainContext, "promptRuns">,
  events: readonly PersistedPlayCallChainContext["events"][number][],
): PlayPromptRun[] {
  const lastEvent = events.at(-1)?.id ?? 0;
  const runs = (context.promptRuns ?? []).filter(
    ({ firstEventId }) => firstEventId <= lastEvent,
  );
  return [...new Map(runs.map((run) => [run.firstEventId, run])).values()];
}

/**
 * Every send records the whole compiled prompt, so a long context repeats the
 * same large strings in each of its runs (over 99% of a 143-run context). The
 * strings of one context's runs are pooled while they are read or recorded.
 */
export type PromptRunStrings = Map<string, string>;

/** Strings shorter than this are not worth a pool entry. */
const sharedStringLength = 128;

/**
 * Make a freshly built or decoded run share the pool's equal strings, then
 * freeze it: contexts and their copies hold the same run instead of a clone.
 */
export function sharePromptRun(
  run: PlayPromptRun,
  strings: PromptRunStrings,
): PlayPromptRun {
  return deepFreeze(internStrings(run, strings));
}

/** A pool seeded with an already shared run's strings. */
export function promptRunStrings(
  run: PlayPromptRun | undefined,
): PromptRunStrings {
  const strings: PromptRunStrings = new Map();
  if (run !== undefined) collectStrings(run, strings);
  return strings;
}

/**
 * Deep-copy a context or session while sharing its frozen prompt runs, the
 * only part of it that is large.
 */
export function cloneSharingPromptRuns<
  T extends { promptRuns?: PlayPromptRun[] },
>(value: T): T {
  const { promptRuns, ...rest } = value;
  const copy = structuredClone(rest) as T;
  if (promptRuns !== undefined) copy.promptRuns = [...promptRuns];
  return copy;
}

function internStrings<T>(value: T, strings: PromptRunStrings): T {
  if (typeof value === "string") return intern(value, strings) as T;
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    record[key] = internStrings(record[key], strings);
  return value;
}

function intern(value: string, strings: PromptRunStrings): string {
  if (value.length < sharedStringLength) return value;
  const shared = strings.get(value);
  if (shared !== undefined) return shared;
  strings.set(value, value);
  return value;
}

function collectStrings(value: unknown, strings: PromptRunStrings): void {
  if (typeof value === "string") {
    intern(value, strings);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const item of Object.values(value)) collectStrings(item, strings);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export function assertPlayPromptRun(
  value: unknown,
): asserts value is PlayPromptRun {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid play prompt run");
  const run = value as Record<string, unknown>;
  if (
    !exactKeys(run, [
      "schemaVersion",
      "firstEventId",
      "head",
      "exchange",
      "playPreset",
      "bootstrap",
      "tools",
      "followups",
      "playPresetScriptsEnabled",
      "presetFiles",
    ]) ||
    run.schemaVersion !== 1 ||
    !Number.isSafeInteger(run.firstEventId) ||
    Number(run.firstEventId) < 1 ||
    !Number.isSafeInteger(run.exchange) ||
    Number(run.exchange) < 1 ||
    typeof run.head !== "string" ||
    !validPresetIdentity(run.playPreset) ||
    !validPromptCompilation(run.bootstrap) ||
    !validPromptTools(run.tools) ||
    !Array.isArray(run.followups) ||
    !run.followups.every(validPlayFollowup) ||
    typeof run.playPresetScriptsEnabled !== "boolean" ||
    typeof run.presetFiles !== "object" ||
    run.presetFiles === null ||
    Array.isArray(run.presetFiles) ||
    !Object.values(run.presetFiles).every(
      (contents) => typeof contents === "string",
    )
  )
    throw new Error("Invalid play prompt run");
}

export function encodePlayPromptRun(run: PlayPromptRun): unknown {
  assertPlayPromptRun(run);
  return {
    kind: "play_prompt_run",
    schemaVersion: 1,
    run,
    digest: createHash("sha256").update(JSON.stringify(run)).digest("hex"),
  };
}

export function decodePlayPromptRun(value: unknown): PlayPromptRun {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid play prompt run record");
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["kind", "schemaVersion", "run", "digest"]) ||
    record.kind !== "play_prompt_run" ||
    record.schemaVersion !== 1 ||
    record.digest !==
      createHash("sha256")
        .update(JSON.stringify(record.run) ?? "")
        .digest("hex")
  )
    throw new Error("Play prompt run does not match its durable identity");
  assertPlayPromptRun(record.run);
  return record.run;
}

function exactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

function validPresetIdentity(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const preset = value as Record<string, unknown>;
  return (
    exactKeys(preset, ["id", "name", "revision"]) &&
    [preset.id, preset.name, preset.revision].every(
      (part) => typeof part === "string" && part.length > 0,
    )
  );
}
