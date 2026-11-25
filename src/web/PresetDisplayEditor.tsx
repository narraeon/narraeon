import type { PresetDisplayEdit } from "./preset-resource-editor.ts";
import { resourceTitle } from "./preset-resource-names.ts";
import { parseDisplayRegex } from "../shared/display-regex.ts";
import { useState } from "react";
import { parseDocument, stringify } from "yaml";
import { uiText } from "./i18n.ts";
import type { FrontendRegexRule } from "./ArtifactExtensionHost.tsx";

export interface DisplayDefinition {
  renderer?: string;
  rendererRevision?: string;
  rendererMode?: "document" | "app";
  regex?: string;
  scripts?: string[];
  assets?: string[];
}

/** Edits references and their original resources; unlinking never deletes shared files. */
export function PresetDisplayEditor({
  value,
  files,
  onEdit,
  onWrite,
}: {
  value: DisplayDefinition;
  files: Record<string, string>;
  onEdit: (edit: PresetDisplayEdit) => void;
  onWrite: (path: string, body: string) => void;
}) {
  const [resourceName, setResourceName] = useState("");
  const [resourceType, setResourceType] = useState("css");
  function detach(
    kind: "renderer" | "regex" | "scripts" | "assets",
    path: string,
  ) {
    onEdit({ type: "unbind", kind, path });
  }
  function attach(
    kind: "renderer" | "regex" | "scripts" | "assets",
    path: string,
  ) {
    onEdit({ type: "bind", kind, path });
  }
  function create(
    kind: "renderer" | "regex" | "scripts" | "assets",
    suffix: string,
    body: string,
  ) {
    onEdit({ type: "create", kind, name: resourceName, suffix, body });
  }
  return (
    <section className="preset-display-editor">
      <h3>{uiText("显示模板")}</h3>
      <label>
        {uiText("显示方式")}
        <select
          aria-label={uiText("显示方式")}
          value={value.renderer ?? ""}
          onChange={(e) =>
            e.target.value
              ? attach("renderer", e.target.value)
              : value.renderer && detach("renderer", value.renderer)
          }
        >
          <option value="">{uiText("默认显示")}</option>
          {Object.keys(files)
            .filter((p) => p.startsWith("renderers/") && p.endsWith(".html"))
            .map((p, i) => (
              <option key={p} value={p}>
                {uiText("模板")} {i + 1} · {resourceTitle(p)}
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
        {uiText("新建 HTML 模板")}
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
        {uiText("运行方式")}
        <select
          aria-label={uiText("运行方式")}
          value={value.rendererMode ?? "document"}
          onChange={(e) =>
            onEdit({ type: "mode", mode: e.target.value as "document" | "app" })
          }
        >
          <option value="document">{uiText("静态文档")}</option>
          <option value="app">{uiText("交互界面（需本地脚本许可）")}</option>
        </select>
      </label>
      <p>
        {uiText(
          "模板用 <!-- narraeon:content --> 放置显示后内容；命名资源按声明引用提供给宿主。解绑保留原资源及其他引用。",
        )}
      </p>
      <h3>{uiText("样式、JavaScript 与命名资源")}</h3>
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
                {uiText("移除此引用")}
              </button>
            </details>
          ))}
          <label>
            {kind === "scripts"
              ? uiText("引用已有脚本")
              : uiText("引用已有资源")}
            <select
              value=""
              onChange={(e) => e.target.value && attach(kind, e.target.value)}
            >
              <option value="">{uiText("选择已有内容")}</option>
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
          aria-label={uiText("资源名称")}
          placeholder={uiText("资源名称")}
          maxLength={24}
          value={resourceName}
          onChange={(e) => setResourceName(e.target.value)}
        />
        <select
          aria-label={uiText("资源类型")}
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
          {uiText("新建命名资源")}
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
          {uiText("新建 JavaScript")}
        </button>
      </div>
      <details>
        <summary>{uiText("JavaScript 数据与操作参考")}</summary>
        <p>
          {uiText(
            "render.update 的 payload.content 是显示处理后的字符串；JSON 使用 JSON.parse。payload 还包含 contentType、worldId、channel、key、interactionDisabled。请核对 event.source === parent、instanceId 和 nonce；requestId 用于关联 bridge.response 的 ok / error 回执。示例中的 request / fromHost 是源码定义的 helper。",
          )}
        </p>
        <p>
          {uiText(
            "window.__NARRAEON_ASSETS__ 按声明的资源引用映射源文本；CSS 自动注入，HTML/JS 资源作为文本提供，不会自动执行。",
          )}
        </p>
        <dl>
          <dt>read_channel</dt>
          <dd>{uiText("读取当前已显示频道产物")}</dd>
          <dt>read_player_view</dt>
          <dd>{uiText("读取宿主提供的已提交玩家视图")}</dd>
          <dt>composer.set_draft</dt>
          <dd>{uiText("仅填写输入草稿；禁交互时拒绝")}</dd>
          <dt>panel.close</dt>
          <dd>{uiText("关闭当前实例")}</dd>
          <dt>panel.refresh</dt>
          <dd>{uiText("重新挂载当前实例并刷新宿主数据")}</dd>
          <dt>diagnostic</dt>
          <dd>{uiText("上报本地诊断")}</dd>
        </dl>
      </details>
      <h3>{uiText("正则显示处理")}</h3>
      <p>
        {uiText("只处理显示内容，不改变发给 AI 的提示词。禁用保留原规则。")}
      </p>
      <label>
        {uiText("规则集")}
        <select
          value={value.regex ?? ""}
          onChange={(e) =>
            e.target.value
              ? attach("regex", e.target.value)
              : value.regex && detach("regex", value.regex)
          }
        >
          <option value="">{uiText("无显示处理")}</option>
          {Object.keys(files)
            .filter((p) => p.startsWith("regex/"))
            .map((p, i) => (
              <option key={p} value={p}>
                {uiText("规则集")} {i + 1} · {resourceTitle(p)}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => create("regex", "yaml", stringify({ rules: [] }))}
      >
        {uiText("新建规则集")}
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
          aria-label={uiText("原始规则（修复）")}
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
        {uiText("新增正则规则")}
      </button>
      {failure && <p role="alert">{failure}</p>}
      {[...rules]
        .sort((a, b) => a.order - b.order)
        .map((r, position) => {
          const index = rules.indexOf(r);
          return (
            <fieldset key={r.order}>
              <legend>
                {uiText("orchestration.display.regexRule")} {position + 1}
              </legend>
              <label>
                <input
                  type="checkbox"
                  checked={r.enabled !== false}
                  onChange={(e) => update(index, { enabled: e.target.checked })}
                />
                {uiText("启用规则")}
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
                  {uiText("删除规则")}
                </button>
              </div>
              <label>
                {uiText("阶段")}
                <select
                  value={r.scope}
                  onChange={(e) =>
                    update(index, {
                      scope: e.target.value as FrontendRegexRule["scope"],
                    })
                  }
                >
                  <option value="raw_text">{uiText("原始显示文本")}</option>
                  <option value="markdown_html">
                    {uiText("Markdown HTML")}
                  </option>
                  <option value="structured_payload">
                    {uiText("结构化数据的文本值")}
                  </option>
                </select>
              </label>
              {(["pattern", "replace", "flags"] as const).map((k) => (
                <label key={k}>
                  {
                    {
                      pattern: uiText("查找"),
                      replace: uiText("替换"),
                      flags: uiText("标志"),
                    }[k]
                  }
                  <input
                    value={r[k]}
                    onChange={(e) => update(index, { [k]: e.target.value })}
                  />
                </label>
              ))}
              <label>
                {uiText("最大匹配次数")}
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
                {uiText("失败行为")}
                <select
                  value={r.errorPolicy}
                  onChange={(e) =>
                    update(index, {
                      errorPolicy: e.target
                        .value as FrontendRegexRule["errorPolicy"],
                    })
                  }
                >
                  <option value="fallback">{uiText("恢复原文")}</option>
                  <option value="skip">{uiText("跳过规则")}</option>
                  <option value="fail">{uiText("停止处理")}</option>
                </select>
              </label>
            </fieldset>
          );
        })}
    </>
  );
}
