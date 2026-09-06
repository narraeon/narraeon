import { resourceTitle } from "./preset-resource-names.ts";
import { parseDisplayRegex } from "../shared/display-regex.ts";
import { useState } from "react";
import { parseDocument, stringify } from "yaml";
import { getWebLocale } from "./i18n.ts";
import type { FrontendRegexRule } from "./ArtifactExtensionHost.tsx";

export interface DisplayDefinition {
  renderer?: string;
  rendererRevision?: string;
  rendererMode?: "document" | "app";
  regex?: string;
  scripts?: string[];
  assets?: string[];
}
const t = (cn: string, en: string) => (getWebLocale() === "zh-CN" ? cn : en);

/** Edits references and their original resources; unlinking never deletes shared files. */
export function PresetDisplayEditor({
  value,
  files,
  onChange,
  onWrite,
}: {
  value: DisplayDefinition;
  files: Record<string, string>;
  onChange: (value: DisplayDefinition) => void;
  onWrite: (path: string, body: string) => void;
}) {
  const [resourceName, setResourceName] = useState("");
  const [resourceType, setResourceType] = useState("css");
  function detach(
    kind: "renderer" | "regex" | "scripts" | "assets",
    path: string,
  ) {
    const next = { ...value };
    if (kind === "scripts" || kind === "assets")
      next[kind] = (next[kind] ?? []).filter((p) => p !== path);
    else {
      delete next[kind];
      if (kind === "renderer") {
        delete next.rendererRevision;
        next.rendererMode = "document";
      }
    }
    onChange(next);
  }
  function attach(
    kind: "renderer" | "regex" | "scripts" | "assets",
    path: string,
  ) {
    onChange({
      ...value,
      ...(kind === "renderer"
        ? { renderer: path, rendererRevision: crypto.randomUUID() }
        : kind === "regex"
          ? { regex: path }
          : { [kind]: [...new Set([...(value[kind] ?? []), path])] }),
    });
  }
  function create(
    kind: "renderer" | "regex" | "scripts" | "assets",
    suffix: string,
    body: string,
  ) {
    const directory = {
      renderer: "renderers",
      regex: "regex",
      scripts: "scripts",
      assets: "assets",
    }[kind];
    // User labels can contain Unicode; the portable reference codec uses ASCII.
    const name = resourceName.trim()
      ? "named-" +
        Array.from(resourceName.trim().slice(0, 24))
          .map((char) =>
            /[A-Za-z0-9.-]/u.test(char)
              ? char
              : `_u${char.codePointAt(0)!.toString(16)}_`,
          )
          .join("")
      : "resource";
    const path = `${directory}/${name}.${crypto.randomUUID()}.${suffix}`;
    onWrite(path, body);
    attach(kind, path);
  }
  return (
    <section className="preset-display-editor">
      <h3>{t("显示模板", "Display template")}</h3>
      <label>
        {t("显示方式", "Renderer")}
        <select
          aria-label={t("显示方式", "Renderer")}
          value={value.renderer ?? ""}
          onChange={(e) =>
            e.target.value
              ? attach("renderer", e.target.value)
              : value.renderer && detach("renderer", value.renderer)
          }
        >
          <option value="">{t("默认显示", "Default display")}</option>
          {Object.keys(files)
            .filter((p) => p.startsWith("renderers/") && p.endsWith(".html"))
            .map((p, i) => (
              <option key={p} value={p}>
                {t("模板", "Template")} {i + 1} · {resourceTitle(p)}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() =>
          create(
            "renderer",
            "html",
            '<main class="content"><!-- narraeon:content --></main>',
          )
        }
      >
        {t("新建 HTML 模板", "Create HTML template")}
      </button>
      {value.renderer && (
        <label>
          HTML
          <textarea
            aria-label="HTML"
            rows={8}
            value={files[value.renderer] ?? ""}
            onChange={(e) => onWrite(value.renderer!, e.target.value)}
          />
        </label>
      )}
      <label>
        {t("运行方式", "Rendering mode")}
        <select
          aria-label={t("运行方式", "Rendering mode")}
          value={value.rendererMode ?? "document"}
          onChange={(e) =>
            onChange({
              ...value,
              rendererMode: e.target.value as "document" | "app",
            })
          }
        >
          <option value="document">{t("静态文档", "Static document")}</option>
          <option value="app">
            {t(
              "交互界面（需本地脚本许可）",
              "Interactive app (local script permission required)",
            )}
          </option>
        </select>
      </label>
      <p>
        {t(
          "模板用 <!-- narraeon:content --> 放置显示后内容；命名资源按声明引用提供给宿主。解绑保留原资源及其他引用。",
          "Place displayed content with <!-- narraeon:content -->. The host resolves declared resource references. Unlinking retains resources and other references.",
        )}
      </p>
      <h3>
        {t(
          "样式、JavaScript 与命名资源",
          "Styles, JavaScript and named resources",
        )}
      </h3>
      {(["scripts", "assets"] as const).map((kind) => (
        <section key={kind}>
          {(value[kind] ?? []).map((path) => (
            <details key={path}>
              <summary>{resourceTitle(path)}</summary>
              {kind === "assets" && (
                <p>
                  <code>{`window.__NARRAEON_ASSETS__[${JSON.stringify(path)}]`}</code>
                </p>
              )}
              <textarea
                aria-label={resourceTitle(path)}
                rows={8}
                value={files[path] ?? ""}
                onChange={(e) => onWrite(path, e.target.value)}
              />
              <button type="button" onClick={() => detach(kind, path)}>
                {t("移除此引用", "Unlink resource")}
              </button>
            </details>
          ))}
          <label>
            {kind === "scripts"
              ? t("引用已有脚本", "Attach existing script")
              : t("引用已有资源", "Attach existing resource")}
            <select
              value=""
              onChange={(e) => e.target.value && attach(kind, e.target.value)}
            >
              <option value="">
                {t("选择已有内容", "Select existing content")}
              </option>
              {Object.keys(files)
                .filter(
                  (p) =>
                    p.startsWith(`${kind}/`) &&
                    !(value[kind] ?? []).includes(p),
                )
                .map((p) => (
                  <option key={p} value={p}>
                    {resourceTitle(p)}
                  </option>
                ))}
            </select>
          </label>
        </section>
      ))}
      <div className="preset-inline">
        <input
          aria-label={t("资源名称", "Resource name")}
          placeholder={t("资源名称", "Resource name")}
          maxLength={24}
          value={resourceName}
          onChange={(e) => setResourceName(e.target.value)}
        />
        <select
          aria-label={t("资源类型", "Resource type")}
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
        >
          <option>css</option>
          <option>html</option>
          <option>js</option>
        </select>
        <button
          type="button"
          onClick={() =>
            create(
              "assets",
              resourceType,
              resourceType === "css" ? "body { font-family: system-ui; }" : "",
            )
          }
        >
          {t("新建命名资源", "Create named resource")}
        </button>
        <button
          type="button"
          onClick={() =>
            create(
              "scripts",
              "js",
              "// Listen for narraeon.extension.v1 render.update messages.\n",
            )
          }
        >
          {t("新建 JavaScript", "Create JavaScript")}
        </button>
      </div>
      <details>
        <summary>
          {t(
            "JavaScript 数据与操作参考",
            "JavaScript data and command reference",
          )}
        </summary>
        <p>
          {t(
            "render.update 的 payload.content 是显示处理后的字符串；JSON 使用 JSON.parse。payload 还包含 contentType、worldId、channel、key、interactionDisabled。请核对 event.source === parent、instanceId 和 nonce；requestId 用于关联 bridge.response 的 ok / error 回执。示例中的 request / fromHost 是源码定义的 helper。",
            "render.update supplies payload.content as a processed string; parse JSON with JSON.parse. payload also carries contentType, worldId, channel, key and interactionDisabled. Check event.source === parent, instanceId and nonce; correlate bridge.response ok / error with requestId. request / fromHost are helpers defined in the example source.",
          )}
        </p>
        <p>
          {t(
            "window.__NARRAEON_ASSETS__ 按声明的资源引用映射源文本；CSS 自动注入，HTML/JS 资源作为文本提供，不会自动执行。",
            "window.__NARRAEON_ASSETS__ maps declared resource references to source text. CSS is injected; HTML/JS assets are text and are not executed automatically.",
          )}
        </p>
        <dl>
          <dt>read_channel</dt>
          <dd>
            {t("读取当前已显示频道产物", "Read displayed channel artifacts")}
          </dd>
          <dt>read_player_view</dt>
          <dd>
            {t(
              "读取宿主提供的已提交玩家视图",
              "Read committed player views supplied by the host",
            )}
          </dd>
          <dt>composer.set_draft</dt>
          <dd>
            {t(
              "仅填写输入草稿；禁交互时拒绝",
              "Fill the input draft only; rejected when interactions are disabled",
            )}
          </dd>
          <dt>panel.close</dt>
          <dd>{t("关闭当前实例", "Close this instance")}</dd>
          <dt>panel.refresh</dt>
          <dd>
            {t(
              "重新挂载当前实例并刷新宿主数据",
              "Remount this instance and refresh host data",
            )}
          </dd>
          <dt>diagnostic</dt>
          <dd>{t("上报本地诊断", "Report a local diagnostic")}</dd>
        </dl>
      </details>
      <h3>{t("正则显示处理", "Regex display processing")}</h3>
      <p>
        {t(
          "只处理显示内容，不改变发给 AI 的提示词。禁用保留原规则。",
          "Changes display only, never prompts sent to AI. Disabled rules are retained.",
        )}
      </p>
      <label>
        {t("规则集", "Rule set")}
        <select
          value={value.regex ?? ""}
          onChange={(e) =>
            e.target.value
              ? attach("regex", e.target.value)
              : value.regex && detach("regex", value.regex)
          }
        >
          <option value="">{t("无显示处理", "No processing")}</option>
          {Object.keys(files)
            .filter((p) => p.startsWith("regex/"))
            .map((p, i) => (
              <option key={p} value={p}>
                {t("规则集", "Rule set")} {i + 1} · {resourceTitle(p)}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => create("regex", "yaml", stringify({ rules: [] }))}
      >
        {t("新建规则集", "Create rule set")}
      </button>
      {value.regex && (
        <RegexEditor
          key={value.regex}
          source={files[value.regex] ?? ""}
          onChange={(body) => onWrite(value.regex!, body)}
        />
      )}
    </section>
  );
}
function RegexEditor({
  source,
  onChange,
}: {
  source: string;
  onChange: (source: string) => void;
}) {
  const [authored, setAuthored] = useState<{
    source: string;
    rules: FrontendRegexRule[];
    wrapped: boolean;
  } | null>(null);
  let rules: FrontendRegexRule[] = [];
  let failure = "";
  let wrapped = true;
  try {
    const doc = parseDocument(source, { uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length)
      throw new Error(
        doc.errors.map((e) => e.message).join("\n") || "Invalid YAML",
      );
    const raw: unknown = doc.toJS({ maxAliasCount: 0 });
    wrapped = !Array.isArray(raw);
    rules = parseDisplayRegex(source);
  } catch (error) {
    failure = String(error);
  }
  const editing = authored?.source === source;
  if (editing && authored) {
    rules = authored.rules;
    wrapped = authored.wrapped;
  }
  function write(next: FrontendRegexRule[]) {
    const body = stringify(wrapped ? { rules: next } : next);
    setAuthored({ source: body, rules: next, wrapped });
    onChange(body);
  }
  function update(index: number, patch: Partial<FrontendRegexRule>) {
    write(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function move(index: number, delta: number) {
    const next = [...rules].sort((a, b) => a.order - b.order);
    if (index + delta < 0 || index + delta >= next.length) return;
    next.splice(index + delta, 0, ...next.splice(index, 1));
    write(next.map((r, i) => ({ ...r, order: i })));
  }
  if (failure && !editing)
    return (
      <>
        <p role="alert">{failure}</p>
        <textarea
          aria-label={t("原始规则（修复）", "Original rules (repair)")}
          value={source}
          onChange={(e) => onChange(e.target.value)}
        />
      </>
    );
  return (
    <>
      <button
        type="button"
        onClick={() =>
          write([
            ...rules,
            {
              order: Math.max(-1, ...rules.map((r) => r.order)) + 1,
              enabled: true,
              scope: "raw_text",
              pattern: "示例",
              flags: "g",
              replace: "",
              maxMatches: 100,
              errorPolicy: "fallback",
            },
          ])
        }
      >
        {t("新增正则规则", "Add regex rule")}
      </button>
      {failure && <p role="alert">{failure}</p>}
      {[...rules]
        .sort((a, b) => a.order - b.order)
        .map((r, position) => {
          const index = rules.indexOf(r);
          return (
            <fieldset key={r.order}>
              <legend>
                {t("规则", "Rule")} {position + 1}
              </legend>
              <label>
                <input
                  type="checkbox"
                  checked={r.enabled !== false}
                  onChange={(e) => update(index, { enabled: e.target.checked })}
                />
                {t("启用规则", "Enable rule")}
              </label>
              <div className="preset-inline">
                <button
                  type="button"
                  disabled={position === 0}
                  onClick={() => move(position, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={position === rules.length - 1}
                  onClick={() => move(position, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => write(rules.filter((_, i) => i !== index))}
                >
                  {t("删除规则", "Delete rule")}
                </button>
              </div>
              <label>
                {t("阶段", "Stage")}
                <select
                  value={r.scope}
                  onChange={(e) =>
                    update(index, {
                      scope: e.target.value as FrontendRegexRule["scope"],
                    })
                  }
                >
                  <option value="raw_text">
                    {t("原始显示文本", "Raw display text")}
                  </option>
                  <option value="markdown_html">
                    {t("Markdown HTML", "Markdown HTML")}
                  </option>
                  <option value="structured_payload">
                    {t("结构化数据的文本值", "Structured text values")}
                  </option>
                </select>
              </label>
              {(["pattern", "replace", "flags"] as const).map((k) => (
                <label key={k}>
                  {
                    {
                      pattern: t("查找", "Find"),
                      replace: t("替换", "Replace"),
                      flags: t("标志", "Flags"),
                    }[k]
                  }
                  <input
                    value={r[k]}
                    onChange={(e) => update(index, { [k]: e.target.value })}
                  />
                </label>
              ))}
              <label>
                {t("最大匹配次数", "Maximum matches")}
                <input
                  type="number"
                  min={1}
                  value={r.maxMatches}
                  onChange={(e) =>
                    update(index, { maxMatches: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                {t("失败行为", "On failure")}
                <select
                  value={r.errorPolicy}
                  onChange={(e) =>
                    update(index, {
                      errorPolicy: e.target
                        .value as FrontendRegexRule["errorPolicy"],
                    })
                  }
                >
                  <option value="fallback">{t("恢复原文", "Fallback")}</option>
                  <option value="skip">{t("跳过规则", "Skip")}</option>
                  <option value="fail">{t("停止处理", "Fail")}</option>
                </select>
              </label>
            </fieldset>
          );
        })}
    </>
  );
}
