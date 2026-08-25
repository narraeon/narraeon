import { parseDocument } from "yaml";

import type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../../protocol/playerViews.ts";
import type {
  WorldDocumentLocator,
  WorldDocumentQueryFailure,
  WorldDocumentReadResult,
  WorldDocumentSelectNodeResult,
  WorldDocumentSelector,
  WorldDocumentStore,
  WorldDocumentValue,
} from "./WorldDocumentStore.ts";

export type {
  PlayerViewDiagnostic,
  RenderedPlayerView,
} from "../../protocol/playerViews.ts";

export interface PlayerViewRenderInput {
  snapshot: WorldDocumentStore;
  control: string;
}

type RenderedItem = RenderedPlayerView["items"][number];

type ItemResolution =
  | { ok: true; item: RenderedItem }
  | {
      ok: false;
      code: PlayerViewDiagnostic["code"];
      itemId?: string;
      message: string;
    };

const maxItemsPerView = 128;
const maxRenderedBytesPerView = 64 * 1024;
const maxRenderedDepth = 16;
const maxDocumentReadBytes = 65_536;

export class PlayerViewRenderer {
  render(input: PlayerViewRenderInput): {
    views: RenderedPlayerView[];
    diagnostics: PlayerViewDiagnostic[];
  } {
    const diagnostics: PlayerViewDiagnostic[] = [];
    const control = parseControlYaml(input.control);
    if (
      !isRecord(control) ||
      control.format !== "narraeon.player-views/v1" ||
      !Array.isArray(control.views)
    ) {
      return {
        views: [],
        diagnostics: [
          { code: "invalid_control", message: "玩家视图控制文件格式无效" },
        ],
      };
    }

    const views: RenderedPlayerView[] = [];
    for (const candidate of control.views) {
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== "string" ||
        typeof candidate.title !== "string" ||
        !Array.isArray(candidate.items)
      ) {
        diagnostics.push({
          code: "invalid_control",
          message: "玩家视图声明无效",
        });
        continue;
      }

      const view: RenderedPlayerView = {
        id: candidate.id,
        title: candidate.title,
        items: [],
      };
      let renderedBytes = 0;
      for (const [index, item] of candidate.items.entries()) {
        if (index >= maxItemsPerView) {
          diagnostics.push({
            code: "capacity_exceeded",
            viewId: view.id,
            message: `界面容量已满：单个视图最多 ${maxItemsPerView} 个项目`,
          });
          break;
        }

        const resolved = resolveItem(item, input.snapshot);
        if (!resolved.ok) {
          diagnostics.push({
            code: resolved.code,
            viewId: view.id,
            ...(resolved.itemId === undefined
              ? {}
              : { itemId: resolved.itemId }),
            message: resolved.message,
          });
          if (resolved.code === "capacity_exceeded") break;
          continue;
        }

        const itemBytes = Buffer.byteLength(
          JSON.stringify(resolved.item),
          "utf8",
        );
        if (renderedBytes + itemBytes > maxRenderedBytesPerView) {
          diagnostics.push({
            code: "capacity_exceeded",
            viewId: view.id,
            itemId: resolved.item.id,
            message: "界面容量已满：已在完整节点边界停止显示",
          });
          break;
        }
        renderedBytes += itemBytes;
        view.items.push(resolved.item);
      }
      views.push(view);
    }
    return { views, diagnostics };
  }
}

function resolveItem(
  item: unknown,
  snapshot: WorldDocumentStore,
): ItemResolution {
  if (
    !isRecord(item) ||
    typeof item.id !== "string" ||
    typeof item.label !== "string" ||
    !isRecord(item.select) ||
    typeof item.select.document !== "string"
  )
    return {
      ok: false,
      code: "invalid_control",
      message: "玩家视图 item 格式无效",
    };

  const itemId = item.id;
  const handle = item.select.document;
  const selector = playerViewDocumentSelector(handle);
  if (
    item.select.locator === undefined ||
    isWholeMarkdownLocator(item.select.locator)
  ) {
    const wholeDocument = resolveWholeDocument(
      snapshot,
      selector,
      handle,
      item.select.locator === undefined ? undefined : "markdown",
    );
    return wholeDocument.ok
      ? {
          ok: true,
          item: {
            id: itemId,
            label: item.label,
            value: wholeDocument.value,
          },
        }
      : { ...wholeDocument, itemId };
  }

  const locator = playerViewLocator(item.select.locator);
  if (locator === null)
    return {
      ok: false,
      code: "invalid_control",
      itemId,
      message: "locator 格式无效",
    };

  const selected = snapshot.query({
    kind: "select_node",
    document: selector,
    locator,
  });
  if (selected.kind === "error")
    return { ...selectionFailure(selected, handle), itemId };
  if (selected.kind !== "select_node")
    return {
      ok: false,
      code: "unresolved_selector",
      itemId,
      message: "精确 selector 当前无法解析",
    };
  return {
    ok: true,
    item: {
      id: itemId,
      label: item.label,
      value: selectedNodeValue(selected),
    },
  };
}

/**
 * Control files address documents by the same handle the model sees. The
 * prompt compiler already resolves `@shortRef`; a view that silently rendered
 * nothing for it was the only place the two disagreed.
 */
function playerViewDocumentSelector(handle: string): WorldDocumentSelector {
  return handle.startsWith("@")
    ? { shortRef: handle.slice(1) }
    : { documentId: handle };
}

function resolveWholeDocument(
  snapshot: WorldDocumentStore,
  selector: WorldDocumentSelector,
  handle: string,
  expectedCodec?: "markdown",
):
  | { ok: true; value: unknown }
  | {
      ok: false;
      code: PlayerViewDiagnostic["code"];
      message: string;
    } {
  const read = snapshot.query({
    kind: "read_document",
    document: selector,
    maxBytes: maxDocumentReadBytes,
  });
  if (read.kind === "error") return selectionFailure(read, handle);
  if (read.kind !== "read_document")
    return {
      ok: false,
      code: "unresolved_selector",
      message: "精确 selector 当前无法解析",
    };
  if (expectedCodec !== undefined && read.codec !== expectedCodec)
    return {
      ok: false,
      code: "unresolved_selector",
      message: "selector codec 与目标文档不匹配",
    };
  if (read.codec === "markdown")
    return readWholeMarkdown(snapshot, selector, handle, read);
  return selectYamlRoot(snapshot, selector, handle);
}

function readWholeMarkdown(
  snapshot: WorldDocumentStore,
  selector: WorldDocumentSelector,
  handle: string,
  firstPage: WorldDocumentReadResult,
):
  | { ok: true; value: string }
  | {
      ok: false;
      code: PlayerViewDiagnostic["code"];
      message: string;
    } {
  let page = firstPage;
  const chunks = [page.body];
  while (!page.page.complete) {
    if (page.page.nextCursor === null)
      return {
        ok: false,
        code: "unresolved_selector",
        message: "精确 selector 当前无法解析",
      };
    const nextPage = snapshot.query({
      kind: "read_document",
      document: selector,
      maxBytes: maxDocumentReadBytes,
      cursor: page.page.nextCursor,
    });
    if (nextPage.kind === "error") return selectionFailure(nextPage, handle);
    if (nextPage.kind !== "read_document" || nextPage.codec !== "markdown")
      return {
        ok: false,
        code: "unresolved_selector",
        message: "精确 selector 当前无法解析",
      };
    chunks.push(nextPage.body);
    page = nextPage;
  }
  return { ok: true, value: chunks.join("").trim() };
}

function selectYamlRoot(
  snapshot: WorldDocumentStore,
  selector: WorldDocumentSelector,
  handle: string,
):
  | { ok: true; value: unknown }
  | {
      ok: false;
      code: PlayerViewDiagnostic["code"];
      message: string;
    } {
  const selected = snapshot.query({
    kind: "select_node",
    document: selector,
    locator: { yaml: [] },
  });
  if (selected.kind === "error") return selectionFailure(selected, handle);
  if (selected.kind !== "select_node" || selected.node.codec !== "yaml")
    return {
      ok: false,
      code: "unresolved_selector",
      message: "精确 selector 当前无法解析",
    };
  return { ok: true, value: selectedNodeValue(selected) };
}

function selectedNodeValue(selected: WorldDocumentSelectNodeResult): unknown {
  return selected.node.codec === "markdown"
    ? selected.node.markdown
    : projectPlayerValue(selected.node.value);
}

function selectionFailure(
  failure: WorldDocumentQueryFailure,
  handle: string,
): {
  ok: false;
  code: PlayerViewDiagnostic["code"];
  message: string;
} {
  const codes = new Set(failure.diagnostics.map(({ code }) => code));
  if (codes.has("capacity_exceeded"))
    return {
      ok: false,
      code: "capacity_exceeded",
      message: "界面容量已满：选中节点超过查询容量",
    };
  if (codes.has("document_not_found"))
    return {
      ok: false,
      code: "unresolved_selector",
      message: `文档不存在：${handle}`,
    };
  if (codes.has("document_reference_invalid"))
    return {
      ok: false,
      code: "unresolved_selector",
      message: "显式文档引用当前无法解析",
    };
  if (codes.has("locator_invalid"))
    return {
      ok: false,
      code: "unresolved_selector",
      message: "selector codec 与目标文档不匹配",
    };
  return {
    ok: false,
    code: "unresolved_selector",
    message: "精确 selector 当前无法解析",
  };
}

function playerViewLocator(value: unknown): WorldDocumentLocator | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (isStringArray(value.yaml)) return { yaml: [...value.yaml] };
  if (isNonEmptyStringArray(value.markdown))
    return { markdown: [...value.markdown] };
  return null;
}

function isWholeMarkdownLocator(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    isStringArray(value.markdown) &&
    value.markdown.length === 0
  );
}

function projectPlayerValue(value: WorldDocumentValue, depth = 0): unknown {
  if (depth > maxRenderedDepth) return "[界面深度已满]";
  if (isWorldDocumentValueArray(value))
    return value.map((entry) => projectPlayerValue(entry, depth + 1));
  if (!isRecord(value)) return value;
  if (isProjectedReference(value))
    return {
      $ref: value.$ref,
      title: value.target.title,
      ref: value.target.shortRef,
    };
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      projectPlayerValue(child, depth + 1),
    ]),
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((part: unknown) => typeof part === "string")
  );
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    value.every((part) => part.length > 0)
  );
}

function isWorldDocumentValueArray(
  value: WorldDocumentValue,
): value is readonly WorldDocumentValue[] {
  return Array.isArray(value);
}

function isProjectedReference(value: Record<string, unknown>): value is {
  $ref: string;
  target: { documentId: string; shortRef: string; title: string };
} {
  return (
    Object.keys(value).length === 2 &&
    typeof value.$ref === "string" &&
    isRecord(value.target) &&
    typeof value.target.documentId === "string" &&
    typeof value.target.shortRef === "string" &&
    typeof value.target.title === "string"
  );
}

function parseControlYaml(source: string): unknown {
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    return undefined;
  return document.toJS({ maxAliasCount: 0 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
