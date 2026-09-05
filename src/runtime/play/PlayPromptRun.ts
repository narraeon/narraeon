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

export function playPromptRunsThroughEvents(
  context: Pick<PersistedPlayCallChainContext, "promptRuns">,
  events: readonly PersistedPlayCallChainContext["events"][number][],
): PlayPromptRun[] {
  const lastEvent = events.at(-1)?.id ?? 0;
  const runs = (context.promptRuns ?? []).filter(
    ({ firstEventId }) => firstEventId <= lastEvent,
  );
  return structuredClone([
    ...new Map(runs.map((run) => [run.firstEventId, run])).values(),
  ]);
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
