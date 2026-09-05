import {
  builtinAuthorPrompts,
  authoringMechanics,
} from "../shared/ordered-author-prompts.ts";
import { useState } from "react";
import {
  builtinPlayPrompts,
  type OrderedPlayPrompt,
} from "../shared/ordered-play-prompts.ts";
import { getWebLocale } from "./i18n.ts";

export function OrderedPlayPromptEditor({
  entries,
  onChange,
  migrationNotice,
  authoring = false,
}: {
  entries: OrderedPlayPrompt[];
  onChange: (entries: OrderedPlayPrompt[]) => void;
  migrationNotice?: string;
  authoring?: boolean;
}) {
  const [selectedId, setSelectedId] = useState(entries[0]?.id);
  const [dragged, setDragged] = useState<string>();
  const locale = getWebLocale();
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const catalog = authoring
    ? builtinAuthorPrompts(locale)
    : builtinPlayPrompts(locale);
  const selected =
    entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const builtin =
    selected?.kind === "builtin"
      ? catalog.find((item) => item.id === selected.builtin)
      : undefined;
  const name = (entry: OrderedPlayPrompt) =>
    entry.kind === "world"
      ? t("Complete world prompt", "完整内容包提示")
      : entry.kind === "user"
        ? entry.name
        : catalog.find((item) => item.id === entry.builtin)!.name;
  const index = entries.findIndex((entry) => entry.id === selected?.id);
  function move(id: string, to: number) {
    const from = entries.findIndex((entry) => entry.id === id);
    if (from < 0 || to < 0 || to >= entries.length || from === to) return;
    const next = [...entries];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    onChange(next);
  }
  function update(entry: OrderedPlayPrompt) {
    onChange(
      entries.map((current) => (current.id === entry.id ? entry : current)),
    );
  }
  function add(body = "", title = t("New prompt", "新提示词")) {
    const entry: OrderedPlayPrompt = {
      id: crypto.randomUUID(),
      kind: "user",
      name: title,
      enabled: true,
      body,
    };
    const next = [...entries];
    next.splice(index + 1, 0, entry);
    onChange(next);
    setSelectedId(entry.id);
  }
  return (
    <section
      aria-label={
        authoring
          ? t("Ordered authoring prompts", "设定完善提示词编排")
          : t("Ordered play prompts", "游玩提示词编排")
      }
    >
      {migrationNotice && <p role="status">{migrationNotice}</p>}
      <div className="ordered-play-editor">
        <aside>
          <button type="button" onClick={() => add()}>
            {t("Add prompt", "新增提示词")}
          </button>
          <ol aria-label={t("Prompt order", "提示词顺序")}>
            {entries.map((entry, position) => (
              <li
                key={entry.id}
                draggable
                onDragStart={() => setDragged(entry.id)}
                onDragEnd={() => setDragged(undefined)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragged) move(dragged, position);
                  setDragged(undefined);
                }}
              >
                <button
                  type="button"
                  aria-pressed={entry.id === selected?.id}
                  onClick={() => setSelectedId(entry.id)}
                  onKeyDown={(event) => {
                    if (
                      event.altKey &&
                      ["ArrowUp", "ArrowDown"].includes(event.key)
                    ) {
                      event.preventDefault();
                      move(
                        entry.id,
                        position + (event.key === "ArrowUp" ? -1 : 1),
                      );
                    }
                  }}
                >
                  {name(entry)}
                </button>
                {entry.kind !== "world" && !entry.enabled && (
                  <small>{t("Disabled", "已停用")}</small>
                )}
              </li>
            ))}
          </ol>
          <p>
            {t(
              "Drag or use Alt + arrow keys to reorder.",
              "拖动或按 Alt + 方向键排序。",
            )}
          </p>
        </aside>
        {selected && (
          <div className="ordered-play-content">
            <div className="ordered-play-actions">
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => move(selected.id, index - 1)}
              >
                {t("Move up", "上移")}
              </button>
              <button
                type="button"
                disabled={index >= entries.length - 1}
                onClick={() => move(selected.id, index + 1)}
              >
                {t("Move down", "下移")}
              </button>
              {selected.kind !== "world" && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.enabled}
                      disabled={builtin?.required}
                      onChange={(event) =>
                        update({ ...selected, enabled: event.target.checked })
                      }
                    />
                    {t("Enabled", "启用")}
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      add(
                        selected.kind === "user"
                          ? selected.body
                          : builtin!.body,
                        `${name(selected)} ${t("copy", "副本")}`,
                      )
                    }
                  >
                    {t("Clone prompt", "克隆提示词")}
                  </button>
                </>
              )}
              {selected.kind === "user" && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(
                      entries.filter((entry) => entry.id !== selected.id),
                    );
                    setSelectedId(undefined);
                  }}
                >
                  {t("Delete prompt", "删除提示词")}
                </button>
              )}
            </div>
            {selected.kind === "world" ? (
              <>
                <h4>{name(selected)}</h4>
                <p>
                  {t(
                    "The current world's frame expands its instructions and selected materials together here, including material coverage and read authorization. This is not the entire file tree. Inspect actual content in a world or content-package Prompt Preview.",
                    "当前世界的 frame 在此连续展开世界指令与选定材料，包括材料覆盖和读取资格；不是注入全部文件。请在具体世界或内容包的真实提示预览中检查正文。",
                  )}
                </p>
              </>
            ) : (
              <>
                <label>
                  {t("Prompt name", "提示词名称")}
                  <input
                    aria-label={t("Prompt name", "提示词名称")}
                    value={name(selected)}
                    readOnly={selected.kind === "builtin"}
                    onChange={(event) => {
                      if (selected.kind === "user")
                        update({ ...selected, name: event.target.value });
                    }}
                  />
                </label>
                {builtin && (
                  <p>
                    {t(
                      "Application builtin: always resolves the latest text. Clone to keep an editable, independent copy.",
                      "系统引用始终使用应用最新版正文；克隆获得可编辑、独立的固定副本。",
                    )}
                  </p>
                )}
                <label>
                  {t("Prompt text", "提示词正文")}
                  <textarea
                    aria-label={t("Prompt text", "提示词正文")}
                    rows={22}
                    readOnly={selected.kind === "builtin"}
                    value={
                      selected.kind === "user" ? selected.body : builtin!.body
                    }
                    onChange={(event) => {
                      if (selected.kind === "user")
                        update({ ...selected, body: event.target.value });
                    }}
                  />
                </label>
              </>
            )}
          </div>
        )}
      </div>
      {authoring && builtin?.id === "author.mechanics" && (
        <details>
          <summary>
            {t("World revision tool contract", "世界修订工具契约")}
          </summary>
          <pre>{authoringMechanics(locale, "world-revision")}</pre>
        </details>
      )}
      <p className="field-note">
        {authoring
          ? t(
              "Save and apply the preset: the next author message uses this arrangement. A running tool loop keeps its saved request. Target identity and future-play reference expand in actual requests; old conversation and epoch transition evidence remain unchanged.",
              "保存并应用预设后，下一条作者消息使用此编排；运行中的工具循环保持已保存请求。创作目标与未来游玩参考在实际请求中展开，旧对话及 epoch 变更证据原样保留。",
            )
          : t(
              "Dynamic input marker: Runtime appends the current round and checkpoint counters immediately before the player's original input. Existing conversation and tool results retain their order. After saving, apply the preset to use these changes in fresh play contexts.",
              "动态输入标记：Runtime 在本次玩家原文之前追加当前回合与检查点计数。已有对话及工具结果保留原序。保存后点击“应用为当前玩法”，改动才用于全新游玩上下文。",
            )}
      </p>
    </section>
  );
}
