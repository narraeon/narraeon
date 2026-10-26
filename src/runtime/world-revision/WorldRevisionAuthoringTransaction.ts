import { isPackageFollowupControlPath } from "../content/PackageFollowups.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../../protocol/appPreferences.ts";
import {
  assertSameGameplay,
  gameplayPath,
  readGameplay,
  type Gameplay,
} from "../../protocol/gameplay.ts";
import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import { inspectContentPackageCurrentTree } from "../content/FileNativeContentTree.ts";
import {
  createHistoryQuery,
  historyToolNames,
  isHistoryToolName,
  runHistoryTool,
  type HistoryEntry,
} from "../history/HistoryTools.ts";
import type { HistoryQuery } from "../history/HistoryQuery.ts";
import type { ModelHostToolCall } from "../model/ModelHost.ts";
import type {
  PromptCompilation,
  PromptPreview,
} from "../prompt/FileNativePromptCompiler.ts";
import { runtimeToolsForNames } from "../prompt/FileNativeToolRegistry.ts";
import {
  authoringToolDefinitions,
  SettingAuthoringTransaction,
  worldRevisionAuthoringSurface,
  type SettingAuthoringAuthorization,
  type SettingAuthoringReview,
  type SettingAuthoringToolResult,
} from "../setting/SettingAuthoringTransaction.ts";
import { WorldDocumentStore } from "../world/WorldDocumentStore.ts";

export interface WorldRevisionInspection {
  status: "usable" | "needs_repair";
  diagnostics: { code: string; path: string; message: string }[];
}

/**
 * The authoring transaction over a playing world's state/control worktree.
 * Its namespace, tool names and wording come from the world-revision surface,
 * so nothing it returns is rewritten after the transaction renders it.
 */
export class WorldRevisionAuthoringTransaction {
  readonly #inner: SettingAuthoringTransaction;
  readonly #history: HistoryQuery;
  readonly #locale: AppLocale;

  constructor(input: {
    baseFiles: readonly ContentTreeFile[];
    immutableBaseFiles: readonly ContentTreeFile[];
    /** Committed history of the epoch's fixed base; read-only to revision. */
    history: { scope: string; entries: readonly HistoryEntry[] };
    locale?: AppLocale;
    revision?: string;
    authorization?: SettingAuthoringAuthorization | null;
    preview: (snapshot: WorldDocumentStore) => PromptPreview;
  }) {
    this.#locale = input.locale ?? defaultAppLocale;
    this.#history = createHistoryQuery(
      input.history.scope,
      input.history.entries,
    );
    this.#inner = new SettingAuthoringTransaction({
      baseFiles: input.baseFiles,
      surface: worldRevisionAuthoringSurface,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.authorization === undefined
        ? {}
        : { authorization: input.authorization }),
      validateFiles: (files) =>
        assertUsableWorldRevisionFiles(files, input.immutableBaseFiles),
      preview: (snapshot) =>
        input.preview(
          WorldDocumentStore.open({
            layout: "world_state",
            files: [...snapshot.files].sort((left, right) =>
              left.path.localeCompare(right.path),
            ),
          }),
        ),
    });
  }

  files(): ContentTreeFile[] {
    return this.#inner.files();
  }

  review(): SettingAuthoringReview {
    return this.#inner.review();
  }

  authorization(revision: string): SettingAuthoringAuthorization {
    return this.#inner.authorization(revision);
  }

  /**
   * History calls are read-only: they never reach the worktree, the change
   * history or the read authorizations. Write calls run as one batch so the
   * automatic review still follows the last successful write, and their
   * results return to the positions of their calls.
   */
  execute(calls: readonly ModelHostToolCall[]): SettingAuthoringToolResult[] {
    const settled = this.#inner.execute(
      calls.filter(({ name }) => !isHistoryToolName(name)),
    );
    let next = 0;
    return calls.map((call) => {
      if (!isHistoryToolName(call.name)) return settled[next++]!;
      const result = runHistoryTool(this.#history, call, this.#locale);
      return {
        toolCallId: call.id,
        markdown: result.markdown,
        isError: !result.ok,
        changes: [],
      };
    });
  }
}

export function worldRevisionToolDefinitions(
  locale: AppLocale,
  gameplay: Gameplay,
): PromptCompilation["tools"] {
  return [
    ...authoringToolDefinitions(
      worldRevisionAuthoringSurface,
      locale,
      gameplay,
    ),
    ...runtimeToolsForNames(historyToolNames, locale),
  ];
}

export function worldRevisionRuntimeContract(
  locale: AppLocale,
  gameplay: Gameplay,
): string {
  // A world's mode and scheme are fixed, so only tabletop worlds mention the file.
  const tabletop = gameplay.mode === "tabletop";
  return locale === "zh-CN"
    ? `# Runtime 世界修订对话契约

- 你正在修改一个已经开始游玩的世界，而不是创建世界所用的内容包。修订期间 Runtime 持有持久独占锁，游玩和其他世界写入均被禁止。
- state/* 与 control/* 共同组成唯一的修订工作树；手动编辑和 AI 工具写入落到同一棵树，也进入同一份可回滚改动历史。opening.md 已经作为创世叙事提交，不能读取或修改。
- 工具调用修改的是尚未应用的工作树。只有玩家点击“应用修订”才会把当前整棵树提交为新的世界状态和控制并解除锁；“放弃修订”会丢弃工作树并解除锁。你不得宣称自己已经应用或放弃修订。
- history_list、history_search、history_read 只读导航这个世界已提交的历史原文（开场白如存在也包括在内）。历史是已经发生的证据，用于核对故事中的事实与因果，不能通过修订改写、删除或追加；历史调用不产生改动、不进入回滚历史，也不改变读取授权。修改 state/* 与 control/* 时以当前工作树为准，明确的当前修订优先于旧叙事。
- 每个完整工具响应按调用顺序结算。成功调用留下逐文件 before-image，可以由玩家单独回滚；失败调用不会撤销同一响应内其他成功调用。
- 修改既有文件前必须完整读取。list/search cursor 和 read 授权只属于产生它们的工作树 revision；工作树发生任何手动、AI 或回滚写入后，继续修改前必须重新读取。
- state/* 只接受 .yaml 或 .md 世界文档；control/* 接受 frame.yaml、player-views.yaml、blocks/*.md，以及 followups.yaml 与后置请求引用的 prompts/*.md、renderers/*.html、scripts/*.js、regex/*.yaml、assets/* 文本资源。${tabletop ? "control/gameplay.json 记录世界的玩法模式与判定方案，修订中只能保持不变。" : ""}可以创建新状态文档；既有状态文档不能删除或移动，因为 Authority 保留其稳定身份。
- 对话跨越“应用”或“放弃”继续时，Runtime 会明确宣布一个新修订 epoch。此前读取授权全部失效；先重新读取新世界，再继续修改。`
    : `# Runtime world-revision conversation contract

- You are revising a world that is already in play, not its source content package. Runtime holds a durable exclusive lock during the revision, blocking play and every other world write.
- state/* and control/* form one revision worktree. Manual edits and AI tool writes share that tree and one rollback history. opening.md was already committed as genesis narrative and cannot be read or changed.
- Tools change the unapplied worktree. Only the player can Apply the complete tree to world state/control and unlock it, or Discard the tree and unlock it. Never claim that you applied or discarded the revision yourself.
- history_list, history_search and history_read only navigate the world's committed history originals (the opening included when present). History is evidence of what already happened for checking facts and causality; a revision cannot rewrite, delete or append to it. History calls produce no changes, never enter rollback history and do not alter read authorization. When editing state/* or control/*, the current worktree governs; an explicit current revision takes precedence over old narrative.
- Calls in each complete tool response settle in order. Every successful call retains per-file before-images for selective rollback; a failed sibling does not undo successful calls.
- Completely read an existing file before changing it. List/search cursors and read authorization belong only to the worktree revision that produced them. Re-read after any manual, AI, or rollback write.
- state/* accepts only YAML or Markdown world documents. control/* accepts frame.yaml, player-views.yaml, blocks/*.md, plus followups.yaml and its referenced prompts/*.md, renderers/*.html, scripts/*.js, regex/*.yaml and assets/* text resources. ${tabletop ? "control/gameplay.json records the world's gameplay mode and resolution scheme; a revision must leave both unchanged. " : ""}New state documents are allowed; existing state documents cannot be deleted or moved because Authority retains their stable identity.
- When a conversation continues after Apply or Discard, Runtime announces a new revision epoch and invalidates every prior read authorization. Re-read the new world before editing.`;
}

export function inspectWorldRevisionFiles(
  files: readonly ContentTreeFile[],
  immutableBaseFiles: readonly ContentTreeFile[],
): WorldRevisionInspection {
  const diagnostics: WorldRevisionInspection["diagnostics"] = [];
  diagnostics.push(...gameplayDiagnostics(immutableBaseFiles, files));
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

  const inspection = inspectContentPackageCurrentTree(files, {
    requireOpening: false,
    worldDocumentSnapshot: WorldDocumentStore.open({
      layout: "world_revision",
      files,
    }),
  });
  if (inspection.status !== "usable")
    diagnostics.push(
      ...inspection.issues.map(({ code, path, message }) => ({
        code,
        path,
        message,
      })),
    );
  return {
    status: diagnostics.length === 0 ? "usable" : "needs_repair",
    diagnostics,
  };
}

/** A malformed gameplay file is reported by content inspection, not as a scheme change. */
function gameplayDiagnostics(
  immutableBaseFiles: readonly ContentTreeFile[],
  files: readonly ContentTreeFile[],
): WorldRevisionInspection["diagnostics"] {
  try {
    readGameplay(files);
  } catch {
    return [];
  }
  try {
    assertSameGameplay(immutableBaseFiles, files);
    return [];
  } catch (error: unknown) {
    return [
      {
        code: "gameplay_change_forbidden",
        path: gameplayPath,
        message:
          error instanceof Error
            ? error.message
            : "World gameplay mode and resolution scheme are fixed",
      },
    ];
  }
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

function isWritableWorldRevisionPath(path: string): boolean {
  if (/^state\/.+\.(?:ya?ml|md)$/u.test(path)) return true;
  return (
    path === gameplayPath ||
    isPackageFollowupControlPath(path) ||
    path === "control/frame.yaml" ||
    path === "control/player-views.yaml" ||
    /^control\/blocks\/.+\.md$/u.test(path)
  );
}
