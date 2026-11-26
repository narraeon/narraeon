import type { OrchestrationSurface } from "./orchestrationSession.ts";

export interface OrchestrationProvenanceRecord {
  snapshotId: string;
  groupId: string;
  fragments: { entryId: string; name: string; offset: number; end: number }[];
  rationale: string;
  droppedConditions: string[];
  requiresReview: boolean;
  extractedBodySha256: string;
  modified?: "manual" | "assistant";
}

export interface OrchestrationEntrySource {
  surface: OrchestrationSurface;
  entryId: string;
  source: OrchestrationProvenanceRecord;
}

export function isOrchestrationProvenanceRecord(
  value: unknown,
): value is OrchestrationProvenanceRecord {
  if (!object(value)) return false;
  return (
    typeof value.snapshotId === "string" &&
    /^[a-f0-9]{64}$/u.test(value.snapshotId) &&
    typeof value.groupId === "string" &&
    Array.isArray(value.fragments) &&
    value.fragments.length > 0 &&
    value.fragments.every(
      (fragment: unknown) =>
        object(fragment) &&
        typeof fragment.entryId === "string" &&
        typeof fragment.name === "string" &&
        typeof fragment.offset === "number" &&
        Number.isSafeInteger(fragment.offset) &&
        fragment.offset >= 0 &&
        typeof fragment.end === "number" &&
        Number.isSafeInteger(fragment.end) &&
        fragment.end > fragment.offset,
    ) &&
    typeof value.rationale === "string" &&
    Array.isArray(value.droppedConditions) &&
    value.droppedConditions.every(
      (condition: unknown) => typeof condition === "string",
    ) &&
    typeof value.requiresReview === "boolean" &&
    typeof value.extractedBodySha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.extractedBodySha256) &&
    (value.modified === undefined ||
      value.modified === "manual" ||
      value.modified === "assistant")
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
