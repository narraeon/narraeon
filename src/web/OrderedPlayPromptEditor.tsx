import type { ModelConnectionView } from "../protocol/modelConnections.ts";
import { browserUUID } from "./browser-uuid.ts";
import { builtinAuthorPrompts } from "../shared/ordered-author-prompts.ts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { getWebLocale, uiText } from "./i18n.ts";

export function OrderedPlayPromptEditor({
  entries,
  onChange,
  mergeConsecutiveMessages = true,
  onMergeConsecutiveMessagesChange,
  migrationNotice,
  authoring = false,
  initialPromptId,
  directory,
  promptPreview,
  detail,
  onSelectPrompt,
  onFocusPrompt,
  entryDetails,
  modelConnection,
  onEditModelConnection,
}: {
  entries: OrderedPlayPrompt[];
  mergeConsecutiveMessages?: boolean;
  onMergeConsecutiveMessagesChange?: (value: boolean) => void;
  onChange: (entries: OrderedPlayPrompt[]) => void;
  migrationNotice?: string;
  authoring?: boolean;
  initialPromptId?: string | null | undefined;
  directory?: ReactNode;
  promptPreview?: ReactNode;
  entryDetails?: ((entryId: string) => ReactNode) | undefined;
  detail?: ReactNode;
  onSelectPrompt?: () => void;
  onFocusPrompt?:
    ((id: string | undefined, name: string | undefined) => void) | undefined;
  modelConnection?:
    Pick<ModelConnectionView, "name" | "modelPrompt"> | undefined;
  onEditModelConnection?: (() => void) | undefined;
}) {
  const [selectedId, setSelectedId] = useState(initialPromptId);
  const initialEntryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = initialEntryButton.current;
    if (button === null) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView?.({ block: "nearest" });
  }, []);
  const [dragged, setDragged] = useState<string>();
  const locale = getWebLocale();
  const catalog: BuiltinPlayPrompt[] = authoring
    ? builtinAuthorPrompts(locale, "setting")
    : builtinPlayPrompts(locale);
  const selected =
    selectedId === undefined
      ? entries[0]
      : (entries.find((entry) => entry.id === selectedId) ??
        (initialPromptId === undefined ? entries[0] : undefined));
  const builtinOf = (entry: OrderedPlayPrompt | undefined) =>
    entry?.kind === "builtin"
      ? catalog.find((item) => item.id === entry.builtin)
      : undefined;
  const builtin = builtinOf(selected);
  const isModelPrompt = builtin?.dynamic === "model-prompt";
  const name = (entry: OrderedPlayPrompt) =>
    entry.kind === "world"
      ? uiText("完整内容包提示")
      : entry.kind === "user" || entry.kind === "tail"
        ? entry.name
        : catalog.find((item) => item.id === entry.builtin)!.name;
  const focusedId = detail ? undefined : selected?.id;
  const focusedName =
    detail || selected === undefined ? undefined : name(selected);
  useEffect(
    () => onFocusPrompt?.(focusedId, focusedName),
    [onFocusPrompt, focusedId, focusedName],
  );
  const categoryLabels: Record<PromptCategory | "tail", string> = {
    mechanics: uiText("必选"),
    choice: uiText("选项"),
    policy: uiText("政策"),
    style: uiText("文风"),
    tail: uiText("尾部行"),
  };
  const category = (entry: OrderedPlayPrompt) =>
    entry.kind === "tail"
      ? categoryLabels.tail
      : entry.kind === "builtin"
        ? categoryLabels[builtinOf(entry)!.category]
        : uiText(entry.kind === "world" ? "动态占位" : "用户");
  const promptTagsId = useId();
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
    title = uiText("新提示词"),
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
      name: uiText("新尾部行"),
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
        authoring ? uiText("设定完善提示词编排") : uiText("游玩提示词编排")
      }
    >
      {migrationNotice && <p role="status">{migrationNotice}</p>}
      <div className="ordered-play-editor">
        <aside>
          <button type="button" onClick={() => add()}>
            {uiText("新增提示词")}
          </button>
          {!authoring && (
            <button type="button" onClick={addTail}>
              {uiText("新增尾部行")}
            </button>
          )}
          <ol aria-label={uiText("提示词顺序")}>
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
                  aria-label={name(entry)}
                  aria-describedby={`${promptTagsId}-${position}`}
                  ref={
                    entry.id === initialPromptId
                      ? initialEntryButton
                      : undefined
                  }
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
                  <span
                    id={`${promptTagsId}-${position}`}
                    className="ordered-play-entry-tags"
                  >
                    <small className="ordered-play-category">
                      {category(entry)}
                    </small>
                    {entry.kind !== "world" &&
                      orderedPromptScope(entry, catalog) !== undefined && (
                        <small>{uiText("仅跑团")}</small>
                      )}
                    {entry.kind !== "world" && !entry.enabled && (
                      <small>{uiText("已停用")}</small>
                    )}
                  </span>
                </button>
                {entry.kind !== "world" && (
                  <input
                    type="checkbox"
                    aria-label={`${uiText("启用")} ${name(entry)}`}
                    checked={entry.enabled}
                    disabled={builtinOf(entry)?.required}
                    onChange={(event) =>
                      update({ ...entry, enabled: event.target.checked })
                    }
                  />
                )}
              </li>
            ))}
          </ol>
          <p>
            {uiText(
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
                  {uiText("上移")}
                </button>
                <button
                  type="button"
                  disabled={index >= entries.length - 1}
                  onClick={() => move(selected.id, index + 1)}
                >
                  {uiText("下移")}
                </button>
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
                    {uiText("仅跑团世界生效")}
                  </label>
                )}
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
                    {uiText("orchestration.prompt.enabled")}
                  </label>
                )}
                {!isModelPrompt &&
                  (selected.kind === "user" || selected.kind === "builtin") && (
                    <button
                      type="button"
                      onClick={() =>
                        add(
                          selected.kind === "user"
                            ? selected.body
                            : builtin!.body,
                          `${name(selected)} ${uiText("副本")}`,
                          selected.messageRole ?? "system",
                          orderedPromptScope(selected, catalog),
                          orderedPromptTurnGuide(selected, catalog),
                        )
                      }
                    >
                      {uiText("克隆提示词")}
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
                    {uiText("删除提示词")}
                  </button>
                )}
              </div>
              <div className="ordered-play-prompt-heading">
                {selected.kind !== "tail" && (
                  <label>
                    {uiText("发送角色")}
                    <select
                      aria-label={uiText("发送角色")}
                      value={selected.messageRole ?? "system"}
                      disabled={selected.kind === "builtin" && !isModelPrompt}
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
                {selected.kind !== "world" && (
                  <label>
                    {uiText("提示词名称")}
                    <input
                      aria-label={uiText("提示词名称")}
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
              {entryDetails?.(selected.id)}
              {isModelPrompt ? (
                <>
                  <p>{modelConnection?.name ?? uiText("未启用模型连接")}</p>
                  <label>
                    {uiText("提示词正文")}
                    <textarea
                      rows={8}
                      readOnly
                      value={modelConnection?.modelPrompt ?? ""}
                    />
                  </label>
                  {onEditModelConnection && (
                    <button type="button" onClick={onEditModelConnection}>
                      {uiText("编辑模型连接")}
                    </button>
                  )}
                </>
              ) : selected.kind === "world" ? (
                <>
                  <h4>{name(selected)}</h4>
                  <p>
                    {uiText(
                      "世界指令在此展开；全新上下文时，frame 选中的材料与目录索引作为初始工具结果提供。继续时保留初始材料，追加真实交互。请在具体世界或内容包的真实提示预览中检查正文。",
                    )}
                  </p>
                  {!authoring && (
                    <p>
                      {uiText(
                        "世界 frame（control/frame.yaml 的 instructions 中带 turnGuide 的项）声明的尾部行在此位置进入本轮提示。",
                      )}
                    </p>
                  )}
                </>
              ) : selected.kind === "tail" ? (
                <>
                  <p>{uiText("尾部行为每次游玩请求的本轮提示贡献一行。")}</p>
                  <label>
                    {uiText("尾部行")}
                    <input
                      aria-label={uiText("尾部行")}
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
                      {uiText(
                        "系统引用始终使用应用最新版正文；克隆获得可编辑、独立的固定副本。",
                      )}
                    </p>
                  )}
                  <label>
                    {uiText("提示词正文")}
                    <textarea
                      aria-label={uiText("提示词正文")}
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
                      {uiText("本轮尾部提示")}
                      <input
                        aria-label={uiText("本轮尾部提示")}
                        value={turnGuideValue(selected)}
                        placeholder={uiText("留空则本块不进入本轮提示")}
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
                            {uiText("恢复默认尾部行")}
                          </button>
                        )}
                    </label>
                  )}
                </>
              )}
            </div>
          ))}
      </div>
      {onMergeConsecutiveMessagesChange && (
        <label className="ordered-play-merge">
          <input
            type="checkbox"
            checked={mergeConsecutiveMessages}
            onChange={(event) =>
              onMergeConsecutiveMessagesChange(event.target.checked)
            }
          />
          {uiText("合并相邻同角色消息")}
        </label>
      )}
      {promptPreview}
      {!authoring && (
        <section
          className="turn-guide-preview"
          aria-label={uiText("本轮提示预览")}
        >
          <h4>{uiText("本轮提示预览")}</h4>
          <p>
            {uiText(
              "本轮提示只用于当前请求，各行按上方列表顺序排列。在提示词预览的 Provider 映射中可以查看实际发送位置。",
            )}
          </p>
          <pre>{turnGuideHeader(locale)}</pre>
          {previewLines.some((item) => item.kind === "line") ? (
            <ol>
              {previewLines.map((item, position) =>
                item.kind === "world" ? (
                  <li key="world">
                    <em>{uiText("世界 frame 的尾部行在此位置")}</em>
                  </li>
                ) : (
                  <li key={item.entry.id}>
                    <span>{item.line.text}</span>
                    <small>
                      {name(item.entry)}
                      {orderedPromptScope(item.entry, catalog) !== undefined
                        ? ` · ${uiText("仅跑团")}`
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
                        {uiText("超过 120 字，建议精简")}
                      </small>
                    )}
                  </li>
                ),
              )}
            </ol>
          ) : (
            <p>{uiText("没有启用的条目贡献尾部行，不追加本轮提示。")}</p>
          )}
          {warnings.some((warning) => warning.kind === "line_count") && (
            <p role="alert">
              {uiText("超过 10 行，本轮提示正在接近前部规则的体量。")}
            </p>
          )}
        </section>
      )}
      {authoring && builtin?.id === "author.mechanics" && (
        <details>
          <summary>{uiText("世界修订工具契约")}</summary>
          <pre>
            {
              builtinAuthorPrompts(locale, "world-revision").find(
                ({ id }) => id === builtin.id,
              )!.body
            }
          </pre>
        </details>
      )}
    </section>
  );
}
