export interface WorldWritePosition {
  kind: "world_origin" | "play" | "correction" | "history";
  /** Human-readable context order on the current timeline, never an opaque id. */
  context: number | null;
  round: number;
  worldTime: string | null;
}

export interface WorldDocumentMaintenance {
  baselineKind: "world_origin" | "document_creation" | "unavailable";
  baselineBytes: number | null;
  lastBodyWrite: WorldWritePosition | null;
  lastMetadataWrite: WorldWritePosition | null;
  bodyChangedContexts: number;
  metadataChangedContexts: number;
}

export interface WorldPromptMaintenance {
  unit: "utf8_bytes";
  worldMaterialsBytes: number;
  checkpointHistoryBytes: number;
  authorInstructionBytes: number;
  runtimeInstructionBytes: number;
  toolDefinitionBytes: number;
  documents: (WorldDocumentMaintenance & {
    shortRef: string;
    title: string;
    bodyBytes: number;
    injectedBytes: number;
    growthBytes: number | null;
    growthRatio: number | null;
    advisoryBytes: number | null;
    overAdvisory: boolean;
  })[];
  slots: {
    id: string;
    bytes: number;
    advisoryBytes: number | null;
    overAdvisory: boolean;
    documents: string[];
  }[];
}

export function isWorldPromptMaintenance(
  value: unknown,
): value is WorldPromptMaintenance {
  if (
    !record(value) ||
    value.unit !== "utf8_bytes" ||
    ![
      "worldMaterialsBytes",
      "checkpointHistoryBytes",
      "authorInstructionBytes",
      "runtimeInstructionBytes",
      "toolDefinitionBytes",
    ].every((key) => count(value[key])) ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.slots)
  )
    return false;
  return (
    value.documents.every(
      (item: unknown) =>
        record(item) &&
        typeof item.shortRef === "string" &&
        typeof item.title === "string" &&
        count(item.bodyBytes) &&
        count(item.injectedBytes) &&
        ["world_origin", "document_creation", "unavailable"].includes(
          String(item.baselineKind),
        ) &&
        nullableCount(item.baselineBytes) &&
        nullableNumber(item.growthBytes) &&
        nullableNumber(item.growthRatio) &&
        nullableCount(item.advisoryBytes) &&
        typeof item.overAdvisory === "boolean" &&
        position(item.lastBodyWrite) &&
        position(item.lastMetadataWrite) &&
        count(item.bodyChangedContexts) &&
        count(item.metadataChangedContexts),
    ) &&
    value.slots.every(
      (slot: unknown) =>
        record(slot) &&
        typeof slot.id === "string" &&
        count(slot.bytes) &&
        nullableCount(slot.advisoryBytes) &&
        typeof slot.overAdvisory === "boolean" &&
        Array.isArray(slot.documents) &&
        slot.documents.every((ref: unknown) => typeof ref === "string"),
    )
  );
}

function position(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      ["world_origin", "play", "correction", "history"].includes(
        String(value.kind),
      ) &&
      nullableCount(value.context) &&
      count(value.round) &&
      (value.worldTime === null || typeof value.worldTime === "string"))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nullableCount(value: unknown): boolean {
  return value === null || count(value);
}
function nullableNumber(value: unknown): boolean {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

/** Display only recorded provenance; a write position is not character knowledge. */
export function worldWritePositionText(
  position: WorldWritePosition | null,
  locale: "zh-CN" | "en",
): string {
  const zh = locale === "zh-CN";
  if (position === null) return zh ? "未记录" : "Not recorded";
  const place =
    position.kind === "world_origin"
      ? zh
        ? "世界创建时"
        : "World creation"
      : position.kind === "play" && position.context !== null
        ? zh
          ? `上下文 ${position.context} · 第 ${position.round} 回合`
          : `Context ${position.context} · round ${position.round}`
        : zh
          ? `${position.kind === "correction" ? "连续性修订" : "历史提交"} · 玩家输入位置 ${position.round}`
          : `${position.kind === "correction" ? "Continuity correction" : "History commit"} · player input position ${position.round}`;
  return `${place} · ${zh ? "写入时世界时间" : "World time at write"}: ${position.worldTime ?? (zh ? "未记录" : "not recorded")}`;
}
