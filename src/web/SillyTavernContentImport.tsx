import { useState } from "react";
import type {
  ContentInspection,
  ContentSelection,
} from "../protocol/sillyTavernContent.ts";
import type { ContentTreeFile, V1Request } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";

function ruleValue(rules: Record<string, unknown>, ...keys: string[]): unknown {
  const extensions =
    rules.extensions &&
    typeof rules.extensions === "object" &&
    !Array.isArray(rules.extensions)
      ? (rules.extensions as Record<string, unknown>)
      : {};
  const topLevelFirst = [
    "key",
    "keys",
    "keysecondary",
    "secondary_keys",
    "constant",
    "selective",
    "order",
    "insertion_order",
    "characterFilter",
  ];
  if (keys.some((key) => topLevelFirst.includes(key))) {
    for (const key of keys) if (rules[key] !== undefined) return rules[key];
  }
  for (const key of keys)
    if (extensions[key] !== undefined) return extensions[key];
  for (const key of keys) if (rules[key] !== undefined) return rules[key];
  return undefined;
}
function displayRule(value: unknown, label: string): string {
  if (value === undefined || value === null)
    return uiText("未指定或跟随来源全局");
  if (label === "插入角色") {
    if (value === 0 || value === "system") return "System";
    if (value === 1 || value === "user") return "User";
    if (value === 2 || value === "assistant") return "Assistant";
  }
  if (label === "插入位置（来源枚举）") {
    const positions = [
      "角色之前",
      "角色之后",
      "作者注之前",
      "作者注之后",
      "历史深度",
      "示例之前",
      "示例之后",
      "命名出口",
    ];
    if (typeof value === "number" && positions[value])
      return uiText(positions[value]);
    if (value === "before_char") return uiText("角色之前");
    if (value === "after_char") return uiText("角色之后");
  }
  if (label === "激活概率" && typeof value === "number") return `${value}%`;
  if (typeof value === "boolean") return value ? uiText("是") : uiText("否");
  if (Array.isArray(value))
    return value.map((item) => String(item)).join(", ") || "—";
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value);
}
function diagnosticText(code: string): string {
  const labels: Record<string, string> = {
    unbound_macro: "来源包含未绑定的宏，已保留资料并需要完善。",
    disabled_entry: "来源禁用的条目只作为资料保存。",
    missing_opening: "缺少开场白，需要在创建世界前补全。",
    invalid_opening: "开场白无效，需要在创建世界前修复。",
    invalid_world_frame: "世界框架需要补全或修复。",
    missing_current_situation: "缺少当前情境，需要在创建世界前补全。",
    unsupported_field: "此来源字段不支持自动迁移。",
    legacy_field_conflict: "旧版顶层字段与 data 不一致，采用 data。",
    external_worldbook_reference: "外部世界书名称仅作来源引用，未自动追踪。",
    external_worldbook_unavailable: "外部世界书未随卡提供，未自动下载。",
    image_not_migrated: "头像图片未迁移。",
    invalid_json_or_utf8: "JSON 或 UTF-8 无效。",
    invalid_png: "PNG 文件无效或损坏。",
    invalid_png_image: "PNG 图像数据无效或损坏。",
    invalid_png_crc: "PNG 校验失败。",
    invalid_png_dimensions: "PNG 尺寸超过安全限制或无效。",
    missing_card_metadata: "图片不含角色卡元数据。",
    invalid_base64: "角色卡元数据编码无效。",
    unknown_version: "角色卡版本不受支持。",
    unsupported_format: "文件不是受支持的角色卡或世界书。",
    source_too_large: "源文件超过大小限制。",
    ambiguous_json: "JSON 包含重复或歧义字段。",
    invalid_selection: "导入选择无效，请重新选择。",
    missing_character_name: "角色卡缺少名称。",
    invalid_rule_type: "来源规则的字段类型无效。",
  };
  return labels[code] ? uiText(labels[code]) : code;
}
function errorText(message: string): string {
  const code = /(?:^|: )([a-z][a-z_]+)(?:$|\s)/u.exec(message)?.[1];
  return code ? `${diagnosticText(code)} (${message})` : message;
}
export function SillyTavernContentImport({
  client,
  onImported,
}: {
  client: { request<T = unknown>(request: V1Request): Promise<T> };
  onImported: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [source, setSource] = useState("");
  const [name, setName] = useState("SillyTavern");
  const [view, setView] = useState<ContentInspection>();
  const [selection, setSelection] = useState<ContentSelection>({ entries: {} });
  const [preview, setPreview] = useState<{
    files: ContentTreeFile[];
    diagnostics: { code: string; path: string }[];
    inspection: {
      status: "usable" | "needs_repair";
      issues: { code: string; path: string; message: string }[];
    };
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function close() {
    setSource("");
    setView(undefined);
    setPreview(undefined);
    setSelection({ entries: {} });
    setError("");
  }
  function choose(patch: Partial<ContentSelection>) {
    setSelection((current) => ({ ...current, ...patch }));
    setPreview(undefined);
  }
  return (
    <section className="home-import-disclosure">
      <label>
        {uiText("导入 SillyTavern 角色卡或世界书")}
        <input
          type="file"
          accept=".json,.png,application/json,image/png"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            close();
            void run(async () => {
              if (file.size > 8 * 1024 * 1024)
                throw new Error("source_too_large");
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = "";
              for (const byte of bytes) binary += String.fromCharCode(byte);
              const encoded = btoa(binary);
              setSource(encoded);
              setName(
                file.name.replace(/\.(json|png)$/iu, "") || "SillyTavern",
              );
              setView(
                await client.request<ContentInspection>({
                  type: "content.sillytavern.inspect",
                  source: encoded,
                }),
              );
            });
          }}
        />
      </label>
      {(source || error) && (
        <div
          role="dialog"
          aria-label={uiText("SillyTavern 内容导入向导")}
          className="sillytavern-content-import"
        >
          <h2>{uiText("SillyTavern 内容导入向导")}</h2>
          <p>
            {uiText(
              "选择目标用途。来源规则不会作为 SillyTavern 触发机制执行；未绑定的宏需要手动完善。",
            )}
          </p>
          {error && <p role="alert">{errorText(error)}</p>}
          {view && (
            <>
              <fieldset disabled={busy}>
                <label>
                  {uiText("内容包标题")}{" "}
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setPreview(undefined);
                    }}
                  />
                </label>
                <p>
                  {view.kind === "character"
                    ? uiText("角色卡")
                    : uiText("世界书")}{" "}
                  · {view.version}
                </p>
                {view.kind === "character" && (
                  <div>
                    {(
                      [
                        ["name", "来源名称"],
                        ["description", "角色描述"],
                        ["personality", "角色性格"],
                        ["scenario", "初始情境候选"],
                        ["first_mes", "默认开场"],
                        ["mes_example", "虚构对话示例"],
                        ["system_prompt", "角色专属提示"],
                        ["post_history_instructions", "历史后指令（仅资料）"],
                        ["creator_notes", "作者说明（仅资料）"],
                        ["creator", "作者"],
                        ["character_version", "角色版本"],
                        ["tags", "标签"],
                      ] as const
                    ).map(
                      ([key, label]) =>
                        view.fields[key] !== undefined && (
                          <section key={key}>
                            <h4>{uiText(label)}</h4>
                            <pre>
                              {typeof view.fields[key] === "string"
                                ? view.fields[key]
                                : JSON.stringify(view.fields[key], null, 2)}
                            </pre>
                          </section>
                        ),
                    )}
                    {Array.isArray(view.fields.alternate_greetings) &&
                      (view.fields.alternate_greetings as unknown[]).map(
                        (greeting, index) => (
                          <section key={index}>
                            <h4>
                              {uiText("替代开场")} {index + 1}
                            </h4>
                            <pre>
                              {typeof greeting === "string" ? greeting : ""}
                            </pre>
                          </section>
                        ),
                      )}
                  </div>
                )}
                {Object.keys(view.legacyFields).length > 0 && (
                  <details open>
                    <summary>{uiText("旧版顶层字段")}</summary>
                    <pre>{JSON.stringify(view.legacyFields, null, 2)}</pre>
                  </details>
                )}
                <details>
                  <summary>{uiText("完整来源字段")}</summary>
                  <pre>{JSON.stringify(view.fields, null, 2)}</pre>
                </details>
                {view.kind === "character" && (
                  <fieldset>
                    <legend>{uiText("角色卡目标用途")}</legend>
                    {(
                      [
                        ["character", "角色文档"],
                        ["scenario", "当前情境"],
                        ["example", "虚构对话控制参考"],
                        ["systemPrompt", "世界控制提示"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={selection[key] === true}
                          onChange={(e) => choose({ [key]: e.target.checked })}
                        />
                        {uiText(label)}
                      </label>
                    ))}
                    <label>
                      {uiText("选择一个开场白")}{" "}
                      <select
                        value={selection.opening ?? ""}
                        onChange={(e) =>
                          choose({ opening: e.target.value || undefined })
                        }
                      >
                        <option value="">{uiText("不选择")}</option>
                        {[
                          view.fields.first_mes,
                          ...(Array.isArray(view.fields.alternate_greetings)
                            ? (view.fields.alternate_greetings as unknown[])
                            : []),
                        ].map((greeting, index) =>
                          typeof greeting === "string" && greeting ? (
                            <option key={index} value={String(index)}>
                              {index === 0
                                ? uiText("默认开场")
                                : `${uiText("替代开场")} ${index}`}
                            </option>
                          ) : null,
                        )}
                      </select>
                    </label>
                  </fieldset>
                )}
                {view.kind === "character" && (
                  <fieldset>
                    <legend>{uiText("仅保存来源资料")}</legend>
                    {[
                      "creator_notes",
                      "creator",
                      "character_version",
                      "tags",
                      "post_history_instructions",
                      "depth_prompt",
                    ].map((key) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={
                            selection.attachments?.includes(key) === true
                          }
                          onChange={(event) => {
                            const previous = selection.attachments ?? [];
                            choose({
                              attachments: event.target.checked
                                ? [...previous, key]
                                : previous.filter((item) => item !== key),
                            });
                          }}
                        />
                        {key}
                      </label>
                    ))}
                  </fieldset>
                )}
                <h3>{uiText("世界书条目")}</h3>
                <p>
                  {uiText(
                    "编辑顺序、优先级和插入位置是不同的来源规则；实际注入还取决于聊天与全局设置。",
                  )}
                </p>
                {view.entries.map((entry) => (
                  <article key={entry.id}>
                    <h4>{entry.name}</h4>
                    <p>
                      {entry.path} ·{" "}
                      {entry.enabled ? uiText("来源启用") : uiText("来源禁用")}
                    </p>
                    <pre>{entry.content}</pre>
                    <dl>
                      {(
                        [
                          ["关键词", ruleValue(entry.rules, "key", "keys")],
                          [
                            "次关键词",
                            ruleValue(
                              entry.rules,
                              "keysecondary",
                              "secondary_keys",
                            ),
                          ],
                          ["启用次关键词", ruleValue(entry.rules, "selective")],
                          [
                            "次关键词逻辑（0 任一，1 非全部，2 全不，3 全部）",
                            ruleValue(entry.rules, "selectiveLogic"),
                          ],
                          [
                            "常驻（仍受其他过滤限制）",
                            ruleValue(entry.rules, "constant"),
                          ],
                          [
                            "编辑顺序",
                            ruleValue(
                              entry.rules,
                              "displayIndex",
                              "display_index",
                            ),
                          ],
                          [
                            "激活优先级",
                            ruleValue(entry.rules, "order", "insertion_order"),
                          ],
                          [
                            "插入位置（来源枚举）",
                            ruleValue(entry.rules, "position"),
                          ],
                          ["历史深度", ruleValue(entry.rules, "depth")],
                          ["插入角色", ruleValue(entry.rules, "role")],
                          ["激活概率", ruleValue(entry.rules, "probability")],
                          [
                            "启用概率",
                            ruleValue(entry.rules, "useProbability"),
                          ],
                          ["分组", ruleValue(entry.rules, "group")],
                          [
                            "分组权重",
                            ruleValue(
                              entry.rules,
                              "groupWeight",
                              "group_weight",
                            ),
                          ],
                          [
                            "排除递归",
                            ruleValue(
                              entry.rules,
                              "excludeRecursion",
                              "exclude_recursion",
                            ),
                          ],
                          [
                            "阻止递归",
                            ruleValue(
                              entry.rules,
                              "preventRecursion",
                              "prevent_recursion",
                            ),
                          ],
                          [
                            "延迟至递归",
                            ruleValue(
                              entry.rules,
                              "delayUntilRecursion",
                              "delay_until_recursion",
                            ),
                          ],
                          ["持续轮数", ruleValue(entry.rules, "sticky")],
                          ["冷却轮数", ruleValue(entry.rules, "cooldown")],
                          ["延迟轮数", ruleValue(entry.rules, "delay")],
                          [
                            "角色过滤",
                            ruleValue(entry.rules, "characterFilter"),
                          ],
                          ["生成类型限制", ruleValue(entry.rules, "triggers")],
                          [
                            "扫描深度",
                            ruleValue(entry.rules, "scanDepth", "scan_depth"),
                          ],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label}>
                          <dt>{uiText(label)}</dt>
                          <dd>{displayRule(value, label)}</dd>
                        </div>
                      ))}
                    </dl>
                    <details>
                      <summary>{uiText("来源规则")}</summary>
                      <pre>{JSON.stringify(entry.rules, null, 2)}</pre>
                    </details>
                    <label>
                      {uiText("目标用途")}{" "}
                      <select
                        value={selection.entries[entry.id] ?? ""}
                        onChange={(e) => {
                          const entries = { ...selection.entries };
                          if (e.target.value)
                            entries[entry.id] = e.target.value as
                              "world" | "attachment";
                          else delete entries[entry.id];
                          choose({ entries });
                        }}
                      >
                        <option value="">{uiText("不选择")}</option>
                        <option value="attachment">
                          {uiText("仅迁移附件")}
                        </option>
                        <option value="world" disabled={!entry.enabled}>
                          {uiText("纳入世界资料")}
                        </option>
                      </select>
                    </label>
                  </article>
                ))}
              </fieldset>
              <button
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(async () =>
                    setPreview(
                      await client.request({
                        type: "content.sillytavern.preview",
                        source,
                        name,
                        selection,
                      }),
                    ),
                  )
                }
              >
                {uiText("预览目标文件")}
              </button>
              {preview && (
                <>
                  <h3>{uiText("目标文件与兼容报告")}</h3>
                  <ul>
                    {preview.files.map((file) => (
                      <li key={file.path}>
                        <details>
                          <summary>{file.path}</summary>
                          <pre>{file.contents}</pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                  <p role="status">
                    {preview.inspection.status === "usable"
                      ? uiText("可创建世界")
                      : uiText("需要完善；仍可导入并编辑")}
                  </p>
                  <ul>
                    {[...preview.diagnostics, ...preview.inspection.issues].map(
                      (item, index) => (
                        <li key={`${item.path}:${item.code}:${index}`}>
                          {diagnosticText(item.code)} <code>{item.path}</code>
                        </li>
                      ),
                    )}
                  </ul>
                  <details>
                    <summary>{uiText("原始诊断详情")}</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          diagnostics: preview.diagnostics,
                          issues: preview.inspection.issues,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await client.request<{
                          localId: string;
                        }>({
                          type: "content.sillytavern.import",
                          source,
                          name,
                          selection,
                        });
                        close();
                        await onImported(result.localId);
                      })
                    }
                  >
                    {uiText("创建独立内容包")}
                  </button>
                </>
              )}
            </>
          )}
          <button disabled={busy} onClick={close}>
            {uiText("取消")}
          </button>
        </div>
      )}
    </section>
  );
}
