import { useEffect, useRef, useState } from "react";
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
function sourceText(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(value ?? "", null, 2);
}
function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    description: "角色描述",
    scenario: "初始情境候选",
    mes_example: "虚构对话示例",
    system_prompt: "角色专属提示",
    creator_notes: "作者说明（仅资料）",
    creator: "作者",
    character_version: "角色版本",
    tags: "标签",
    post_history_instructions: "历史后指令（仅资料）",
    depth_prompt: "深度提示（仅资料）",
    name: "来源名称",
    personality: "角色性格",
  };
  return uiText(labels[key] ?? key);
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
  const [active, setActive] = useState<string>();
  const [showResult, setShowResult] = useState(false);
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
  const dialog = useRef<HTMLDivElement>(null);
  const isOpen = Boolean(source || error);
  useEffect(() => {
    if (isOpen) dialog.current?.focus();
  }, [isOpen]);
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
    setActive(undefined);
    setShowResult(false);
    setSource("");
    setView(undefined);
    setPreview(undefined);
    setSelection({ entries: {} });
    setError("");
  }
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setActive(undefined);
        setShowResult(false);
        setSource("");
        setView(undefined);
        setPreview(undefined);
        setSelection({ entries: {} });
        setError("");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, busy]);
  function choose(patch: Partial<ContentSelection>) {
    setSelection((current) => ({ ...current, ...patch }));
    setPreview(undefined);
    setShowResult(false);
  }
  const openings: unknown[] = view
    ? [
        view.fields.first_mes,
        ...(Array.isArray(view.fields.alternate_greetings)
          ? (view.fields.alternate_greetings as unknown[])
          : []),
      ]
    : [];
  const fieldValue = (key: string): unknown =>
    key === "depth_prompt" &&
    view?.fields.extensions &&
    typeof view.fields.extensions === "object"
      ? (view.fields.extensions as Record<string, unknown>).depth_prompt
      : view?.fields[key];
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
              const inspected = await client.request<ContentInspection>({
                type: "content.sillytavern.inspect",
                source: encoded,
              });
              setView(inspected);
              setActive(
                inspected.kind === "character"
                  ? `field:${["description", "scenario", "mes_example", "system_prompt", "name", "personality"].find((key) => inspected.fields[key] !== undefined) ?? "name"}`
                  : inspected.entries[0]
                    ? `entry:${inspected.entries[0].id}`
                    : "fields",
              );
            });
          }}
        />
      </label>
      {(source || error) && (
        <div
          ref={dialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
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
                      setShowResult(false);
                    }}
                  />
                </label>
                <p>
                  {view.kind === "character"
                    ? uiText("角色卡")
                    : uiText("世界书")}{" "}
                  · {view.version}
                </p>
                {!showResult && (
                  <div className="import-browser">
                    <nav
                      className="import-browser-list"
                      aria-label={uiText("来源目录")}
                    >
                      {view.kind === "character" && (
                        <>
                          <h3>{uiText("角色卡目标用途")}</h3>
                          {(
                            [
                              ["character", "角色文档", "description"],
                              ["scenario", "当前情境", "scenario"],
                              ["example", "虚构对话控制参考", "mes_example"],
                              ["systemPrompt", "世界控制提示", "system_prompt"],
                            ] as const
                          ).map(([key, label, field]) => (
                            <div
                              key={key}
                              className={`import-browser-row ${active === `field:${field}` ? "active" : ""}`}
                            >
                              <input
                                type="checkbox"
                                aria-label={uiText(label)}
                                checked={selection[key] === true}
                                onChange={(event) =>
                                  choose({ [key]: event.currentTarget.checked })
                                }
                              />
                              <button
                                type="button"
                                aria-pressed={active === `field:${field}`}
                                onClick={() => setActive(`field:${field}`)}
                              >
                                {uiText(label)}
                              </button>
                            </div>
                          ))}
                          <h3>{uiText("选择一个开场白")}</h3>
                          {openings.map((greeting, index) =>
                            typeof greeting === "string" && greeting ? (
                              <div
                                key={index}
                                className={`import-browser-row ${active === `opening:${index}` ? "active" : ""}`}
                              >
                                <input
                                  type="radio"
                                  name="import-opening"
                                  aria-label={`${uiText("选择一个开场白")} ${index + 1}`}
                                  checked={selection.opening === String(index)}
                                  onClick={() => {
                                    if (selection.opening === String(index))
                                      choose({ opening: undefined });
                                  }}
                                  onChange={() =>
                                    choose({ opening: String(index) })
                                  }
                                />
                                <button
                                  type="button"
                                  aria-pressed={active === `opening:${index}`}
                                  onClick={() => setActive(`opening:${index}`)}
                                >
                                  {index === 0
                                    ? uiText("默认开场")
                                    : `${uiText("替代开场")} ${index}`}
                                </button>
                              </div>
                            ) : null,
                          )}
                          <h3>{uiText("仅保存来源资料")}</h3>
                          {[
                            "creator_notes",
                            "creator",
                            "character_version",
                            "tags",
                            "post_history_instructions",
                            "depth_prompt",
                          ].map((key) => (
                            <div
                              key={key}
                              className={`import-browser-row ${active === `field:${key}` ? "active" : ""}`}
                            >
                              <input
                                type="checkbox"
                                aria-label={key}
                                checked={
                                  selection.attachments?.includes(key) === true
                                }
                                onChange={(event) => {
                                  const previous = selection.attachments ?? [];
                                  choose({
                                    attachments: event.currentTarget.checked
                                      ? [...previous, key]
                                      : previous.filter((item) => item !== key),
                                  });
                                }}
                              />
                              <button
                                type="button"
                                aria-pressed={active === `field:${key}`}
                                onClick={() => setActive(`field:${key}`)}
                              >
                                {fieldLabel(key)}
                              </button>
                            </div>
                          ))}
                          {["name", "personality"].map((key) => (
                            <button
                              type="button"
                              key={key}
                              aria-pressed={active === `field:${key}`}
                              onClick={() => setActive(`field:${key}`)}
                            >
                              {key === "name"
                                ? uiText("来源名称")
                                : uiText("角色性格")}
                            </button>
                          ))}
                        </>
                      )}
                      <h3>{uiText("世界书条目")}</h3>
                      {view.entries.map((entry) => (
                        <div
                          key={entry.id}
                          className={`import-browser-row import-entry-row ${active === `entry:${entry.id}` ? "active" : ""}`}
                        >
                          <button
                            type="button"
                            aria-pressed={active === `entry:${entry.id}`}
                            onClick={() => setActive(`entry:${entry.id}`)}
                          >
                            {entry.name}
                            <small>
                              {entry.enabled
                                ? uiText("来源启用")
                                : uiText("来源禁用")}
                            </small>
                          </button>
                          <select
                            aria-label={`${entry.name} ${uiText("目标用途")}`}
                            value={selection.entries[entry.id] ?? ""}
                            onChange={(event) => {
                              const entries = { ...selection.entries };
                              if (event.currentTarget.value)
                                entries[entry.id] = event.currentTarget
                                  .value as "world" | "attachment";
                              else delete entries[entry.id];
                              choose({ entries });
                            }}
                          >
                            <option value="">{uiText("不选择")}</option>
                            <option value="attachment">
                              {uiText("仅迁移附件")}
                            </option>
                            <option value="world">
                              {uiText("纳入世界资料")}
                            </option>
                          </select>
                        </div>
                      ))}
                      <button
                        type="button"
                        aria-pressed={active === "fields"}
                        onClick={() => setActive("fields")}
                      >
                        {uiText("完整来源字段")}
                      </button>
                    </nav>
                    <div className="import-browser-detail">
                      {active?.startsWith("field:") && (
                        <article>
                          <h3>{fieldLabel(active.slice(6))}</h3>
                          <pre>{sourceText(fieldValue(active.slice(6)))}</pre>
                          {active === "field:description" && (
                            <details>
                              <summary>{uiText("角色性格")}</summary>
                              <pre>
                                {typeof view.fields.personality === "string"
                                  ? view.fields.personality
                                  : ""}
                              </pre>
                            </details>
                          )}
                        </article>
                      )}
                      {active?.startsWith("opening:") && (
                        <article>
                          <h3>{uiText("开场白")}</h3>
                          <pre>
                            {sourceText(openings[Number(active.slice(8))])}
                          </pre>
                        </article>
                      )}
                      {active === "fields" && (
                        <>
                          <details open>
                            <summary>{uiText("完整来源字段")}</summary>
                            <pre>{JSON.stringify(view.fields, null, 2)}</pre>
                          </details>
                          <details>
                            <summary>{uiText("旧版顶层字段")}</summary>
                            <pre>
                              {JSON.stringify(view.legacyFields, null, 2)}
                            </pre>
                          </details>
                        </>
                      )}
                      {view.entries
                        .filter((entry) => active === `entry:${entry.id}`)
                        .map((entry) => (
                          <article key={entry.id}>
                            <h3>{entry.name}</h3>
                            <pre>{entry.content}</pre>
                            <p>
                              {entry.path} ·{" "}
                              {entry.enabled
                                ? uiText("来源启用")
                                : uiText("来源禁用")}
                            </p>
                            <dl>
                              {(
                                [
                                  [
                                    "关键词",
                                    ruleValue(entry.rules, "key", "keys"),
                                  ],
                                  [
                                    "次关键词",
                                    ruleValue(
                                      entry.rules,
                                      "keysecondary",
                                      "secondary_keys",
                                    ),
                                  ],
                                  [
                                    "启用次关键词",
                                    ruleValue(entry.rules, "selective"),
                                  ],
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
                                    ruleValue(
                                      entry.rules,
                                      "order",
                                      "insertion_order",
                                    ),
                                  ],
                                  [
                                    "插入位置（来源枚举）",
                                    ruleValue(entry.rules, "position"),
                                  ],
                                  ["历史深度", ruleValue(entry.rules, "depth")],
                                  ["插入角色", ruleValue(entry.rules, "role")],
                                  [
                                    "激活概率",
                                    ruleValue(entry.rules, "probability"),
                                  ],
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
                                  [
                                    "持续轮数",
                                    ruleValue(entry.rules, "sticky"),
                                  ],
                                  [
                                    "冷却轮数",
                                    ruleValue(entry.rules, "cooldown"),
                                  ],
                                  ["延迟轮数", ruleValue(entry.rules, "delay")],
                                  [
                                    "角色过滤",
                                    ruleValue(entry.rules, "characterFilter"),
                                  ],
                                  [
                                    "生成类型限制",
                                    ruleValue(entry.rules, "triggers"),
                                  ],
                                  [
                                    "扫描深度",
                                    ruleValue(
                                      entry.rules,
                                      "scanDepth",
                                      "scan_depth",
                                    ),
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
                          </article>
                        ))}
                    </div>
                  </div>
                )}
              </fieldset>
              <p>
                {uiText("已选择")}:{" "}
                {Number(selection.character === true) +
                  Number(selection.scenario === true) +
                  Number(selection.example === true) +
                  Number(selection.systemPrompt === true) +
                  Number(selection.opening !== undefined) +
                  (selection.attachments?.length ?? 0) +
                  Object.keys(selection.entries).length}
              </p>
              <button
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(async () => {
                    setPreview(
                      await client.request({
                        type: "content.sillytavern.preview",
                        source,
                        name,
                        selection,
                      }),
                    );
                    setShowResult(true);
                  })
                }
              >
                {uiText("预览目标文件")}
              </button>
              {showResult && preview && (
                <div className="import-result">
                  <button type="button" onClick={() => setShowResult(false)}>
                    {uiText("返回来源")}
                  </button>
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
                </div>
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
