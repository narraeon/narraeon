import type { AppLocale } from "../../protocol/appPreferences.ts";
import { parseGameplay } from "../../protocol/gameplay.ts";
import type {
  OrchestrationSurface,
  V1OrchestrationChangeSet,
} from "../../protocol/orchestrationSession.ts";
import type {
  ModelConnectionPrompt,
  ModelHostBinding,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import {
  parsePlayPresetFiles,
  revisionForPlayPresetFiles,
  type OrchestrationDraftTarget,
  type PlayPresetBinding,
} from "../play/FileNativePlayPresetStore.ts";
import {
  compareOrchestrationPreviews,
  compileOrchestrationPreview,
} from "../play/OrchestrationPreview.ts";
import type { PromptCompilation } from "../prompt/FileNativePromptCompiler.ts";
import { orchestrationEditorSystem } from "./EditorSystem.ts";
import {
  applyEditOperation,
  editOperationsSchema,
  editorEntry,
  editorEntryDiff,
  editorSurface,
  editorSurfaces,
  parseEditOperation,
  promptCatalog,
  readEditorEntries,
  record,
  validId,
  writeEditorEntries,
  type EditOperation,
  type EditorEntries,
  type EntryRead,
} from "./EditorOperations.ts";

interface ToolResult {
  kind: "tool";
  toolCallId: string;
  markdown: string;
  isError?: true;
}

export interface OrchestrationEditorExtension {
  readonly tools: PromptCompilation["tools"];
  readonly provenanceSchema?: object;
  summarize(
    presetId: string,
  ): Promise<Record<string, string | number> | undefined>;
  read(input: {
    presetId: string;
    sourceSnapshotId?: string | undefined;
    call: ModelHostToolCall;
    evidence: readonly unknown[];
  }): Promise<{ data: unknown; evidence?: unknown }>;
  validateProvenance(input: {
    presetId: string;
    sourceSnapshotId?: string | undefined;
    surface: OrchestrationSurface;
    operation: EditOperation;
    evidence: readonly unknown[];
  }): Promise<unknown>;
  validatePublication?(input: {
    presetId: string;
    revision: string;
    entries: V1OrchestrationChangeSet["entries"];
    provenance: NonNullable<V1OrchestrationChangeSet["provenance"]>;
  }): Promise<void>;
}

export interface EditorAuthorization {
  revision: string;
  epoch: string;
  head: string;
  reads: EntryRead[];
  sourceEvidence: unknown[];
  sourceSnapshotId?: string;
}

interface EditorPublication {
  files: Record<string, string>;
  revision: string;
  surface: OrchestrationSurface;
  operationIds: string[];
  entries: V1OrchestrationChangeSet["entries"];
  provenance: { operationId: string; entryId: string; value: unknown }[];
}

export interface EditorSettlement {
  results: ToolResult[];
  authorization: EditorAuthorization;
  publication?: EditorPublication;
}

const surfaceProperty = { type: "string", enum: editorSurfaces };
const textProperty = { type: "string" };
const numberProperty = { type: "integer", minimum: 0 };

function definition(
  name: string,
  description: string,
  properties: object,
  required: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

export function orchestrationEditorTools(
  extension?: OrchestrationEditorExtension,
): PromptCompilation["tools"] {
  return [
    definition(
      "orchestration_list",
      "Read the draft revision, effective ordered entry identities, roles, scopes and current builtin catalog. No world or package access.",
      { surface: surfaceProperty },
    ),
    definition(
      "orchestration_read",
      "Read an entry in the exact draft revision before editing. Read all segments for a large body. Offsets count UTF-16 code units.",
      {
        surface: surfaceProperty,
        revision: textProperty,
        entryId: textProperty,
        offset: numberProperty,
        limit: numberProperty,
      },
      ["surface", "revision", "entryId"],
    ),
    definition(
      "orchestration_preview",
      "Compile a read-only structural preview and compare with the applied revision. World and author materials remain placeholders.",
      {
        surface: surfaceProperty,
        revision: textProperty,
        gameplay: {
          type: "string",
          enum: ["interactive-fiction", "d20", "d100", "bag"],
        },
        authorTarget: { type: "string", enum: ["setting", "world-revision"] },
      },
      ["surface", "revision"],
    ),
    definition(
      "orchestration_reference_read",
      "Read a builtin's current default body, the SillyTavern static macro reference, or a section of the editing guide.",
      {
        topic: {
          type: "string",
          enum: ["builtin", "sillytavern-macros", "runtime-guide"],
        },
        surface: surfaceProperty,
        builtinId: textProperty,
        offset: numberProperty,
        limit: numberProperty,
      },
      ["topic"],
    ),
    ...(extension?.tools ?? []),
    definition(
      "orchestration_edit",
      "Publish one validated draft batch on one surface. Read existing entries completely first. Use create/update/move/delete or replace_builtin to change replaceable builtin prefix text. Do not apply a draft with a tool.",
      {
        surface: surfaceProperty,
        expectedRevision: textProperty,
        operations: editOperationsSchema(extension?.provenanceSchema),
      },
      ["surface", "expectedRevision", "operations"],
    ),
  ];
}

export async function settleEditorTools(input: {
  target: OrchestrationDraftTarget;
  calls: readonly ModelHostToolCall[];
  allowedTools: ReadonlySet<string>;
  authorization: EditorAuthorization;
  modelBinding: ModelHostBinding;
  modelPrompt?: ModelConnectionPrompt;
  locale: AppLocale;
  extension?: OrchestrationEditorExtension;
  operationAlreadyUsed: (id: string) => boolean;
}): Promise<EditorSettlement> {
  const { target, locale } = input;
  const auth = structuredClone(input.authorization);
  const results = new Map<string, ToolResult>();
  const edits: ModelHostToolCall[] = [];
  const allowed = input.allowedTools;
  const inspect = () => (currentEntries ??= readEditorEntries(target.files));
  let currentEntries: EditorEntries | undefined;
  for (const call of input.calls) {
    if (!allowed.has(call.name)) {
      results.set(
        call.id,
        failure(
          call,
          "This tool is outside the orchestration editor's frozen tool scope",
        ),
      );
      continue;
    }
    try {
      switch (call.name) {
        case "orchestration_reference_read":
          results.set(
            call.id,
            success(call, reference(call.arguments, locale)),
          );
          break;
        case "orchestration_list":
          assertCurrent(target, auth);
          results.set(
            call.id,
            success(call, list(call.arguments, target, inspect(), locale)),
          );
          break;
        case "orchestration_read":
          assertCurrent(target, auth);
          results.set(
            call.id,
            success(
              call,
              read(call.arguments, target, inspect(), auth, locale),
            ),
          );
          break;
        case "orchestration_preview":
          assertCurrent(target, auth);
          results.set(
            call.id,
            success(
              call,
              preview(
                call.arguments,
                target,
                input.modelBinding,
                input.modelPrompt,
                locale,
              ),
            ),
          );
          break;
        case "orchestration_edit":
          edits.push(call);
          break;
        default: {
          if (!input.extension?.tools.some(({ name }) => name === call.name))
            throw new Error("Unknown orchestration editor tool");
          const read = await input.extension.read({
            presetId: target.id,
            sourceSnapshotId: auth.sourceSnapshotId,
            call,
            evidence: auth.sourceEvidence,
          });
          if (read.evidence !== undefined)
            auth.sourceEvidence.push(read.evidence);
          results.set(call.id, success(call, read.data));
        }
      }
    } catch (error) {
      results.set(call.id, failure(call, errorMessage(error)));
    }
  }

  let publication: EditorPublication | undefined;
  if (edits.length > 0) {
    try {
      assertCurrent(target, auth);
      const before = inspect();
      const after = structuredClone(before);
      let surface: OrchestrationSurface | undefined;
      const operationIds = new Set<string>();
      const provenance: EditorPublication["provenance"] = [];
      for (const call of edits) {
        const args = fields(call.arguments, [
          "surface",
          "expectedRevision",
          "operations",
        ]);
        const editSurface = editorSurface(args.surface);
        if (surface !== undefined && surface !== editSurface)
          throw new Error(
            "A complete response may publish edits on only one surface",
          );
        surface = editSurface;
        assertRevision(args.expectedRevision, target.revision);
        if (
          !Array.isArray(args.operations) ||
          args.operations.length === 0 ||
          operationIds.size + args.operations.length > 32
        )
          throw new Error("Send 1 to 32 operations for the complete response");
        const catalog = promptCatalog(surface, locale);
        for (const raw of args.operations) {
          const operation = parseEditOperation(raw);
          if (
            operationIds.has(operation.operationId) ||
            input.operationAlreadyUsed(operation.operationId)
          )
            throw new Error(
              `Operation identity ${operation.operationId} has already been used`,
            );
          operationIds.add(operation.operationId);
          if (operation.provenance !== undefined) {
            if (!input.extension?.provenanceSchema)
              throw new Error("No source provenance capability is available");
            const value = await input.extension.validateProvenance({
              presetId: target.id,
              sourceSnapshotId: auth.sourceSnapshotId,
              surface,
              operation,
              evidence: input.authorization.sourceEvidence,
            });
            provenance.push({
              operationId: operation.operationId,
              entryId: operation.newEntryId ?? operation.entryId,
              value,
            });
          }
          applyEditOperation({
            entries: after[surface],
            operation,
            catalog,
            surface,
            wasRead: (entryId) =>
              completelyRead(input.authorization, editSurface, entryId),
          });
        }
      }
      const entries = editorEntryDiff(before, after, locale);
      if (
        provenance.some(
          ({ entryId }) =>
            !entries.some(
              (entry) => entry.entryId === entryId && entry.after !== null,
            ),
        )
      )
        throw new Error(
          "A source annotation must accompany an actual prompt edit",
        );
      await input.extension?.validatePublication?.({
        presetId: target.id,
        revision: target.revision,
        entries,
        provenance,
      });
      const files =
        entries.length === 0
          ? target.files
          : writeEditorEntries(target.files, before, after);
      const revision = revisionForPlayPresetFiles(files);
      if (revision !== target.revision) {
        publication = {
          files,
          revision,
          entries,
          surface: surface!,
          operationIds: [...operationIds],
          provenance,
        };
        auth.revision = revision;
        auth.reads = [];
      }
      for (const call of edits)
        results.set(
          call.id,
          success(call, {
            status: publication ? "draft_saved" : "unchanged",
            beforeRevision: target.revision,
            revision,
            changedEntryIds: entries.map(({ entryId }) => entryId),
          }),
        );
    } catch (error) {
      for (const call of edits)
        results.set(call.id, failure(call, errorMessage(error)));
    }
  }
  return {
    results: input.calls.map(({ id }) => results.get(id)!),
    authorization: auth,
    ...(publication === undefined ? {} : { publication }),
  };
}

function assertCurrent(
  target: OrchestrationDraftTarget,
  auth: EditorAuthorization,
): void {
  assertRevision(
    auth.epoch === target.epoch && auth.head === target.head
      ? auth.revision
      : null,
    target.revision,
  );
}

function assertRevision(expected: unknown, revision: string): void {
  if (expected !== revision)
    throw new Error(
      `The saved draft revision changed (current: ${revision}); ask the author to reload and send a new message`,
    );
}

function list(
  raw: unknown,
  target: OrchestrationDraftTarget,
  entries: EditorEntries,
  locale: AppLocale,
) {
  const args = fields(raw, ["surface"]);
  const surfaces =
    args.surface === undefined ? editorSurfaces : [editorSurface(args.surface)];
  return {
    revision: target.revision,
    currentRevision: target.currentRevision,
    surfaces: surfaces.map((surface) => {
      const catalog = promptCatalog(surface, locale);
      return {
        surface,
        entries: entries[surface].map((entry, index) => {
          const { text, ...summary } = editorEntry(
            entry,
            index,
            catalog,
            worldName(locale),
          );
          const builtin =
            entry.kind === "builtin"
              ? catalog.find(({ id }) => id === entry.builtin)
              : undefined;
          return {
            ...summary,
            bodyLength: text.length,
            builtin: builtin?.id,
            group: builtin?.group,
            required: builtin?.required,
            dynamic: builtin?.dynamic,
          };
        }),
        catalog: catalog.map(({ body, ...entry }) => ({
          ...entry,
          bodyLength: body.length,
        })),
      };
    }),
  };
}

function read(
  raw: unknown,
  target: OrchestrationDraftTarget,
  entries: EditorEntries,
  auth: EditorAuthorization,
  locale: AppLocale,
) {
  const args = fields(raw, [
    "surface",
    "entryId",
    "revision",
    "offset",
    "limit",
  ]);
  const surface = editorSurface(args.surface);
  assertRevision(args.revision, target.revision);
  if (!validId(args.entryId)) throw new Error("Invalid entry ID");
  const entryId = args.entryId;
  const index = entries[surface].findIndex(({ id }) => id === entryId);
  const entry = entries[surface][index];
  if (!entry) throw new Error("No such entry on the requested surface");
  const details = editorEntry(
    entry,
    index,
    promptCatalog(surface, locale),
    worldName(locale),
  );
  const part = slice(details.text, args);
  let read = auth.reads.find(
    (item) => item.surface === surface && item.entryId === entryId,
  );
  if (read === undefined) {
    read = { surface, entryId, length: details.text.length, ranges: [] };
    auth.reads.push(read);
  }
  read.ranges = mergeRanges([...read.ranges, [part.offset, part.end]]);
  return {
    ...details,
    ...part,
    revision: target.revision,
    completeForEditing: completelyRead(auth, surface, entryId),
    ...(entry.kind === "builtin" ? { builtin: entry.builtin } : {}),
  };
}

function preview(
  raw: unknown,
  target: OrchestrationDraftTarget,
  binding: ModelHostBinding,
  modelPrompt: ModelConnectionPrompt | undefined,
  locale: AppLocale,
) {
  const args = fields(raw, ["surface", "revision", "gameplay", "authorTarget"]);
  assertRevision(args.revision, target.revision);
  const surface =
    editorSurface(args.surface) === "playPrompts" ? "play" : "author";
  if (
    args.authorTarget !== undefined &&
    args.authorTarget !== "setting" &&
    args.authorTarget !== "world-revision"
  )
    throw new Error("Invalid author preview target");
  if (surface === "play" && args.authorTarget !== undefined)
    throw new Error("Author target is only available for author prompts");
  const gameplay = parseGameplay(
    args.gameplay === undefined || args.gameplay === "interactive-fiction"
      ? { mode: "interactive-fiction" }
      : { mode: "tabletop", scheme: args.gameplay },
  );
  const compile = (files: Record<string, string>, revision: string) =>
    compileOrchestrationPreview({
      binding: promptBinding(target, files, revision),
      surface,
      gameplay,
      locale,
      ...(args.authorTarget === undefined
        ? {}
        : { authorTarget: args.authorTarget as "setting" | "world-revision" }),
      connection: {
        provider: binding.provider,
        ...(modelPrompt === undefined ? {} : { modelPrompt }),
      },
    });
  const selected = compile(target.files, target.revision);
  const comparison = compareOrchestrationPreviews(
    compile(target.currentFiles, target.currentRevision),
    selected,
  );
  // Full bodies can be read by stable identity. Keep the generated future-play
  // reference here because it is itself a compiler output, not a stored block.
  const project = ({
    markdown,
    ...entry
  }: (typeof selected.entries)[number]) => ({
    ...entry,
    ...(entry.builtin === "author.play-reference" && markdown !== undefined
      ? { markdown: slice(markdown, { limit: 16384 }).text }
      : { bodyLength: markdown?.length }),
  });
  return {
    ...selected,
    entries: selected.entries.map(project),
    comparison: {
      ...comparison,
      changes: comparison.changes.map(({ identity, before, after }) => ({
        identity,
        before: before === undefined ? null : project(before),
        after: after === undefined ? null : project(after),
      })),
    },
  };
}

function promptBinding(
  target: OrchestrationDraftTarget,
  files: Record<string, string>,
  revision: string,
): PlayPresetBinding {
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind === "invalid") throw parsed.error;
  return {
    id: target.id,
    name: target.name,
    files,
    revision,
    definition: parsed.definition,
    scriptsEnabled: false,
  };
}

function reference(raw: unknown, locale: AppLocale) {
  const args = fields(raw, [
    "topic",
    "surface",
    "builtinId",
    "offset",
    "limit",
  ]);
  let body: string;
  switch (args.topic) {
    case "builtin": {
      const catalog = promptCatalog(editorSurface(args.surface), locale);
      const entry = catalog.find(({ id }) => id === args.builtinId);
      if (!entry) throw new Error("Unknown builtin reference");
      body = entry.body;
      break;
    }
    case "sillytavern-macros":
      body = locale === "zh-CN" ? macroReference.zh : macroReference.en;
      break;
    case "runtime-guide":
      body = orchestrationEditorSystem(locale);
      break;
    default:
      throw new Error("Unknown versioned reference topic");
  }
  return { topic: args.topic, ...slice(body, args) };
}

const macroReference = {
  zh: "SillyTavern 宏静态参考（1.19.0）\n\n角色与上下文：user、char、persona、group、charDescription、charPersonality；聊天：lastMessage、lastUserMessage、lastCharMessage、lastMessageId；局部与全局变量：setvar、getvar、addvar、deletevar、setglobalvar、getglobalvar；条件：if、else；格式：space、newline、trim、noop、//；随机：random、pick、roll；时间：date、time、weekday、datetimeformat；模型与扩展：model、systemPrompt、original、hasExtension、outlet。新宏引擎支持嵌套和区块，旧引擎按类别替换。聊天局部变量依赖聊天状态。目录顺序不能证明求值顺序。本工具只供静态阅读，扩展可增补宏。",
  en: "SillyTavern static macro reference (1.19.0)\n\nCharacter and context: user, char, persona, group, charDescription, charPersonality. Chat: lastMessage, lastUserMessage, lastCharMessage, lastMessageId. Local and global variables: setvar, getvar, addvar, deletevar, setglobalvar, getglobalvar. Conditions: if, else. Formatting: space, newline, trim, noop, //. Random: random, pick, roll. Time: date, time, weekday, datetimeformat. Models and extensions: model, systemPrompt, original, hasExtension, outlet. The newer engine supports nesting and blocks. The old engine ran by macro category. Local chat variables depend on chat state. Preset ordering cannot establish evaluation order. Static reference only. Extensions can add macros.",
};

function worldName(locale: AppLocale): string {
  return locale === "zh-CN"
    ? "完整世界提示占位"
    : "Full world prompt placeholder";
}

function slice(body: string, args: Record<string, unknown>) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 8192;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > body.length ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16384
  )
    throw new Error(
      "Invalid body range (maximum 16384 UTF-16 code units per call)",
    );
  const end = Math.min(body.length, offset + limit);
  return {
    text: body.slice(offset, end),
    offset,
    end,
    length: body.length,
    nextOffset: end === body.length ? null : end,
  };
}

function mergeRanges(ranges: EntryRead["ranges"]): EntryRead["ranges"] {
  const merged: EntryRead["ranges"] = [];
  for (const [first, last] of ranges.sort(([a], [b]) => a - b)) {
    const previous = merged.at(-1);
    if (previous && previous[1] >= first)
      previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  return merged;
}

function completelyRead(
  auth: EditorAuthorization,
  surface: OrchestrationSurface,
  entryId: string,
): boolean {
  const entry = auth.reads.find(
    (item) => item.surface === surface && item.entryId === entryId,
  );
  return entry?.ranges[0]?.[0] === 0 && entry.ranges[0][1] === entry.length;
}

function fields(value: unknown, accepted: string[]) {
  const args = record(value);
  if (Object.keys(args).some((key) => !accepted.includes(key)))
    throw new Error("Unexpected orchestration tool argument");
  return args;
}

function success(call: ModelHostToolCall, value: unknown): ToolResult {
  return { kind: "tool", toolCallId: call.id, markdown: JSON.stringify(value) };
}

export function failure(call: ModelHostToolCall, message: string): ToolResult {
  return {
    kind: "tool",
    toolCallId: call.id,
    markdown: JSON.stringify({ error: message }),
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Orchestration tool rejected the request";
}
