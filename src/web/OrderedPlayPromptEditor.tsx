import { browserUUID } from "./browser-uuid.ts";
import {
  builtinAuthorPrompts,
  authoringMechanics,
} from "../shared/ordered-author-prompts.ts";
import { useState, type ReactNode } from "react";
import {
  builtinPlayPrompts,
  orderedPromptScope,
  orderedPromptTurnGuide,
  type BuiltinPlayPrompt,
  type OrderedPlayPrompt,
  type PromptCategory,
  type PromptGameplayScope,
  type PromptMessageRole,
  isPromptMessageRole,
} from "../shared/ordered-play-prompts.ts";
import {
  turnGuideHeader,
  turnGuideWarnings,
  type TurnGuideLine,
} from "../shared/turn-guide.ts";
import { getWebLocale } from "./i18n.ts";

export function OrderedPlayPromptEditor({
  entries,
  onChange,
  mergeConsecutiveMessages = true,
  onMergeConsecutiveMessagesChange,
  migrationNotice,
  authoring = false,
  directory,
  promptPreview,
  detail,
  onSelectPrompt,
}: {
  entries: OrderedPlayPrompt[];
  mergeConsecutiveMessages?: boolean;
  onMergeConsecutiveMessagesChange?: (value: boolean) => void;
  onChange: (entries: OrderedPlayPrompt[]) => void;
  migrationNotice?: string;
  authoring?: boolean;
  directory?: ReactNode;
  promptPreview?: ReactNode;
  detail?: ReactNode;
  onSelectPrompt?: () => void;
}) {
  const [selectedId, setSelectedId] = useState(entries[0]?.id);
  const [dragged, setDragged] = useState<string>();
  const locale = getWebLocale();
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const catalog: BuiltinPlayPrompt[] = authoring
    ? builtinAuthorPrompts(locale)
    : builtinPlayPrompts(locale);
  const selected =
    entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const builtinOf = (entry: OrderedPlayPrompt | undefined) =>
    entry?.kind === "builtin"
      ? catalog.find((item) => item.id === entry.builtin)
      : undefined;
  const builtin = builtinOf(selected);
  const name = (entry: OrderedPlayPrompt) =>
    entry.kind === "world"
      ? t("Complete world prompt", "完整内容包提示")
      : entry.kind === "user" || entry.kind === "tail"
        ? entry.name
        : catalog.find((item) => item.id === entry.builtin)!.name;
  const categoryLabels: Record<PromptCategory | "tail", string> = {
    mechanics: t("Required", "必选"),
    choice: t("Choice", "选项"),
    policy: t("Policy", "政策"),
    style: t("Style", "文风"),
    tail: t("Tail line", "尾部行"),
  };
  const category = (entry: OrderedPlayPrompt) =>
    entry.kind === "tail"
      ? categoryLabels.tail
      : entry.kind === "builtin"
        ? categoryLabels[builtinOf(entry)!.category]
        : undefined;
  const index = entries.findIndex((entry) => entry.id === selected?.id);
  function move(id: string, to: number) {
    const from = entries.findIndex((entry) => entry.id === id);
    if (from < 0 || to < 0 || to >= entries.length || from === to) return;
    const next = [...entries];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry!);
    onChange(next);
  }
  /**
   * Replace one entry. Enabling a member of an exclusive choice group turns
   * its siblings off, so the list never carries two persons or two agencies.
   */
  function update(entry: OrderedPlayPrompt) {
    const group =
      entry.kind === "builtin" && entry.enabled
        ? builtinOf(entry)?.group
        : undefined;
    onChange(
      entries.map((current) => {
        if (current.id === entry.id) return entry;
        if (
          group !== undefined &&
          current.kind === "builtin" &&
          current.enabled &&
          builtinOf(current)?.group === group
        )
          return { ...current, enabled: false };
        return current;
      }),
    );
  }
  /** A user entry's tabletop scope is a property of the entry, not of its text. */
  function withScope(
    entry: Extract<OrderedPlayPrompt, { kind: "user" }>,
    scope: PromptGameplayScope | undefined,
  ): OrderedPlayPrompt {
    const next = { ...entry };
    delete next.gameplay;
    return scope === undefined ? next : { ...next, gameplay: scope };
  }
  function insert(entry: OrderedPlayPrompt) {
    const next = [...entries];
    next.splice(index + 1, 0, entry);
    onChange(next);
    setSelectedId(entry.id);
    onSelectPrompt?.();
  }
  function add(
    body = "",
    title = t("New prompt", "新提示词"),
    messageRole: PromptMessageRole = "system",
    gameplay?: PromptGameplayScope,
    turnGuide?: string,
  ) {
    insert({
      id: browserUUID(),
      kind: "user",
      name: title,
      enabled: true,
      body,
      messageRole,
      ...(gameplay === undefined ? {} : { gameplay }),
      ...(turnGuide === undefined ? {} : { turnGuide }),
    });
  }
  function addTail() {
    insert({
      id: browserUUID(),
      kind: "tail",
      name: t("New tail line", "新尾部行"),
      enabled: true,
      body: "",
    });
  }
  /** The line this entry contributes to the turn guide, before trimming. */
  const turnGuideValue = (entry: OrderedPlayPrompt): string =>
    entry.kind === "tail"
      ? entry.body
      : entry.kind === "builtin"
        ? (entry.turnGuide ?? builtinOf(entry)?.turnGuide ?? "")
        : entry.kind === "user"
          ? (entry.turnGuide ?? "")
          : "";
  function setTurnGuide(entry: OrderedPlayPrompt, value: string) {
    if (entry.kind === "tail") update({ ...entry, body: value });
    else if (entry.kind === "user") {
      const next = { ...entry };
      if (value === "") delete next.turnGuide;
      else next.turnGuide = value;
      update(next);
    } else if (entry.kind === "builtin") {
      const next = { ...entry };
      if (value === (builtinOf(entry)?.turnGuide ?? "")) delete next.turnGuide;
      else next.turnGuide = value;
      update(next);
    }
  }
  type PreviewItem =
    | { kind: "line"; entry: OrderedPlayPrompt; line: TurnGuideLine }
    | { kind: "world" };
  const previewLines: PreviewItem[] = authoring
    ? []
    : entries.flatMap((entry): PreviewItem[] => {
        if (entry.kind === "world") return [{ kind: "world" }];
        if (!entry.enabled) return [];
        const text = orderedPromptTurnGuide(entry, catalog);
        return text === undefined
          ? []
          : [
              {
                kind: "line",
                entry,
                line: {
                  source:
                    entry.kind === "builtin"
                      ? `preset:builtin/${entry.builtin}`
                      : `preset:prompt/${entry.id}`,
                  text,
                },
              },
            ];
      });
  const warnings = turnGuideWarnings(
    previewLines.flatMap((item) => (item.kind === "line" ? [item.line] : [])),
  );
  return (
    <section
      aria-label={
        authoring
          ? t("Ordered authoring prompts", "设定完善提示词编排")
          : t("Ordered play prompts", "游玩提示词编排")
      }
    >
      {migrationNotice && <p role="status">{migrationNotice}</p>}
      {onMergeConsecutiveMessagesChange && (
        <label>
          <input
            type="checkbox"
            checked={mergeConsecutiveMessages}
            onChange={(event) =>
              onMergeConsecutiveMessagesChange(event.target.checked)
            }
          />
          {t(
            "Merge adjacent messages with the same role",
            "合并相邻同角色消息",
          )}
        </label>
      )}
      <div className="ordered-play-editor">
        <aside>
          <button type="button" onClick={() => add()}>
            {t("Add prompt", "新增提示词")}
          </button>
          {!authoring && (
            <button type="button" onClick={addTail}>
              {t("Add tail line", "新增尾部行")}
            </button>
          )}
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
                  aria-pressed={!detail && entry.id === selected?.id}
                  onClick={() => {
                    setSelectedId(entry.id);
                    onSelectPrompt?.();
                  }}
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
                {category(entry) !== undefined && (
                  <small className="ordered-play-category">
                    {category(entry)}
                  </small>
                )}
                {entry.kind !== "world" && (
                  <input
                    type="checkbox"
                    aria-label={`${t("Enable", "启用")} ${name(entry)}`}
                    checked={entry.enabled}
                    disabled={builtinOf(entry)?.required}
                    onChange={(event) =>
                      update({ ...entry, enabled: event.target.checked })
                    }
                  />
                )}
                {entry.kind !== "world" &&
                  orderedPromptScope(entry, catalog) !== undefined && (
                    <small>{t("Tabletop only", "仅跑团")}</small>
                  )}
                {entry.kind !== "world" && !entry.enabled && (
                  <small>{t("Disabled", "已停用")}</small>
                )}
              </li>
            ))}
          </ol>
          <p>
            {t(
              "Drag or use Alt + arrow keys to reorder. Enabling one option in a choice group turns the others off.",
              "拖动或按 Alt + 方向键排序。启用选项组中的一项会关闭同组其他项。",
            )}
          </p>
          {directory}
        </aside>
        {detail ??
          (selected && (
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
                )}
                {(selected.kind === "user" || selected.kind === "builtin") && (
                  <button
                    type="button"
                    onClick={() =>
                      add(
                        selected.kind === "user"
                          ? selected.body
                          : builtin!.body,
                        `${name(selected)} ${t("copy", "副本")}`,
                        selected.messageRole ?? "system",
                        orderedPromptScope(selected, catalog),
                        orderedPromptTurnGuide(selected, catalog),
                      )
                    }
                  >
                    {t("Clone prompt", "克隆提示词")}
                  </button>
                )}
                {(selected.kind === "user" || selected.kind === "tail") && (
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
              <div className="ordered-play-prompt-heading">
                {selected.kind !== "tail" && (
                  <label>
                    {t("Message role", "发送角色")}
                    <select
                      aria-label={t("Message role", "发送角色")}
                      value={selected.messageRole ?? "system"}
                      disabled={selected.kind === "builtin"}
                      onChange={(event) => {
                        if (isPromptMessageRole(event.target.value))
                          update({
                            ...selected,
                            messageRole: event.target.value,
                          });
                      }}
                    >
                      <option value="system">System</option>
                      <option value="user">User</option>
                      <option value="assistant">Assistant</option>
                    </select>
                  </label>
                )}
                {selected.kind === "user" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.gameplay === "tabletop"}
                      onChange={(event) =>
                        update(
                          withScope(
                            selected,
                            event.target.checked ? "tabletop" : undefined,
                          ),
                        )
                      }
                    />
                    {t("Tabletop worlds only", "仅跑团世界生效")}
                  </label>
                )}
                {selected.kind !== "world" && (
                  <label>
                    {t("Prompt name", "提示词名称")}
                    <input
                      aria-label={t("Prompt name", "提示词名称")}
                      value={name(selected)}
                      readOnly={selected.kind === "builtin"}
                      onChange={(event) => {
                        if (
                          selected.kind === "user" ||
                          selected.kind === "tail"
                        )
                          update({ ...selected, name: event.target.value });
                      }}
                    />
                  </label>
                )}
              </div>
              {selected.kind === "world" ? (
                <>
                  <h4>{name(selected)}</h4>
                  <p>
                    {t(
                      "World instructions appear here. On a fresh context, frame-selected materials and the directory index are supplied as an initial tool result. Continuing retains these materials and appends actual interactions. Inspect the content in a world or content-package Prompt Preview.",
                      "世界指令在此展开；全新上下文时，frame 选中的材料与目录索引作为初始工具结果提供。继续时保留初始材料，追加真实交互。请在具体世界或内容包的真实提示预览中检查正文。",
                    )}
                  </p>
                  {!authoring && (
                    <p>
                      {t(
                        "Turn-guide lines declared by the world frame (control/frame.yaml instructions with turnGuide) join the turn guide at this position.",
                        "世界 frame（control/frame.yaml 的 instructions 中带 turnGuide 的项）声明的尾部行在此位置进入本轮提示。",
                      )}
                    </p>
                  )}
                </>
              ) : selected.kind === "tail" ? (
                <>
                  <p>
                    {t(
                      "A tail line has no prefix text. It only contributes one line to the turn guide appended after the player input on every send.",
                      "尾部行没有前部正文，只向每次发送追加在玩家输入之后的本轮提示贡献一行。",
                    )}
                  </p>
                  <label>
                    {t("Tail line", "尾部行")}
                    <input
                      aria-label={t("Tail line", "尾部行")}
                      value={selected.body}
                      onChange={(event) =>
                        setTurnGuide(selected, event.target.value)
                      }
                    />
                  </label>
                </>
              ) : (
                <>
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
                  {!authoring && (
                    <label>
                      {t("Turn-guide line", "本轮尾部提示")}
                      <input
                        aria-label={t("Turn-guide line", "本轮尾部提示")}
                        value={turnGuideValue(selected)}
                        placeholder={t(
                          "Empty: this block adds no line to the turn guide",
                          "留空则本块不进入本轮提示",
                        )}
                        onChange={(event) =>
                          setTurnGuide(selected, event.target.value)
                        }
                      />
                      {selected.kind === "builtin" &&
                        selected.turnGuide !== undefined && (
                          <button
                            type="button"
                            onClick={() => {
                              const next = { ...selected };
                              delete next.turnGuide;
                              update(next);
                            }}
                          >
                            {t("Restore default line", "恢复默认尾部行")}
                          </button>
                        )}
                    </label>
                  )}
                </>
              )}
              {promptPreview}
            </div>
          ))}
      </div>
      {!authoring && (
        <section
          className="turn-guide-preview"
          aria-label={t("Turn guide preview", "本轮提示预览")}
        >
          <h4>{t("Turn guide preview", "本轮提示预览")}</h4>
          <p>
            {t(
              "Appended after the player input on every send and never kept in history. Lines follow the list order above; the header is fixed by Runtime.",
              "每次发送追加在玩家输入之后，不进入历史。各行顺序与上方列表一致；抬头由 Runtime 固定。",
            )}
          </p>
          <pre>{turnGuideHeader(locale)}</pre>
          {previewLines.some((item) => item.kind === "line") ? (
            <ol>
              {previewLines.map((item, position) =>
                item.kind === "world" ? (
                  <li key="world">
                    <em>
                      {t(
                        "World frame turn-guide lines appear here",
                        "世界 frame 的尾部行在此位置",
                      )}
                    </em>
                  </li>
                ) : (
                  <li key={item.entry.id}>
                    <span>{item.line.text}</span>
                    <small>
                      {name(item.entry)}
                      {orderedPromptScope(item.entry, catalog) !== undefined
                        ? ` · ${t("Tabletop only", "仅跑团")}`
                        : ""}
                    </small>
                    {warnings.some(
                      (warning) =>
                        warning.kind === "line_length" &&
                        warning.index ===
                          previewLines
                            .slice(0, position)
                            .filter((prior) => prior.kind === "line").length,
                    ) && (
                      <small role="alert">
                        {t(
                          "Over 120 characters; consider shortening",
                          "超过 120 字，建议精简",
                        )}
                      </small>
                    )}
                  </li>
                ),
              )}
            </ol>
          ) : (
            <p>
              {t(
                "No enabled entry contributes a line; nothing is appended.",
                "没有启用的条目贡献尾部行，不追加本轮提示。",
              )}
            </p>
          )}
          {warnings.some((warning) => warning.kind === "line_count") && (
            <p role="alert">
              {t(
                "More than 10 lines; the turn guide is approaching the size of the prefix rules.",
                "超过 10 行，本轮提示正在接近前部规则的体量。",
              )}
            </p>
          )}
        </section>
      )}
      {authoring && builtin?.id === "author.mechanics" && (
        <details>
          <summary>
            {t("World revision tool contract", "世界修订工具契约")}
          </summary>
          <pre>{authoringMechanics(locale, "world-revision")}</pre>
        </details>
      )}
    </section>
  );
}
