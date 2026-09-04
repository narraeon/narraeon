import type { AppLocale } from "../../protocol/appPreferences.ts";
import { defaultAppLocale } from "../../protocol/appPreferences.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { inspectContentPackageCurrentTree } from "../content/FileNativeContentTree.ts";
import type { ModelHostToolCall } from "../model/ModelHost.ts";
import type {
  PromptCompilation,
  PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import {
  SettingAuthoringTransaction,
  settingImprovementToolDefinitions,
  type SettingAuthoringAuthorization,
  type SettingAuthoringDiff,
  type SettingAuthoringReview,
  type SettingAuthoringToolResult,
} from "../setting/SettingAuthoringTransaction.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";

const syntheticOpening = {
  path: "opening.md",
  contents:
    "# Existing world\n\nThe genesis opening is immutable in a world revision.\n",
} satisfies ContentTreeFile;

const settingToRevisionTool = new Map<string, string>([
  ["setting_list", "world_revision_list"],
  ["setting_search", "world_revision_search"],
  ["setting_read", "world_revision_read"],
  ["setting_create", "world_revision_create"],
  ["setting_write_file", "world_revision_write_file"],
  ["setting_patch", "world_revision_patch"],
  ["setting_move", "world_revision_move"],
  ["setting_delete", "world_revision_delete"],
] as const);

const revisionToSettingTool = new Map<string, string>(
  [...settingToRevisionTool].map(([setting, revision]) => [revision, setting]),
);

export interface WorldRevisionInspection {
  status: "usable" | "needs_repair";
  diagnostics: { code: string; path: string; message: string }[];
}

/**
 * Adapter that reuses the content-package authoring mechanics while exposing
 * the current world's state/control worktree as its own logical target.
 */
export class WorldRevisionAuthoringTransaction {
  readonly #inner: SettingAuthoringTransaction;
  readonly #locale: AppLocale;

  constructor(input: {
    baseFiles: readonly ContentTreeFile[];
    immutableBaseFiles: readonly ContentTreeFile[];
    locale?: AppLocale;
    revision?: string;
    authorization?: SettingAuthoringAuthorization | null;
    preview: (snapshot: WorldDocumentStore) => PromptPreview;
  }) {
    this.#locale = input.locale ?? defaultAppLocale;
    this.#inner = new SettingAuthoringTransaction({
      baseFiles: toProjectedFiles(input.baseFiles),
      locale: this.#locale,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.authorization === undefined
        ? {}
        : { authorization: input.authorization }),
      validateFiles: (files) => {
        const candidate = fromProjectedFiles(files);
        assertUsableWorldRevisionFiles(candidate, input.immutableBaseFiles);
      },
      preview: (snapshot) =>
        input.preview(
          WorldDocumentStore.open({
            layout: "world_state",
            files: fromProjectedFiles(snapshot.files),
          }),
        ),
    });
  }

  files(): ContentTreeFile[] {
    return fromProjectedFiles(this.#inner.files());
  }

  review(): SettingAuthoringReview {
    return mapReview(this.#inner.review());
  }

  authorization(revision: string): SettingAuthoringAuthorization {
    return this.#inner.authorization(revision);
  }

  execute(calls: readonly ModelHostToolCall[]): SettingAuthoringToolResult[] {
    const mapped = calls.map(mapToolCall);
    const executed = this.#inner.execute(
      mapped.flatMap((item) => ("call" in item ? [item.call] : [])),
    );
    let executedIndex = 0;
    return mapped.map((item, index) => {
      if ("error" in item)
        return rejectedToolResult(calls[index]!.id, item.error, this.#locale);
      const result = executed[executedIndex++];
      if (result === undefined)
        throw new Error("World-revision authoring returned no tool result");
      return {
        ...result,
        markdown: publicWorldRevisionMarkdown(result.markdown),
        changes: result.changes.map(mapDiff),
      };
    });
  }
}

export function worldRevisionToolDefinitions(
  locale: AppLocale = defaultAppLocale,
): PromptCompilation["tools"] {
  return settingImprovementToolDefinitions(locale).map((definition) => {
    const name = settingToRevisionTool.get(definition.name);
    if (name === undefined)
      throw new Error(`Unsupported setting authoring tool: ${definition.name}`);
    return {
      ...structuredClone(definition),
      name,
      description: publicWorldRevisionMarkdown(definition.description),
      inputSchema: mapSchema(definition.inputSchema),
    };
  });
}

export function worldRevisionRuntimeContract(locale: AppLocale): string {
  return locale === "zh-CN"
    ? `# Runtime 世界修订对话契约

- 你正在修改一个已经开始游玩的世界，而不是创建世界所用的内容包。修订期间 Runtime 持有持久独占锁，游玩和其他世界写入均被禁止。
- state/* 与 control/* 共同组成唯一的修订工作树；手动编辑和 AI 工具写入落到同一棵树，也进入同一份可回滚改动历史。opening.md 已经作为创世叙事提交，不能读取或修改。
- 工具调用修改的是尚未应用的工作树。只有玩家点击“应用修订”才会把当前整棵树提交为新的世界状态和控制并解除锁；“放弃修订”会丢弃工作树并解除锁。你不得宣称自己已经应用或放弃修订。
- 每个完整工具响应按调用顺序结算。成功调用留下逐文件 before-image，可以由玩家单独回滚；失败调用不会撤销同一响应内其他成功调用。
- 修改既有文件前必须完整读取。list/search cursor 和 read 授权只属于产生它们的工作树 revision；工作树发生任何手动、AI 或回滚写入后，继续修改前必须重新读取。
- state/* 只接受 .yaml 或 .md 世界文档；control/* 只接受 frame.yaml、player-views.yaml 和 blocks/*.md。可以创建新状态文档；既有状态文档不能删除或移动，因为 Authority 保留其稳定身份。
- 对话跨越“应用”或“放弃”继续时，Runtime 会明确宣布一个新修订 epoch。此前读取授权全部失效；先重新读取新世界，再继续修改。`
    : `# Runtime world-revision conversation contract

- You are revising a world that is already in play, not its source content package. Runtime holds a durable exclusive lock during the revision, blocking play and every other world write.
- state/* and control/* form one revision worktree. Manual edits and AI tool writes share that tree and one rollback history. opening.md was already committed as genesis narrative and cannot be read or changed.
- Tools change the unapplied worktree. Only the player can Apply the complete tree to world state/control and unlock it, or Discard the tree and unlock it. Never claim that you applied or discarded the revision yourself.
- Calls in each complete tool response settle in order. Every successful call retains per-file before-images for selective rollback; a failed sibling does not undo successful calls.
- Completely read an existing file before changing it. List/search cursors and read authorization belong only to the worktree revision that produced them. Re-read after any manual, AI, or rollback write.
- state/* accepts only YAML or Markdown world documents. control/* accepts only frame.yaml, player-views.yaml, and blocks/*.md. New state documents are allowed; existing state documents cannot be deleted or moved because Authority retains their stable identity.
- When a conversation continues after Apply or Discard, Runtime announces a new revision epoch and invalidates every prior read authorization. Re-read the new world before editing.`;
}

export function inspectWorldRevisionFiles(
  files: readonly ContentTreeFile[],
  immutableBaseFiles: readonly ContentTreeFile[],
): WorldRevisionInspection {
  const diagnostics: WorldRevisionInspection["diagnostics"] = [];
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path))
      diagnostics.push({
        code: "logical_path_duplicate",
        path: file.path,
        message: "World revision contains a duplicate logical path",
      });
    paths.add(file.path);
    if (file.encoding !== undefined)
      diagnostics.push({
        code: "binary_not_supported",
        path: file.path,
        message: "World revision accepts text files only",
      });
    if (!isWritableWorldRevisionPath(file.path))
      diagnostics.push({
        code: "path_not_writable",
        path: file.path,
        message: "Only state/* and supported control/* files are writable",
      });
  }
  for (const base of immutableBaseFiles.filter(({ path }) =>
    path.startsWith("state/"),
  )) {
    if (!paths.has(base.path))
      diagnostics.push({
        code: "existing_state_delete_forbidden",
        path: base.path,
        message: "An existing world-state document cannot be deleted",
      });
  }

  const baseSnapshot = WorldDocumentStore.open({
    layout: "world_state",
    files: immutableBaseFiles.filter(({ path }) => path.startsWith("state/")),
  });
  const candidateSnapshot = WorldDocumentStore.open({
    layout: "world_state",
    files: files.filter(({ path }) => path.startsWith("state/")),
  });
  for (const base of immutableBaseFiles.filter(({ path }) =>
    path.startsWith("state/"),
  )) {
    const before = baseSnapshot.query({
      kind: "read_document",
      document: { logicalPath: base.path },
    });
    const after = candidateSnapshot.query({
      kind: "read_document",
      document: { logicalPath: base.path },
    });
    if (
      before.kind === "read_document" &&
      before.ok &&
      after.kind === "read_document" &&
      after.ok &&
      (before.document.documentId !== after.document.documentId ||
        before.document.shortRef !== after.document.shortRef)
    )
      diagnostics.push({
        code: "existing_state_identity_changed",
        path: base.path,
        message:
          "An existing world-state document must keep its document ID and short reference",
      });
  }

  const projected = files.map((file) => ({
    ...structuredClone(file),
    path: file.path.startsWith("state/")
      ? `world/${file.path.slice("state/".length)}`
      : file.path,
  }));
  const inspection = inspectContentPackageCurrentTree(projected, {
    requireOpening: false,
  });
  if (inspection.status !== "usable")
    diagnostics.push(
      ...inspection.issues.map(({ code, path, message }) => ({
        code,
        path: path.startsWith("world/")
          ? `state/${path.slice("world/".length)}`
          : path,
        message,
      })),
    );
  return {
    status: diagnostics.length === 0 ? "usable" : "needs_repair",
    diagnostics,
  };
}

export function assertUsableWorldRevisionFiles(
  files: readonly ContentTreeFile[],
  immutableBaseFiles: readonly ContentTreeFile[],
): void {
  const inspection = inspectWorldRevisionFiles(files, immutableBaseFiles);
  if (inspection.status !== "usable")
    throw new Error(
      inspection.diagnostics
        .map(({ path, message }) => `${path}: ${message}`)
        .join("; "),
    );
}

function toProjectedFiles(
  files: readonly ContentTreeFile[],
): ContentTreeFile[] {
  return [
    syntheticOpening,
    ...files.map((file) => ({
      ...structuredClone(file),
      path: file.path.startsWith("state/")
        ? `world/${file.path.slice("state/".length)}`
        : file.path,
    })),
  ];
}

function fromProjectedFiles(
  files: readonly ContentTreeFile[],
): ContentTreeFile[] {
  const opening = files.find(({ path }) => path === "opening.md");
  if (
    opening?.contents !== syntheticOpening.contents ||
    opening.encoding !== undefined
  )
    throw new Error("opening.md is immutable in a world revision");
  return files
    .filter(({ path }) => path !== "opening.md")
    .map((file) => ({
      ...structuredClone(file),
      path: file.path.startsWith("world/")
        ? `state/${file.path.slice("world/".length)}`
        : file.path,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function mapToolCall(
  call: ModelHostToolCall,
): { call: ModelHostToolCall } | { error: "opening" | "namespace" } {
  const name = revisionToSettingTool.get(call.name);
  if (name === undefined)
    return {
      call: { ...structuredClone(call), name: `unsupported:${call.name}` },
    };
  const args = isRecord(call.arguments)
    ? structuredClone(call.arguments)
    : call.arguments;
  if (isRecord(args)) {
    for (const field of [
      "path",
      "directory",
      "within",
      "from",
      "to",
      "document",
    ])
      if (typeof args[field] === "string") {
        if (args[field] === "opening.md") return { error: "opening" };
        if (args[field] === "world" || args[field].startsWith("world/"))
          return { error: "namespace" };
        args[field] = toProjectedPath(args[field]);
      }
  }
  return {
    call: { ...structuredClone(call), name, arguments: args },
  };
}

function toProjectedPath(path: string): string {
  if (path === "state") return "world";
  return path.startsWith("state/")
    ? `world/${path.slice("state/".length)}`
    : path;
}

function mapDiff(diff: SettingAuthoringDiff): SettingAuthoringDiff {
  return {
    ...structuredClone(diff),
    path: diff.path.startsWith("world/")
      ? `state/${diff.path.slice("world/".length)}`
      : diff.path,
  };
}

function mapReview(review: SettingAuthoringReview): SettingAuthoringReview {
  return {
    ...structuredClone(review),
    diff: review.diff.filter(({ path }) => path !== "opening.md").map(mapDiff),
    diagnostics: review.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      path: diagnostic.path.startsWith("world/")
        ? `state/${diagnostic.path.slice("world/".length)}`
        : diagnostic.path,
    })),
    playCoverage:
      review.playCoverage === null
        ? null
        : {
            ...structuredClone(review.playCoverage),
            changed: review.playCoverage.changed
              .filter(({ path }) => path !== "opening.md")
              .map((item) => ({ ...item, path: mapPublicPath(item.path) })),
          },
  };
}

function mapPublicPath(path: string): string {
  return path.startsWith("world/")
    ? `state/${path.slice("world/".length)}`
    : path;
}

function publicWorldRevisionMarkdown(markdown: string): string {
  let fenced = false;
  let documentBody = false;
  let opaqueBody = false;
  return markdown
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "[body]") {
        documentBody = true;
        return [line];
      }
      if (line.trim() === "[/body]") {
        documentBody = false;
        return [line];
      }
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return [line];
      }
      if (
        line.startsWith("# Special-file source ") ||
        line.startsWith("# 专用文件原文 ")
      )
        opaqueBody = true;
      else if (opaqueBody && line === "---") opaqueBody = false;
      if (
        fenced ||
        documentBody ||
        (opaqueBody &&
          !line.startsWith("# Special-file source ") &&
          !line.startsWith("# 专用文件原文 ")) ||
        /^\s+"/u.test(line)
      )
        return [line];
      const mapped = line
        .replaceAll("setting_", "world_revision_")
        .replaceAll("content package", "world revision")
        .replaceAll("Content package", "World revision")
        .replaceAll("内容包当前树", "世界修订工作树")
        .replaceAll("内容包", "世界修订")
        .replaceAll("opening and control", "control")
        .replaceAll("opening/control", "control")
        .replaceAll("opening.md, ", "")
        .replaceAll("opening 和 control", "control")
        .replaceAll("opening.md、", "")
        .replaceAll("world/", "state/");
      return /^- \[(?:special|binary)\] opening\.md$/u.test(mapped.trim())
        ? []
        : [mapped];
    })
    .join("\n");
}

function rejectedToolResult(
  toolCallId: string,
  error: "opening" | "namespace",
  locale: AppLocale,
): SettingAuthoringToolResult {
  const message =
    error === "opening"
      ? locale === "zh-CN"
        ? "世界创建后 opening.md 已成为不可变创世叙事。请改写 state/* 或 control/*。"
        : "opening.md is immutable after a world has been created. Edit state/* or control/* instead."
      : locale === "zh-CN"
        ? "世界修订只公开 state/* 与 control/* 逻辑路径；不能使用内容包的 world/* 命名空间。"
        : "World revision exposes only state/* and control/* logical paths; the content-package world/* namespace is unavailable.";
  return {
    toolCallId,
    markdown: `# Runtime tool rejected\n\n${message}`,
    isError: true,
    changes: [],
  };
}

function mapSchema(schema: object): object {
  const map = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll("world", "state");
    if (Array.isArray(value)) return value.map(map);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, map(child)]),
    );
  };
  return map(schema) as object;
}

function isWritableWorldRevisionPath(path: string): boolean {
  if (/^state\/.+\.(?:ya?ml|md)$/u.test(path)) return true;
  return (
    path === "control/frame.yaml" ||
    path === "control/player-views.yaml" ||
    /^control\/blocks\/.+\.md$/u.test(path)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
