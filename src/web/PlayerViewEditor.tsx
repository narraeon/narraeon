import { FileEditorMode, FileSourceEditor } from "./FileSourceEditor.tsx";
import { useId, useMemo, useState } from "react";

import type { PlayerViewDiagnostic } from "../protocol/playerViews.ts";
import type { ContentTreeFile } from "../protocol/v1.ts";
import { Entry } from "./PlayerViewValue.tsx";
import { browserUUID } from "./browser-uuid.ts";
import { uiText } from "./i18n.ts";
import {
  blankPlayerViewControl,
  editPlayerViewControl,
  playerViewControlPath,
  readPlayerViewControl,
  type PlayerViewControlLocator,
} from "./player-view-control-draft.ts";
import {
  buildPlayerViewDraft,
  type PlayerViewDraftLocator,
} from "./player-view-draft.ts";
import styles from "./PlayerViewEditor.module.css";

type Draft = ReturnType<typeof buildPlayerViewDraft>;
type FormEdit = Parameters<typeof editPlayerViewControl>[1];
type ControlView = NonNullable<
  ReturnType<typeof readPlayerViewControl>["views"]
>[number];
type ControlItem = ControlView["items"][number];

// Large documents only mount all native options for the select being used.
const maxInlineOptions = 160;
const noChoices: readonly PlayerViewDraftLocator[] = [];
const scopeOptionsByList = new WeakMap<
  readonly PlayerViewDraftLocator[],
  { whole: boolean; nodes: ReadonlyMap<string, PlayerViewControlLocator> }
>();

export function PlayerViewEditor({
  contents,
  files,
  layout,
  onChange,
  onSave,
}: {
  contents: string;
  files: readonly ContentTreeFile[];
  layout: "content_package" | "world_revision";
  onChange: (contents: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  const titleId = useId();
  const [sourceRequested, setSourceRequested] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const control = useMemo(() => readPlayerViewControl(contents), [contents]);
  const showSource = sourceRequested || control.views === undefined;
  const draft = useMemo(
    () => (showSource ? undefined : buildPlayerViewDraft(files, layout)),
    [files, layout, showSource],
  );
  const preview = useMemo(
    () => (draft === undefined ? undefined : draft.render(contents)),
    [contents, draft],
  );
  const views = control.views ?? [];
  const selectedIndex = Math.max(
    0,
    views.findIndex(({ id }) => id === selectedId),
  );
  const selected = views[selectedIndex];
  const selectedPreview = preview?.views.find(({ id }) => id === selected?.id);
  const diagnostics =
    preview?.diagnostics.filter(({ viewId }) => viewId === selected?.id) ?? [];

  function edit(change: FormEdit): void {
    onChange(editPlayerViewControl(contents, change));
  }

  function addView(): void {
    const id = `view-${browserUUID()}`;
    edit({
      kind: "append",
      path: ["views"],
      value: { id, title: uiText("新玩家视图"), items: [] },
    });
    setSelectedId(id);
  }

  return (
    <section
      className={styles.editor}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          onSave();
        }
      }}
    >
      <header className={styles.toolbar}>
        <h5 id={titleId}>{uiText("玩家视图编辑")}</h5>
        <FileEditorMode
          showSource={showSource}
          onSource={() => setSourceRequested(true)}
          form={{
            disabled: control.views === undefined,
            show: () => setSourceRequested(false),
          }}
        />
      </header>
      {showSource ? (
        <>
          {control.error === undefined ? null : (
            <div role="status" className={styles.notice}>
              {uiText(
                "这份 YAML 暂时无法用表单编辑。可以直接修改源码，修复后切回表单。",
              )}
              {control.error.length === 0 ? null : (
                <small>{control.error}</small>
              )}
            </div>
          )}
          {contents.trim().length === 0 ? (
            <button
              type="button"
              className={`secondary-button ${styles.add}`}
              onClick={() => {
                onChange(blankPlayerViewControl);
                setSourceRequested(false);
              }}
            >
              {uiText("初始化玩家视图")}
            </button>
          ) : null}
          <FileSourceEditor
            path={playerViewControlPath}
            contents={contents}
            onChange={(source) => {
              setSourceRequested(true);
              onChange(source);
            }}
          />
        </>
      ) : (
        <>
          <div
            className={styles.viewPicker}
            role="group"
            aria-label={uiText("选择玩家视图")}
          >
            {views.map(({ id, title }) => (
              <button
                key={id}
                type="button"
                className="secondary-button"
                aria-pressed={id === selected?.id}
                onClick={() => setSelectedId(id)}
              >
                {title || uiText("未命名视图")}
              </button>
            ))}
            <button
              type="button"
              className="secondary-button"
              onClick={addView}
            >
              {uiText("新增视图")}
            </button>
          </div>
          {selected === undefined || draft === undefined ? (
            <p className={styles.empty}>
              {uiText("添加一个视图，选择要给玩家看的内容。")}
            </p>
          ) : (
            <div className={styles.columns}>
              <div className={styles.form}>
                <div className={styles.viewHeading}>
                  <label>
                    {uiText("视图名称")}
                    <input
                      value={selected.title}
                      onChange={(event) =>
                        edit({
                          kind: "set",
                          path: ["views", selectedIndex, "title"],
                          value: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <OrderActions
                    groupLabel={uiText("视图操作")}
                    removeLabel={uiText("移除视图")}
                    index={selectedIndex}
                    count={views.length}
                    onMove={(to) => {
                      setSelectedId(selected.id);
                      edit({
                        kind: "move",
                        path: ["views"],
                        from: selectedIndex,
                        to,
                      });
                    }}
                    onRemove={() => {
                      edit({ kind: "delete", path: ["views", selectedIndex] });
                      setSelectedId(
                        (views[selectedIndex + 1] ?? views[selectedIndex - 1])
                          ?.id,
                      );
                    }}
                  />
                </div>
                <ol className={styles.items} aria-label={uiText("显示项")}>
                  {selected.items.map((item, index) => (
                    <ItemEditor
                      key={JSON.stringify([selected.id, item.id])}
                      item={item}
                      index={index}
                      count={selected.items.length}
                      draft={draft}
                      diagnostics={diagnostics.filter(
                        ({ itemId }) => itemId === item.id,
                      )}
                      viewIndex={selectedIndex}
                      onEdit={edit}
                    />
                  ))}
                </ol>
                <button
                  type="button"
                  className={`secondary-button ${styles.add}`}
                  onClick={() =>
                    edit({
                      kind: "append",
                      path: ["views", selectedIndex, "items"],
                      value: {
                        id: `item-${browserUUID()}`,
                        label: uiText("新显示项"),
                        select: { document: "" },
                      },
                    })
                  }
                >
                  {uiText("新增显示项")}
                </button>
              </div>
              <section
                className={styles.preview}
                aria-label={uiText("玩家视图草稿预览")}
              >
                <h6>{uiText("草稿预览")}</h6>
                <h5>{selected.title || uiText("未命名视图")}</h5>
                {selectedPreview === undefined ||
                selectedPreview.items.length === 0 ? (
                  <p className={styles.empty}>
                    {uiText("当前没有可显示项目。")}
                  </p>
                ) : (
                  <dl className={styles.values}>
                    {selectedPreview.items.map(({ id, label, value }) => (
                      <Entry
                        key={JSON.stringify([selected.id, id])}
                        path={JSON.stringify([selected.id, id])}
                        label={label}
                        value={value}
                        defaultOpen
                      />
                    ))}
                  </dl>
                )}
                {diagnostics.some(
                  ({ code }) => code === "capacity_exceeded",
                ) ? (
                  <p className={styles.notice}>
                    {uiText("已达到玩家视图的显示上限。")}
                  </p>
                ) : null}
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ItemEditor({
  item,
  index,
  count,
  draft,
  diagnostics,
  viewIndex,
  onEdit,
}: {
  item: ControlItem;
  index: number;
  count: number;
  draft: Draft;
  diagnostics: readonly PlayerViewDiagnostic[];
  viewIndex: number;
  onEdit: (change: FormEdit) => void;
}): React.JSX.Element {
  const statusId = useId();
  const [activeSelect, setActiveSelect] = useState<"document" | "scope">();
  const itemsPath = ["views", viewIndex, "items"] as const;
  const itemPath = [...itemsPath, index] as const;
  const selectorPath = [...itemPath, "select"] as const;
  const documentHandle = item.select.document;
  const selectedDocument = draft.resolve(documentHandle);
  const choices =
    selectedDocument === undefined ? noChoices : draft.choices(documentHandle);
  const scopes = scopeOptions(choices);
  const documents =
    draft.documents.length <= maxInlineOptions || activeSelect === "document"
      ? draft.documents
      : selectedDocument === undefined
        ? []
        : [selectedDocument];
  const hints =
    selectedDocument === undefined
      ? undefined
      : draft.choiceHints(documentHandle);
  const locator = item.select.locator;
  const currentLocator =
    locator !== undefined &&
    (("yaml" in locator &&
      selectedDocument?.codec === "yaml" &&
      locator.yaml.length === 0) ||
      ("markdown" in locator &&
        selectedDocument?.codec === "markdown" &&
        locator.markdown.length === 0))
      ? undefined
      : locator;
  const currentLocatorKey =
    currentLocator === undefined ? "" : locatorKey(currentLocator);
  const currentChoice = scopes.nodes.get(currentLocatorKey);
  const visibleScopes =
    scopes.nodes.size <= maxInlineOptions || activeSelect === "scope"
      ? [...scopes.nodes]
      : currentChoice === undefined
        ? []
        : [[currentLocatorKey, currentChoice] as const];
  const missingLocator =
    currentLocator !== undefined && currentChoice === undefined;
  const missingWhole =
    currentLocator === undefined &&
    selectedDocument !== undefined &&
    !scopes.whole;
  const invalid = diagnostics.some(({ code }) => code === "invalid_control");
  const capped = diagnostics.some(({ code }) => code === "capacity_exceeded");
  const unresolved = diagnostics.some(
    ({ code }) => code === "unresolved_selector",
  );
  const absentDocument =
    documentHandle.length > 0 && selectedDocument === undefined;
  const showWarning =
    absentDocument ||
    missingLocator ||
    missingWhole ||
    invalid ||
    capped ||
    unresolved;

  function changeScope(value: string): void {
    if (value === "") {
      onEdit({ kind: "delete", path: [...selectorPath, "locator"] });
      return;
    }
    const selected = scopes.nodes.get(value);
    if (selected !== undefined) {
      onEdit({
        kind: "set-locator",
        path: [...selectorPath, "locator"],
        value: selected,
      });
    }
  }

  return (
    <li className={styles.item}>
      <div className={styles.itemHeading}>
        <label>
          {uiText("显示名称")}
          <input
            value={item.label}
            onChange={(event) =>
              onEdit({
                kind: "set",
                path: [...itemPath, "label"],
                value: event.currentTarget.value,
              })
            }
          />
        </label>
        <OrderActions
          groupLabel={uiText("显示项操作")}
          removeLabel={uiText("移除显示项")}
          index={index}
          count={count}
          onMove={(to) =>
            onEdit({ kind: "move", path: itemsPath, from: index, to })
          }
          onRemove={() => onEdit({ kind: "delete", path: itemPath })}
        />
      </div>
      <div className={styles.selectors}>
        <label>
          {uiText("来源文档")}
          <select
            value={documentHandle}
            aria-describedby={showWarning ? statusId : undefined}
            aria-invalid={absentDocument || undefined}
            onFocus={() => setActiveSelect("document")}
            onPointerDown={() => setActiveSelect("document")}
            onBlur={() => setActiveSelect(undefined)}
            onChange={(event) =>
              onEdit({
                kind: "set",
                path: [...selectorPath, "document"],
                value: event.currentTarget.value,
              })
            }
          >
            <option value="" disabled>
              {uiText("选择来源文档")}
            </option>
            {absentDocument ? (
              <option value={documentHandle} disabled>
                {uiText("找不到：{source}", { source: documentHandle })}
              </option>
            ) : null}
            {documents.map((document) => (
              <option
                key={document.ref}
                value={
                  document.ref === selectedDocument?.ref
                    ? documentHandle
                    : document.ref
                }
              >
                {`${document.title} · ${document.ref}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {uiText("显示范围")}
          <select
            value={currentLocatorKey}
            disabled={selectedDocument === undefined}
            aria-describedby={showWarning ? statusId : undefined}
            aria-invalid={missingLocator || missingWhole || undefined}
            onFocus={() => setActiveSelect("scope")}
            onPointerDown={() => setActiveSelect("scope")}
            onBlur={() => setActiveSelect(undefined)}
            onChange={(event) => changeScope(event.currentTarget.value)}
          >
            <option value="" disabled={!scopes.whole}>
              {uiText("整份文档")}
            </option>
            {missingLocator ? (
              <option value={currentLocatorKey} disabled>
                {uiText("找不到：{source}", {
                  source: locatorLabel(currentLocator),
                })}
              </option>
            ) : null}
            {visibleScopes.map(([key, choice]) => {
              const hint = hints?.get(key);
              return (
                <option key={key} value={key}>
                  {hint === undefined
                    ? locatorLabel(choice)
                    : `${locatorLabel(choice)} · ${hint}`}
                </option>
              );
            })}
          </select>
        </label>
      </div>
      {showWarning ? (
        <p id={statusId} className={styles.notice}>
          {documentHandle.length === 0
            ? uiText("请为这个显示项选择来源文档。")
            : capped
              ? uiText("此项超出了玩家视图的显示上限。")
              : invalid
                ? uiText("此项的选择器无效，请检查源码。")
                : uiText("找不到此项的来源。请选择其他文档或节点。")}
        </p>
      ) : null}
    </li>
  );
}

function scopeOptions(choices: readonly PlayerViewDraftLocator[]): {
  whole: boolean;
  nodes: ReadonlyMap<string, PlayerViewControlLocator>;
} {
  const cached = scopeOptionsByList.get(choices);
  if (cached !== undefined) return cached;
  const nodes = new Map<string, PlayerViewControlLocator>();
  let whole = false;
  for (const locator of choices) {
    if (locator === null) whole = true;
    else nodes.set(locatorKey(locator), locator);
  }
  const options = { whole, nodes };
  scopeOptionsByList.set(choices, options);
  return options;
}

function locatorKey(locator: NonNullable<PlayerViewDraftLocator>): string {
  return JSON.stringify(locator);
}

function locatorLabel(locator: PlayerViewControlLocator): string {
  const parts = "yaml" in locator ? locator.yaml : locator.markdown;
  return parts
    .map((part) =>
      part === "" ||
      part.trim() !== part ||
      /[›·"\\\r\n\t]/u.test(part) ||
      part === uiText("整份文档")
        ? JSON.stringify(part)
        : part,
    )
    .join(" › ");
}

function OrderActions({
  groupLabel,
  removeLabel,
  index,
  count,
  onMove,
  onRemove,
}: {
  groupLabel: string;
  removeLabel: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.actions} role="group" aria-label={groupLabel}>
      <button
        type="button"
        className="secondary-button"
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        {uiText("上移")}
      </button>
      <button
        type="button"
        className="secondary-button"
        disabled={index + 1 === count}
        onClick={() => onMove(index + 1)}
      >
        {uiText("下移")}
      </button>
      <button type="button" className="secondary-button" onClick={onRemove}>
        {removeLabel}
      </button>
    </div>
  );
}
