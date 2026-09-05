import type { AppLocale } from "../../protocol/appPreferences.ts";
import type {
  FileNativeWorldDocumentSnapshot,
  PromptCompilation,
} from "./FileNativePromptCompiler.ts";

/** Body scopes and catalog summaries are independent kinds of exposure. */
export function worldMaterialCoverage(coverage: PromptCompilation["coverage"]) {
  const fullInjected = new Set<string>();
  const nodeInjected = new Set<string>();
  const catalogSummary = new Set<string>();
  const injectedSelections = coverage.flatMap((entry) => {
    for (const ref of entry.catalogEntries ?? []) catalogSummary.add(ref);
    const scope = entry.readAuthorization;
    if (scope === undefined) return [];
    (scope.locator === null ? fullInjected : nodeInjected).add(scope.shortRef);
    return [scope];
  });
  return { fullInjected, nodeInjected, catalogSummary, injectedSelections };
}

export function renderFreshContextCoverage(
  snapshot: FileNativeWorldDocumentSnapshot,
  coverage: PromptCompilation["coverage"],
  shortRef: string,
  locale: AppLocale = "en",
): string {
  const exposure = worldMaterialCoverage(coverage);
  const full = exposure.fullInjected.has(shortRef);
  const nodes = exposure.nodeInjected.has(shortRef);
  const summary = exposure.catalogSummary.has(shortRef);
  const zh = locale === "zh-CN";
  const scope = full
    ? zh
      ? "完整正文"
      : "full body"
    : nodes
      ? zh
        ? "指定节点"
        : "selected nodes"
      : summary
        ? zh
          ? "仅目录摘要"
          : "catalog summary only"
        : zh
          ? "不直接注入，需要按需读取"
          : "not directly injected; read on demand";
  const lines = [
    `${zh ? "如果现在新开上下文" : "If a fresh context started now"}: ${scope}${nodes && !full && summary ? (zh ? "，以及目录摘要" : " and catalog summary") : ""}`,
  ];
  if (!full && nodes) {
    const scopes = exposure.injectedSelections.filter(
      (entry) => entry.shortRef === shortRef && entry.locator !== null,
    );
    lines.push(
      `${zh ? "节点范围" : "Node scopes"}: ${scopes.map(({ locator }) => JSON.stringify(locator)).join(", ")}`,
    );
  }
  if (!full && summary) {
    const read = snapshot.query({
      kind: "read_document",
      document: { shortRef },
    });
    if (read.kind === "read_document")
      lines.push(`${zh ? "摘要" : "Summary"}: ${read.document.summary}`);
  }
  if (!full && !nodes && !summary) {
    const references = exposure.injectedSelections.flatMap((selection) => {
      const read = snapshot.query({
        kind: "read_document",
        document: { shortRef: selection.shortRef },
      });
      const locator =
        selection.locator ??
        (read.kind === "read_document" && read.codec === "yaml"
          ? { yaml: [] }
          : null);
      if (locator === null) return [];
      const node = snapshot.query({
        kind: "select_node",
        document: { shortRef: selection.shortRef },
        locator,
      });
      return node.kind === "select_node" &&
        node.references.some(({ target }) => target.shortRef === shortRef)
        ? [`@${selection.shortRef}`]
        : [];
    });
    if (references.length > 0)
      lines.push(
        `${zh ? "已注入材料中的直接引用来自" : "Direct reference in injected material"}: ${[...new Set(references)].join(", ")}`,
      );
    else if (coverage.some(({ status }) => status === "paged_catalog"))
      lines.push(
        zh
          ? "目录仍有后续页，可使用 state_list 继续查找。"
          : "Catalogs have further pages; use state_list to continue discovery.",
      );
  }
  return lines.join("\n");
}
