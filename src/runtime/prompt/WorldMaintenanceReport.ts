import { worldWritePositionText } from "../../protocol/worldMaintenance.ts";
import type {
  WorldDocumentMaintenance,
  WorldPromptMaintenance,
} from "../../protocol/worldMaintenance.ts";
import type {
  FileNativeWorldDocumentSnapshot,
  PromptCompilation,
} from "./FileNativePromptCompiler.ts";
import type { WorldDocumentDescriptor } from "../world/WorldDocumentStore.ts";
import type { AppLocale } from "../../protocol/appPreferences.ts";
import { parseDocument } from "yaml";

export interface MeasuredWorldMaterial {
  source: string;
  markdown: string;
  slotId?: string;
  contributions?: { shortRef: string; bytes: number }[];
}

export interface WorldMaintenanceSettings {
  documents: Record<string, number>;
  clock?: {
    document: string;
    locator: { yaml: string[] } | { markdown: string[] };
  };
}

export function worldMaintenanceSettings(
  frame: Record<string, unknown>,
): WorldMaintenanceSettings {
  const slotIds = new Set<string>();
  for (const entry of Array.isArray(frame.context) ? frame.context : []) {
    const slot = record(entry) && record(entry.slot) ? entry.slot : null;
    if (
      slot === null ||
      (slot.id === undefined && slot.advisoryBytes === undefined)
    )
      continue;
    if (
      typeof slot.id !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(slot.id) ||
      slotIds.has(slot.id)
    )
      throw new Error("Advisory slots require unique stable slot.id values");
    slotIds.add(slot.id);
    if (slot.advisoryBytes !== undefined && !positiveBytes(slot.advisoryBytes))
      throw new Error("slot.advisoryBytes must be a positive UTF-8 byte limit");
  }
  const value = frame.maintenance;
  if (value === undefined) return { documents: {} };
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== "documents" && key !== "clock")
  )
    throw new Error("world frame.maintenance accepts only documents and clock");
  const documents = value.documents ?? {};
  if (
    !record(documents) ||
    Object.entries(documents).some(
      ([key, limit]) =>
        !/^@[a-z][a-z0-9-]*$/u.test(key) || !positiveBytes(limit),
    )
  )
    throw new Error(
      "maintenance.documents maps document @short-refs to positive advisory UTF-8 byte limits",
    );
  if (value.clock === undefined)
    return { documents: documents as Record<string, number> };
  const clock = value.clock;
  if (
    !record(clock) ||
    Object.keys(clock).length !== 2 ||
    typeof clock.document !== "string" ||
    !clock.document.startsWith("@") ||
    !record(clock.locator) ||
    Object.keys(clock.locator).length !== 1
  )
    throw new Error(
      "maintenance.clock requires an exact document @short-ref and locator",
    );
  const path: unknown = clock.locator.yaml ?? clock.locator.markdown;
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    !path.every((part) => typeof part === "string") ||
    (!Object.hasOwn(clock.locator, "yaml") &&
      !Object.hasOwn(clock.locator, "markdown"))
  )
    throw new Error(
      "maintenance.clock.locator must name an exact YAML or Markdown node",
    );
  return {
    documents: documents as Record<string, number>,
    clock: {
      document: clock.document,
      locator: Object.hasOwn(clock.locator, "yaml")
        ? { yaml: path }
        : { markdown: path },
    },
  };
}

export function listWorldDocuments(
  snapshot: FileNativeWorldDocumentSnapshot,
): WorldDocumentDescriptor[] {
  const result: WorldDocumentDescriptor[] = [];
  const pending = [""];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.shift()!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    let cursor: string | null = null;
    do {
      const page = snapshot.query({
        kind: "catalog",
        directory,
        limit: 100,
        cursor,
      });
      if (page.kind !== "catalog")
        throw new Error("World-document inventory could not be read");
      for (const entry of page.entries) {
        if (entry.kind === "directory") {
          if (!entry.logicalPath.startsWith(`${snapshot.logicalRoot}/`))
            throw new Error(
              "World-document inventory escaped its logical root",
            );
          pending.push(
            entry.logicalPath.slice(snapshot.logicalRoot.length + 1),
          );
        } else if (entry.document !== undefined) result.push(entry.document);
      }
      cursor = page.page.nextCursor;
    } while (cursor !== null);
  }
  return result.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
}

export function measureWorldMaterials(
  snapshot: FileNativeWorldDocumentSnapshot,
  frame: Record<string, unknown>,
  materials: readonly MeasuredWorldMaterial[],
  facts: Readonly<Record<string, WorldDocumentMaintenance>> = {},
): WorldPromptMaintenance {
  const settings = worldMaintenanceSettings(frame);
  const contributions = new Map<string, number>();
  for (const material of materials)
    for (const contribution of material.contributions ?? [])
      contributions.set(
        contribution.shortRef,
        (contributions.get(contribution.shortRef) ?? 0) + contribution.bytes,
      );
  const documents = listWorldDocuments(snapshot).map((document) => {
    const read = snapshot.query({
      kind: "read_document",
      document: { shortRef: document.shortRef },
    });
    if (read.kind !== "read_document")
      throw new Error(`Document @${document.shortRef} could not be measured`);
    const bodyBytes = Buffer.byteLength(read.body, "utf8");
    const fact = facts[document.shortRef] ?? {
      baselineKind: "unavailable" as const,
      baselineBytes: null,
      lastBodyWrite: null,
      lastMetadataWrite: null,
      bodyChangedContexts: 0,
      metadataChangedContexts: 0,
    };
    const advisoryBytes = settings.documents[`@${document.shortRef}`] ?? null;
    return {
      ...fact,
      shortRef: document.shortRef,
      title: document.title,
      bodyBytes,
      injectedBytes: contributions.get(document.shortRef) ?? 0,
      growthBytes:
        fact.baselineBytes === null ? null : bodyBytes - fact.baselineBytes,
      growthRatio:
        fact.baselineBytes === null || fact.baselineBytes === 0
          ? null
          : bodyBytes / fact.baselineBytes,
      advisoryBytes,
      overAdvisory: advisoryBytes !== null && bodyBytes > advisoryBytes,
    };
  });
  const slots = (Array.isArray(frame.context) ? frame.context : []).flatMap(
    (entry: unknown) => {
      const slot = record(entry) && record(entry.slot) ? entry.slot : null;
      if (
        slot === null ||
        (slot.id === undefined && slot.advisoryBytes === undefined)
      )
        return [];
      // worldMaintenanceSettings validated all declared slot ids and limits.
      const id = slot.id as string;
      const bytes = materials
        .filter(({ slotId }) => slotId === slot.id)
        .reduce(
          (sum, { markdown }) => sum + Buffer.byteLength(markdown, "utf8"),
          0,
        );
      const advisoryBytes =
        typeof slot.advisoryBytes === "number" ? slot.advisoryBytes : null;
      return [
        {
          id,
          bytes,
          advisoryBytes,
          overAdvisory: advisoryBytes !== null && bytes > advisoryBytes,
          documents: [
            ...new Set(
              materials
                .filter(({ slotId }) => slotId === slot.id)
                .flatMap(
                  ({ contributions: items }) =>
                    items?.map(({ shortRef }) => shortRef) ?? [],
                ),
            ),
          ],
        },
      ];
    },
  );
  return {
    unit: "utf8_bytes",
    worldMaterialsBytes: 0,
    checkpointHistoryBytes: materials
      .filter(({ source }) => source.startsWith("runtime:checkpoint-history:"))
      .reduce(
        (sum, { markdown }) => sum + Buffer.byteLength(markdown, "utf8"),
        0,
      ),
    authorInstructionBytes: 0,
    runtimeInstructionBytes: 0,
    toolDefinitionBytes: 0,
    documents,
    slots,
  };
}

export function refreshMaintenanceTotals(compilation: PromptCompilation): void {
  const report = compilation.maintenance;
  if (report === undefined) return;
  const bytes = (role: string) =>
    compilation.logicalMessages
      .filter((message) => message.role === role)
      .reduce(
        (sum, { markdown }) => sum + Buffer.byteLength(markdown, "utf8"),
        0,
      );
  report.worldMaterialsBytes = bytes("world_context");
  report.authorInstructionBytes = bytes("author_instruction");
  report.runtimeInstructionBytes = bytes("runtime_system");
  report.toolDefinitionBytes = Buffer.byteLength(
    JSON.stringify(compilation.tools),
    "utf8",
  );
}

export function renderWriteSizeAdvice(
  report: WorldPromptMaintenance,
  shortRef: string,
  previousBodyBytes: number | null,
  locale: AppLocale,
): string {
  const document = report.documents.find(
    (entry) => entry.shortRef === shortRef,
  );
  if (document === undefined) return "";
  const zh = locale === "zh-CN";
  const lines: string[] = [];
  if (document.overAdvisory) {
    const delta =
      previousBodyBytes === null
        ? zh
          ? "本次新建"
          : "new document"
        : `${zh ? "本次变化" : "change"} ${document.bodyBytes - previousBodyBytes >= 0 ? "+" : ""}${document.bodyBytes - previousBodyBytes}`;
    lines.push(
      zh
        ? `整理提示：正文 ${document.bodyBytes} UTF-8 字节，建议上限 ${document.advisoryBytes}；${delta}。`
        : `Maintenance advice: body ${document.bodyBytes} UTF-8 bytes, advisory limit ${document.advisoryBytes}; ${delta}.`,
    );
  }
  for (const slot of report.slots.filter(
    (entry) => entry.overAdvisory && entry.documents.includes(shortRef),
  ))
    lines.push(
      zh
        ? `材料槽 ${slot.id}：${slot.bytes} UTF-8 字节，建议上限 ${slot.advisoryBytes}。`
        : `Material slot ${slot.id}: ${slot.bytes} UTF-8 bytes, advisory limit ${slot.advisoryBytes}.`,
    );
  return lines.join("\n");
}

export function readDeclaredWorldClock(
  snapshot: FileNativeWorldDocumentSnapshot,
): string | undefined {
  const source = snapshot.files.find(
    ({ path }) => path === "control/frame.yaml",
  )?.contents;
  if (source === undefined) return undefined;
  const parsed = parseDocument(source);
  if (parsed.errors.length > 0) return undefined;
  const frame: unknown = parsed.toJS();
  if (!record(frame)) return undefined;
  const clock = worldMaintenanceSettings(frame).clock;
  if (clock === undefined) return undefined;
  const selected = snapshot.query({
    kind: "select_node",
    document: { shortRef: clock.document.slice(1) },
    locator: clock.locator,
  });
  if (selected.kind !== "select_node") return undefined;
  if (selected.node.codec === "markdown") return selected.node.markdown;
  const value = selected.node.value;
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : undefined;
}

function positiveBytes(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function renderDocumentWritePosition(
  shortRef: string,
  fact: WorldDocumentMaintenance | undefined,
  locale: AppLocale,
): string {
  if (fact === undefined)
    return `${locale === "zh-CN" ? "最近写入位置" : "Last committed write"} @${shortRef}: ${locale === "zh-CN" ? "未记录" : "not recorded"}`;
  return locale === "zh-CN"
    ? `最近写入位置 @${shortRef}：\n正文：${worldWritePositionText(fact.lastBodyWrite, locale)}\n元信息：${worldWritePositionText(fact.lastMetadataWrite, locale)}`
    : `Last committed write @${shortRef}:\nBody: ${worldWritePositionText(fact.lastBodyWrite, locale)}\nMetadata: ${worldWritePositionText(fact.lastMetadataWrite, locale)}`;
}

export function renderWorldMaintenanceReport(
  report: WorldPromptMaintenance | undefined,
  locale: AppLocale,
): string {
  if (report === undefined) return "";
  const zh = locale === "zh-CN";
  return [
    zh
      ? "# 文档整理报告（UTF-8 字节；超限仅提示）"
      : "# Document maintenance (UTF-8 bytes; advisory only)",
    `${zh ? "世界材料 / 其中检查点历史 / 作者提示 / Runtime 提示 / 工具定义" : "World materials / checkpoint history subset / author instructions / Runtime instructions / tool definitions"}: ${report.worldMaterialsBytes} / ${report.checkpointHistoryBytes} / ${report.authorInstructionBytes} / ${report.runtimeInstructionBytes} / ${report.toolDefinitionBytes}`,
    ...report.documents.map(
      (document) =>
        `@${document.shortRef}: ${zh ? "正文 / 注入贡献 / 建议上限 / 基准 / 增长" : "body / injection contribution / advisory / baseline / growth"}: ${document.bodyBytes} / ${document.injectedBytes} / ${document.advisoryBytes ?? "—"} / ${document.baselineBytes ?? "—"} / ${document.growthBytes ?? "—"}${document.overAdvisory ? (zh ? "（超过建议）" : " (over advisory)") : ""}`,
    ),
    ...report.slots.map(
      (slot) =>
        `${zh ? "材料槽" : "Slot"} ${slot.id}: ${slot.bytes} / ${slot.advisoryBytes ?? "—"}${slot.overAdvisory ? (zh ? "（超过建议）" : " (over advisory)") : ""}`,
    ),
  ].join("\n");
}
