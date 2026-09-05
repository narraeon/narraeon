import type { AppLocale } from "../../protocol/appPreferences.ts";
import { PlayerViewRenderer } from "./PlayerViewRenderer.ts";
import type { WorldDocumentStore } from "./WorldDocumentStore.ts";

/** An annotation about UI reads, never document content or write permission. */
export function renderPlayerViewBindings(
  snapshot: Pick<WorldDocumentStore, "files" | "query">,
  shortRef?: string,
  locale: AppLocale = "en",
): string {
  const control = snapshot.files.find(
    ({ path }) => path === "control/player-views.yaml",
  )?.contents;
  if (control === undefined) return "";
  const { bindings } = new PlayerViewRenderer().inspect({ snapshot, control });
  const selected = bindings.filter(
    (binding) => shortRef === undefined || binding.shortRef === shortRef,
  );
  if (selected.length === 0) return "";
  const zh = locale === "zh-CN";
  return [
    zh
      ? "## 玩家视图读取绑定（Runtime 标记，非正文）"
      : "## Player-view read bindings (Runtime annotation, outside document bodies)",
    zh
      ? "以下范围直接用于玩家界面；这里只标明读取绑定，不授予读取或写入权限，也不展开引用目标。"
      : "These scopes feed the player interface. This annotation grants no read or write permission and does not expand reference targets.",
    ...selected.map(({ viewTitle, label, shortRef: ref, locator }) => {
      const scope =
        locator === null
          ? zh
            ? "（整份文档）"
            : " (whole document)"
          : "yaml" in locator
            ? `#yaml:${JSON.stringify(locator.yaml)}`
            : `#markdown:${JSON.stringify(locator.markdown)}`;
      return `- ${viewTitle} · ${label} → @${ref}${scope}`;
    }),
  ].join("\n");
}
