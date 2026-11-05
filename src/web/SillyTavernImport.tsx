import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { V1Request } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";

import type {
  SillyTavernInspection,
  SillyTavernConversion,
  SillyTavernDiagnosticCode,
  SillyTavernDiagnosticResult,
  SillyTavernSettingCategory,
} from "../shared/sillytavern-preset.ts";

type ExplanationCode =
  | SillyTavernDiagnosticCode
  | SillyTavernDiagnosticResult
  | SillyTavernSettingCategory
  | SillyTavernConversion["target"][number]["kind"];
function explanation(code: ExplanationCode): string {
  const messages: Record<ExplanationCode, string> = {
    missing_builtin: uiText("源文件未携带此内建定义。"),
    marker: uiText("动态材料占位，无静态正文。"),
    unsupported_macro: uiText("包含不支持的宏，保留原文并停用。"),
    depth_injection: uiText("历史深度插入不能等价迁移，保留原文并停用。"),
    trigger: uiText("生成触发条件不能等价迁移，保留原文并停用。"),
    overrides: uiText("角色覆盖行为不能等价迁移，保留原文并停用。"),
    unsupported_fields: uiText("包含不支持的字段，保留原文并停用。"),
    unsupported_field: uiText("不支持的字段"),
    prompt_selection: uiText("提示选择结果"),
    not_selected: uiText("未选择"),
    enabled: uiText("已导入并启用"),
    model: uiText("模型（未迁移）"),
    generation: uiText("生成设置（未迁移）"),
    unplaced: uiText("未编排提示选中后会保留为停用项。"),
    ignored_setting: uiText("设置未迁移"),
    connection: uiText("连接或凭据（未迁移）"),
    sampling: uiText("采样与生成（未迁移）"),
    extension: uiText("扩展（未迁移）"),
    ignored: uiText("已忽略"),
    disabled: uiText("已保留并停用"),
    not_imported: uiText("未导入"),
    user: uiText("导入的用户提示"),
    builtin: uiText("Narraeon 系统提示"),
    world: uiText("Narraeon 世界占位"),
    tail: uiText("尾部提示"),
  };
  return messages[code];
}

function errorMessage(message: string): string {
  const translations: Record<string, string> = {
    st_invalid_json: uiText("JSON 格式无效"),
    st_legacy_prompt_format_is_unsupported: uiText("不支持旧版提示格式"),
    st_unsupported_preset_format: uiText("不支持此预设格式"),
    st_expected_object: uiText("需要对象"),
    st_expected_array: uiText("需要数组"),
    st_expected_string: uiText("需要字符串"),
    st_expected_boolean: uiText("需要布尔值"),
    st_expected_number: uiText("需要数字"),
    st_expected_nonempty_string: uiText("需要非空字符串"),
    st_duplicate_identifier: uiText("提示身份重复"),
    st_expected_string_or_number: uiText("需要字符串或数字"),
    st_expected_string_array: uiText("需要字符串数组"),
    st_expected_prompt_content: uiText("需要提示正文"),
    st_unsupported_role: uiText("不支持此角色"),
    st_duplicate_order_identifier: uiText("顺序中身份重复"),
    st_unknown_prompt_reference: uiText("顺序引用了未知提示"),
    st_unknown_order_field: uiText("顺序中包含未知字段"),
    st_unknown_group_field: uiText("顺序组包含未知字段"),
    st_expected_character_identifier: uiText("需要角色组身份"),
    st_duplicate_character_group: uiText("角色组身份重复"),
    st_unknown_group: uiText("未知顺序组"),
    st_choose_a_character_group: uiText("请选择顺序组"),
    st_invalid_selection: uiText("选择无效"),
    "SillyTavern source exceeds the size limit": uiText("源文件超过大小限制"),
  };
  const match = /^(.*): (.+) \[(st_[a-z_]+)\]$/u.exec(message);
  if (match)
    return `${match[1]}: ${translations[match[3]!] ?? match[2]} [${match[3]}]`;
  return translations[message] ?? message;
}

function settingPurpose(path: string): string {
  const purposes: Record<string, string> = {
    temperature: uiText("控制采样随机性"),
    top_p: uiText("控制采样概率范围"),
    openai_max_context: uiText("上下文长度上限"),
    openai_max_tokens: uiText("生成长度上限"),
    frequency_penalty: uiText("降低重复频率"),
    presence_penalty: uiText("调整重复内容倾向"),
  };
  return purposes[path.split(".").at(-1) ?? ""] ?? "";
}

function markerMeaning(id: string): string {
  const labels: Record<string, string> = {
    main: uiText("主提示"),
    nsfw: uiText("成人内容提示"),
    jailbreak: uiText("越狱提示"),
    enhanceDefinitions: uiText("定义增强"),
    charDescription: uiText("角色描述"),
    charPersonality: uiText("角色性格"),
    scenario: uiText("场景"),
    personaDescription: uiText("玩家身份描述"),
    worldInfoBefore: uiText("世界书（之前）"),
    worldInfoAfter: uiText("世界书（之后）"),
    dialogueExamples: uiText("示例对话"),
    chatHistory: uiText("聊天历史"),
  };
  return labels[id] ?? id;
}

export function SillyTavernImport({
  client,
  disabled,
  onImported,
}: {
  client: { request<T = unknown>(request: V1Request): Promise<T> };
  disabled: boolean;
  onImported: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [source, setSource] = useState<string>();
  const [name, setName] = useState("");
  const [inspection, setInspection] = useState<SillyTavernInspection>();
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [preview, setPreview] = useState<SillyTavernConversion>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (source !== undefined && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [source]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? errorMessage(cause.message)
          : uiText("导入失败"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function inspect(input: string, groupId?: string): Promise<void> {
    const result = await client.request<SillyTavernInspection>({
      type: "play.sillytavern.inspect",
      source: input,
      ...(groupId === undefined ? {} : { groupId }),
    });
    setInspection(result);
    setActive(result.prompts[0]?.id);
    setShowSettings(false);
    setShowResult(false);
    setSelected([]);
    setPreview(undefined);
  }
  function cancel(): void {
    setActive(undefined);
    setShowResult(false);
    setSource(undefined);
    setInspection(undefined);
    setPreview(undefined);
    setSelected([]);
    setError("");
  }
  const request = () => ({
    source: source!,
    ...(inspection?.selectedGroupId === undefined
      ? {}
      : { groupId: inspection.selectedGroupId }),
    selected,
    name: name.trim(),
  });
  return (
    <>
      <label className="play-preset-import-control">
        {uiText("导入 SillyTavern 预设")}
        <input
          aria-label={uiText("选择 SillyTavern JSON 文件")}
          type="file"
          accept=".json,application/json"
          disabled={disabled || busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            void run(async () => {
              const text = await file.text();
              setInspection(undefined);
              setPreview(undefined);
              setSelected([]);
              setSource(text);
              setName(file.name.replace(/\.json$/iu, "") || "SillyTavern");
              await inspect(text);
            });
          }}
        />
      </label>
      {source !== undefined &&
        createPortal(
          <dialog
            ref={dialog}
            className="sillytavern-import"
            aria-label={uiText("SillyTavern 导入向导")}
            onCancel={(event) => {
              event.preventDefault();
              if (!busy) cancel();
            }}
          >
            <header className="sillytavern-import-header">
              <h2>{uiText("SillyTavern 导入向导")}</h2>
              <button
                type="button"
                disabled={busy}
                onClick={cancel}
                aria-label={uiText("关闭导入向导")}
              >
                ×
              </button>
            </header>
            <p>
              {uiText(
                "逐项选择要导入的内容；源启用状态与选择独立。动态占位由 Narraeon 自身机制处理，不保证等价。",
              )}
            </p>
            {error && <p role="alert">{error}</p>}
            {inspection && (
              <>
                {inspection.groups.length > 0 && (
                  <label>
                    {uiText("源顺序组")}
                    <select
                      aria-label={uiText("源顺序组")}
                      value={inspection.selectedGroupId ?? ""}
                      disabled={busy}
                      onChange={(event) => {
                        const id = event.currentTarget.value;
                        if (id) void run(() => inspect(source, id));
                      }}
                    >
                      <option value="">{uiText("请选择顺序组")}</option>
                      {inspection.groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  {uiText("新预设名称")}
                  <input
                    disabled={busy}
                    value={name}
                    onChange={(event) => {
                      setName(event.currentTarget.value);
                      setPreview(undefined);
                      setShowResult(false);
                    }}
                  />
                </label>
                {!showResult && (
                  <div className="import-browser">
                    <nav
                      className="import-browser-list"
                      aria-label={uiText("来源目录")}
                    >
                      {[true, false].map((ordered) => (
                        <section key={String(ordered)}>
                          <h3>
                            {ordered ? uiText("源顺序") : uiText("未编排提示")}
                          </h3>
                          {inspection.prompts
                            .filter((prompt) => prompt.ordered === ordered)
                            .map((prompt) => (
                              <div
                                className={`import-browser-row ${!showSettings && active === prompt.id ? "active" : ""}`}
                                key={prompt.id}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={prompt.name}
                                  checked={selected.includes(prompt.id)}
                                  disabled={busy}
                                  onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    setSelected((current) =>
                                      checked
                                        ? [...current, prompt.id]
                                        : current.filter(
                                            (id) => id !== prompt.id,
                                          ),
                                    );
                                    setPreview(undefined);
                                  }}
                                />
                                <button
                                  type="button"
                                  aria-pressed={
                                    !showSettings && active === prompt.id
                                  }
                                  onClick={() => {
                                    setActive(prompt.id);
                                    setShowSettings(false);
                                  }}
                                >
                                  {prompt.name}
                                  <small>
                                    {prompt.marker
                                      ? uiText("动态占位")
                                      : prompt.missing
                                        ? uiText("缺失定义")
                                        : prompt.enabled === false
                                          ? uiText("停用")
                                          : ""}
                                  </small>
                                </button>
                              </div>
                            ))}
                        </section>
                      ))}
                      <button
                        type="button"
                        aria-pressed={showSettings}
                        onClick={() => setShowSettings(true)}
                      >
                        {uiText("未迁移的设置")}
                      </button>
                    </nav>
                    <div className="import-browser-detail">
                      {inspection.prompts
                        .filter(
                          (prompt) => !showSettings && prompt.id === active,
                        )
                        .map((prompt) => (
                          <article
                            key={prompt.id}
                            className="sillytavern-prompt"
                          >
                            <h3>{prompt.name}</h3>
                            {prompt.content !== undefined && (
                              <pre>{prompt.content}</pre>
                            )}
                            <p>
                              {prompt.path} · ID: {prompt.id} ·{" "}
                              {uiText("发送角色")}: {prompt.role ?? "—"} ·{" "}
                              {uiText("源启用状态")}:{" "}
                              {prompt.enabled === undefined
                                ? "—"
                                : prompt.enabled
                                  ? uiText("启用")
                                  : uiText("停用")}
                            </p>
                            <p>
                              {uiText("插入位置")}:{" "}
                              {prompt.injectionPosition === undefined ||
                              prompt.injectionPosition === 0
                                ? uiText("提示顺序")
                                : prompt.injectionPosition === 1
                                  ? uiText("历史深度")
                                  : prompt.injectionPosition}{" "}
                              · {uiText("深度")}: {prompt.injectionDepth ?? "—"}{" "}
                              · {uiText("优先级")}:{" "}
                              {prompt.injectionOrder ?? "—"}
                            </p>
                            <p>
                              {uiText("触发条件")}:{" "}
                              {prompt.triggers?.length
                                ? prompt.triggers.join(", ")
                                : uiText("全部生成类型")}{" "}
                              · {uiText("宏")}:{" "}
                              {prompt.macros.length
                                ? prompt.macros.join(", ")
                                : "—"}{" "}
                              · {uiText("禁止覆盖")}:{" "}
                              {prompt.forbidOverrides === undefined
                                ? "—"
                                : prompt.forbidOverrides
                                  ? uiText("是")
                                  : uiText("否")}
                            </p>
                            <p>
                              {uiText("系统管理提示")}:{" "}
                              {prompt.systemPrompt === undefined
                                ? "—"
                                : prompt.systemPrompt
                                  ? uiText("是")
                                  : uiText("否")}{" "}
                              · {uiText("扩展提示")}:{" "}
                              {prompt.extension === undefined
                                ? "—"
                                : prompt.extension
                                  ? uiText("是")
                                  : uiText("否")}{" "}
                              · {uiText("源 position 字段")}:{" "}
                              {prompt.position ?? "—"}
                            </p>
                            {prompt.unsupportedPaths.length > 0 && (
                              <p>
                                {uiText("不支持的字段路径")}:{" "}
                                {prompt.unsupportedPaths.join(", ")}
                              </p>
                            )}
                            {prompt.marker && (
                              <p>
                                {uiText("动态材料占位，无静态正文。")}{" "}
                                {markerMeaning(prompt.id)}
                              </p>
                            )}
                            {prompt.missing && (
                              <p>
                                {uiText("源文件未携带此内建定义。")}{" "}
                                {markerMeaning(prompt.id)} ·{" "}
                                {uiText("无法迁移动态或缺失的内建内容。")}
                              </p>
                            )}
                            {prompt.reasons.map((reason) => (
                              <p key={reason}>{explanation(reason)}</p>
                            ))}
                          </article>
                        ))}
                      {showSettings && (
                        <div>
                          <h3>{uiText("未迁移的设置")}</h3>
                          <p>
                            {uiText(
                              "模型、端点、采样与扩展设置不会应用；凭据值不会显示或保存。",
                            )}
                          </p>
                          <ul>
                            {inspection.settings.map((setting) => (
                              <li key={setting.path}>
                                {setting.path} — {explanation(setting.category)}
                                {setting.value !== undefined && (
                                  <>
                                    {" "}
                                    — {setting.value}{" "}
                                    {settingPurpose(setting.path)}
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <p>
                  {uiText("已选择")}: {selected.length}
                </p>
                <button
                  type="button"
                  disabled={
                    busy ||
                    !name.trim() ||
                    (inspection.groups.length > 0 &&
                      !inspection.selectedGroupId)
                  }
                  onClick={() =>
                    void run(async () => {
                      setPreview(
                        await client.request<SillyTavernConversion>({
                          type: "play.sillytavern.preview",
                          ...request(),
                        }),
                      );
                      setShowResult(true);
                    })
                  }
                >
                  {uiText("转换预览")}
                </button>
                {showResult && preview && (
                  <section
                    className="import-result"
                    aria-label={uiText("转换预览")}
                  >
                    <button type="button" onClick={() => setShowResult(false)}>
                      {uiText("返回来源")}
                    </button>
                    <h3>{uiText("目标预设")}</h3>
                    <ul>
                      {preview.target.map((item, index) => (
                        <li key={index}>
                          {item.name} — {explanation(item.kind)} —{" "}
                          {item.enabled ? uiText("启用") : uiText("停用")}
                        </li>
                      ))}
                    </ul>
                    <h3>{uiText("兼容报告")}</h3>
                    <ul>
                      {preview.report.map((item, index) => (
                        <li key={index}>
                          {item.code} · {item.path} {item.name} —{" "}
                          {explanation(item.code)} — {explanation(item.result)}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      disabled={busy || disabled}
                      onClick={() =>
                        void run(async () => {
                          const result = await client.request<{
                            preset: { id: string };
                          }>({ type: "play.sillytavern.import", ...request() });
                          cancel();
                          await onImported(result.preset.id);
                        })
                      }
                    >
                      {uiText("导入独立副本")}
                    </button>
                  </section>
                )}
              </>
            )}
            <button type="button" disabled={busy} onClick={cancel}>
              {uiText("取消")}
            </button>
          </dialog>,
          document.body,
        )}
    </>
  );
}
