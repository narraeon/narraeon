import { useState, type ReactNode } from "react";
import {
  builtinFollowupExample,
  defaultFollowupItems,
  type FollowupItem,
} from "../shared/ordered-followups.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import type { PlayPresetFollowupDefinition } from "./PlayPresetScreen.tsx";

/** A separate sortable scope: main prompts never accept these drag payloads. */
export function FollowupListEditor({
  definitions,
  items: savedItems,
  onItemsChange,
  onClone,
  renderUser,
}: {
  definitions: PlayPresetFollowupDefinition[];
  items: FollowupItem[] | undefined;
  onItemsChange: (items: FollowupItem[]) => void;
  onClone: (definition: PlayPresetFollowupDefinition, body: string) => void;
  renderUser: (
    definition: PlayPresetFollowupDefinition,
    index: number,
  ) => ReactNode;
}): React.JSX.Element {
  const items = savedItems ?? defaultFollowupItems(definitions);
  const [selected, setSelected] = useState<string>();
  const selectedItem =
    items.find((item) => item.id === selected) ??
    items.find((item) => item.kind === "user") ??
    items[0];
  const example = builtinFollowupExample(getWebLocale());
  function name(item: FollowupItem): string {
    return item.kind === "builtin"
      ? example.definition.displayName
      : item.kind === "content-package"
        ? uiText("内容包后置请求")
        : (definitions.find((def) => def.id === item.id)?.displayName ??
          item.id);
  }
  function move(id: string, target: number): void {
    const from = items.findIndex((item) => item.id === id);
    if (from < 0 || target < 0 || target >= items.length) return;
    const next = [...items];
    next.splice(target, 0, ...next.splice(from, 1));
    onItemsChange(next);
  }
  return (
    <div className="followup-workbench">
      <ol aria-label={uiText("后置请求")} className="followup-order">
        {items.map((item, index) => (
          <li
            key={item.id}
            className={
              item.kind === "user"
                ? "play-preset-followup-card"
                : "followup-reference"
            }
            draggable
            onDragStart={(event) =>
              event.dataTransfer.setData(
                "application/x-narraeon-followup",
                item.id,
              )
            }
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes(
                  "application/x-narraeon-followup",
                )
              )
                event.preventDefault();
            }}
            onDrop={(event) => {
              const id = event.dataTransfer.getData(
                "application/x-narraeon-followup",
              );
              if (id) {
                event.preventDefault();
                move(id, index);
              }
            }}
          >
            <button
              type="button"
              aria-pressed={item.id === selectedItem?.id}
              onClick={() => setSelected(item.id)}
              onKeyDown={(event) => {
                if (
                  event.altKey &&
                  ["ArrowUp", "ArrowDown"].includes(event.key)
                ) {
                  event.preventDefault();
                  move(item.id, index + (event.key === "ArrowUp" ? -1 : 1));
                }
              }}
            >
              {name(item)}
            </button>
            <label>
              <input
                type="checkbox"
                aria-label={`${uiText("启用")} ${name(item)}`}
                checked={item.enabled}
                onChange={(event) =>
                  onItemsChange(
                    items.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, enabled: event.currentTarget.checked }
                        : entry,
                    ),
                  )
                }
              />
              {uiText("启用")}
            </label>
            <button
              type="button"
              aria-label={`${uiText("上移")} ${name(item)}`}
              disabled={index === 0}
              onClick={() => move(item.id, index - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`${uiText("下移")} ${name(item)}`}
              disabled={index === items.length - 1}
              onClick={() => move(item.id, index + 1)}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      <div className="followup-details">
        {selectedItem?.kind === "user" ? (
          definitions.map((definition, index) =>
            definition.id === selectedItem.id ? (
              <div key={definition.id}>{renderUser(definition, index)}</div>
            ) : null,
          )
        ) : selectedItem?.kind === "builtin" ? (
          <>
            <h4>{example.definition.displayName}</h4>
            <p>
              {uiText("系统示例只读；新运行使用应用最新版，克隆后独立保存。")}
            </p>
            <textarea
              aria-label={uiText("系统后置提示词")}
              readOnly
              value={example.body}
              rows={8}
            />
            <p>
              {uiText(
                "界面产物：场景回顾，Markdown，剧情内容区；保存到提交，替换上一份，显式清除。",
              )}
            </p>
            <button
              type="button"
              onClick={() => onClone(example.definition, example.body)}
            >
              {uiText("克隆后置请求")}
            </button>
          </>
        ) : (
          <>
            <h4>{uiText("内容包后置请求")}</h4>
            <p>
              {uiText(
                "在此位置展开当前世界的内容包后置请求。无声明时为空组，不调用模型；正文由内容包管理。",
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
