import { uiText } from "./i18n.ts";
import type { ArtifactMountName } from "./ArtifactExtensionHost.tsx";
import { MountSelect, PathChecklist } from "./PlayPresetEditorControls.tsx";
import {
  mountLabel,
  withCurrentPath,
  splitLines,
} from "./playPresetEditorLabels.ts";
interface PlayPresetPlayerViewPanelGroup {
  id: string;
  label: string;
  itemIds: string[];
}

export interface PlayPresetPlayerViewPanel {
  id: string;
  source: {
    kind: "player_view";
    view: string;
    itemIds?: string[];
  };
  channel: string;
  key: string;
  mount: ArtifactMountName;
  renderer?: string;
  rendererRevision?: string;
  rendererMode: "document" | "app";
  regex?: string;
  scripts?: string[];
  assets?: string[];
  config: {
    title?: string;
    layout: "stack" | "grid";
    theme: string;
    empty: "hide" | "message" | "show";
    emptyMessage: string;
    groups: PlayPresetPlayerViewPanelGroup[];
  };
}

export function PlayerViewPanelsEditor({
  panels,
  files,
  onChange,
  onFileChange,
}: {
  panels: PlayPresetPlayerViewPanel[];
  files: Record<string, string>;
  onChange: (panels: PlayPresetPlayerViewPanel[]) => void;
  onFileChange: (path: string, contents: string) => void;
}): React.JSX.Element {
  const rendererPaths = Object.keys(files)
    .filter((path) => /^renderers\/.+\.html$/u.test(path))
    .sort();
  const regexPaths = Object.keys(files)
    .filter((path) => /^regex\/.+\.yaml$/u.test(path))
    .sort();
  const scriptPaths = Object.keys(files)
    .filter((path) => /^scripts\/.+\.js$/u.test(path))
    .sort();
  const assetPaths = Object.keys(files)
    .filter((path) => path.startsWith("assets/"))
    .sort();

  function updatePanel(
    index: number,
    update: (panel: PlayPresetPlayerViewPanel) => PlayPresetPlayerViewPanel,
  ): void {
    onChange(
      panels.map((panel, candidateIndex) =>
        candidateIndex === index ? update(panel) : panel,
      ),
    );
  }

  function addPanel(): void {
    const used = new Set(panels.map(({ id }) => id));
    let suffix = panels.length + 1;
    let id = `panel_${suffix}`;
    while (used.has(id)) id = `panel_${++suffix}`;
    onChange([
      ...panels,
      {
        id,
        source: { kind: "player_view", view: "status" },
        channel: `player.view.${id}`,
        key: "current",
        mount: "sidebar",
        rendererMode: "document",
        config: {
          title: uiText("玩家状态"),
          layout: "stack",
          theme: "default",
          empty: "message",
          emptyMessage: uiText("当前没有可显示内容。"),
          groups: [],
        },
      },
    ]);
  }

  return (
    <div className="play-preset-structured-section">
      <div className="play-preset-section-header">
        <div>
          <h4>{uiText("玩家视图面板")}</h4>
          <p>
            {uiText(
              "把世界控制里已经定义好的玩家视图，持续显示在游玩页面。它不调用模型，也不改世界。",
            )}
          </p>
        </div>
        <button type="button" onClick={addPanel}>
          {uiText("新增玩家视图面板")}
        </button>
      </div>
      <p>{uiText("同一玩家视图由自定义面板接管，其他视图仍显示默认卡片。")}</p>
      {panels.length === 0 ? (
        <p className="play-preset-empty-copy">
          {uiText("当前没有玩家视图面板。")}
        </p>
      ) : (
        <ol
          className="play-preset-panel-editor-list"
          aria-label={uiText("玩家视图面板")}
        >
          {panels.map((panel, index) => (
            <li key={`${panel.id}-${index}`}>
              <article className="play-preset-player-panel-card">
                <header>
                  <div>
                    <strong>{panel.config.title ?? panel.id}</strong>
                    <span>
                      {uiText("玩家视图")}
                      {panel.source.view} · {mountLabel(panel.mount)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() =>
                      onChange(
                        panels.filter(
                          (_, candidateIndex) => candidateIndex !== index,
                        ),
                      )
                    }
                  >
                    {uiText("删除面板")}
                  </button>
                </header>
                <div className="play-preset-form-grid">
                  <label>
                    {uiText("面板标题")}
                    <input
                      aria-label={uiText("玩家视图面板 {index} 标题", {
                        index: index + 1,
                      })}
                      value={panel.config.title ?? ""}
                      onChange={(event) => {
                        const title = event.currentTarget.value;
                        updatePanel(index, (current) => {
                          const config = { ...current.config };
                          if (title === "") delete config.title;
                          else config.title = title;
                          return { ...current, config };
                        });
                      }}
                    />
                  </label>
                  <label>
                    {uiText("读取哪个玩家视图")}
                    <input
                      aria-label={uiText("玩家视图面板 {index} 视图", {
                        index: index + 1,
                      })}
                      list="player-view-preview-sources"
                      value={panel.source.view}
                      onChange={(event) => {
                        const view = event.currentTarget.value;
                        updatePanel(index, (current) => ({
                          ...current,
                          source: {
                            ...current.source,
                            view,
                          },
                        }));
                      }}
                    />
                  </label>
                  <label>
                    {uiText("显示位置")}
                    <MountSelect
                      ariaLabel={uiText("玩家视图面板 {index} 显示位置", {
                        index: index + 1,
                      })}
                      value={panel.mount}
                      onChange={(mount) => {
                        if (mount !== "")
                          updatePanel(index, (current) => ({
                            ...current,
                            mount,
                          }));
                      }}
                    />
                  </label>
                  <label>
                    {uiText("排列方式")}
                    <select
                      value={panel.config.layout}
                      onChange={(event) => {
                        const layout = event.currentTarget.value as
                          "stack" | "grid";
                        updatePanel(index, (current) => ({
                          ...current,
                          config: {
                            ...current.config,
                            layout,
                          },
                        }));
                      }}
                    >
                      <option value="stack">{uiText("纵向排列")}</option>
                      <option value="grid">{uiText("网格排列")}</option>
                    </select>
                  </label>
                  <label>
                    {uiText("没有内容时")}
                    <select
                      value={panel.config.empty}
                      onChange={(event) => {
                        const empty = event.currentTarget.value as
                          "hide" | "message" | "show";
                        updatePanel(index, (current) => ({
                          ...current,
                          config: {
                            ...current.config,
                            empty,
                          },
                        }));
                      }}
                    >
                      <option value="hide">{uiText("隐藏面板")}</option>
                      <option value="message">{uiText("显示说明")}</option>
                      <option value="show">{uiText("显示空值")}</option>
                    </select>
                  </label>
                  {panel.config.empty === "hide" ? null : (
                    <label>
                      {uiText("空内容说明")}
                      <input
                        value={panel.config.emptyMessage}
                        onChange={(event) => {
                          const emptyMessage = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            config: {
                              ...current.config,
                              emptyMessage,
                            },
                          }));
                        }}
                      />
                    </label>
                  )}
                </div>
                <section className="play-preset-panel-resources">
                  <h5>{uiText("渲染资源")}</h5>
                  <div className="play-preset-form-grid">
                    <label>
                      {uiText("界面模板")}
                      <select
                        value={panel.renderer ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (value === "") {
                              delete next.renderer;
                              delete next.rendererRevision;
                              next.rendererMode = "document";
                            } else {
                              next.renderer = value;
                              next.rendererRevision ??= "v1";
                              next.rendererMode = "app";
                            }
                            return next;
                          });
                        }}
                      >
                        <option value="">{uiText("使用内置显示")}</option>
                        {withCurrentPath(rendererPaths, panel.renderer).map(
                          (path) => (
                            <option key={path} value={path}>
                              {path.split("/").at(-1)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    {panel.renderer === undefined ? null : (
                      <>
                        <label>
                          {uiText("模板 revision")}
                          <input
                            value={panel.rendererRevision ?? ""}
                            onChange={(event) => {
                              const rendererRevision =
                                event.currentTarget.value;
                              updatePanel(index, (current) => ({
                                ...current,
                                rendererRevision,
                              }));
                            }}
                          />
                        </label>
                        <label>
                          {uiText("模板模式")}
                          <select
                            value={panel.rendererMode}
                            onChange={(event) => {
                              const rendererMode = event.currentTarget.value as
                                "document" | "app";
                              updatePanel(index, (current) => ({
                                ...current,
                                rendererMode,
                              }));
                            }}
                          >
                            <option value="document">
                              {uiText("静态文档")}
                            </option>
                            <option value="app">{uiText("可交互 app")}</option>
                          </select>
                        </label>
                      </>
                    )}
                    <label>
                      {uiText("正则处理规则")}
                      <select
                        value={panel.regex ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (value === "") delete next.regex;
                            else next.regex = value;
                            return next;
                          });
                        }}
                      >
                        <option value="">{uiText("不使用")}</option>
                        {withCurrentPath(regexPaths, panel.regex).map(
                          (path) => (
                            <option key={path} value={path}>
                              {path.split("/").at(-1)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </div>
                  <div className="play-preset-resource-columns">
                    <div>
                      <h6>{uiText("脚本")}</h6>
                      <PathChecklist
                        ariaLabel={uiText("玩家视图面板 {index} 脚本", {
                          index: index + 1,
                        })}
                        paths={scriptPaths}
                        selected={panel.scripts ?? []}
                        emptyText={uiText("没有脚本文件。")}
                        onChange={(scripts) =>
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (scripts.length === 0) delete next.scripts;
                            else next.scripts = scripts;
                            return next;
                          })
                        }
                      />
                    </div>
                    <div>
                      <h6>{uiText("样式与资源")}</h6>
                      <PathChecklist
                        ariaLabel={uiText("玩家视图面板 {index} 资源", {
                          index: index + 1,
                        })}
                        paths={assetPaths}
                        selected={panel.assets ?? []}
                        emptyText={uiText("没有资源文件。")}
                        onChange={(assets) =>
                          updatePanel(index, (current) => {
                            const next = { ...current };
                            if (assets.length === 0) delete next.assets;
                            else next.assets = assets;
                            return next;
                          })
                        }
                      />
                    </div>
                  </div>
                  {[
                    panel.renderer,
                    panel.regex,
                    ...(panel.scripts ?? []),
                    ...(panel.assets ?? []),
                  ]
                    .filter((path): path is string => path !== undefined)
                    .map((path) => (
                      <details key={path}>
                        <summary>
                          {uiText("编辑资源 {name}", {
                            name: path.split("/").at(-1) ?? path,
                          })}
                        </summary>
                        <textarea
                          aria-label={uiText("资源内容 {name}", {
                            name: path.split("/").at(-1) ?? path,
                          })}
                          value={files[path] ?? ""}
                          onChange={(event) =>
                            onFileChange(path, event.currentTarget.value)
                          }
                          spellCheck={false}
                        />
                      </details>
                    ))}
                </section>
                <details className="play-preset-advanced-card">
                  <summary>{uiText("高级面板设置")}</summary>
                  <div className="play-preset-form-grid">
                    <label>
                      {uiText("面板稳定标识")}
                      <input
                        value={panel.id}
                        onChange={(event) => {
                          const id = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            id,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      {uiText("技术频道")}
                      <input
                        value={panel.channel}
                        onChange={(event) => {
                          const channel = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            channel,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      {uiText("更新 key")}
                      <input
                        value={panel.key}
                        onChange={(event) => {
                          const key = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            key,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      {uiText("主题标识")}
                      <input
                        value={panel.config.theme}
                        onChange={(event) => {
                          const theme = event.currentTarget.value;
                          updatePanel(index, (current) => ({
                            ...current,
                            config: {
                              ...current.config,
                              theme,
                            },
                          }));
                        }}
                      />
                    </label>
                    <label>
                      {uiText("只显示这些项目（每行一个，可留空）")}
                      <textarea
                        value={(panel.source.itemIds ?? []).join("\n")}
                        onChange={(event) => {
                          const itemIds = splitLines(event.currentTarget.value);
                          updatePanel(index, (current) => {
                            const source = { ...current.source };
                            if (itemIds.length === 0) delete source.itemIds;
                            else source.itemIds = itemIds;
                            return { ...current, source };
                          });
                        }}
                      />
                    </label>
                  </div>
                  <div className="play-preset-section-header">
                    <div>
                      <h6>{uiText("分组")}</h6>
                      <p>
                        {uiText("把已选项目按组显示；每个项目 ID 单独一行。")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        updatePanel(index, (current) => {
                          const used = new Set(
                            current.config.groups.map(({ id }) => id),
                          );
                          let suffix = current.config.groups.length + 1;
                          let id = `group_${suffix}`;
                          while (used.has(id)) id = `group_${++suffix}`;
                          return {
                            ...current,
                            config: {
                              ...current.config,
                              groups: [
                                ...current.config.groups,
                                { id, label: uiText("新分组"), itemIds: [] },
                              ],
                            },
                          };
                        })
                      }
                    >
                      {uiText("新增分组")}
                    </button>
                  </div>
                  <ol className="play-preset-group-list">
                    {panel.config.groups.map((group, groupIndex) => (
                      <li key={`${group.id}-${groupIndex}`}>
                        <label>
                          {uiText("分组标题")}
                          <input
                            value={group.label}
                            onChange={(event) => {
                              const label = event.currentTarget.value;
                              updatePanel(index, (current) => ({
                                ...current,
                                config: {
                                  ...current.config,
                                  groups: current.config.groups.map(
                                    (entry, candidateIndex) =>
                                      candidateIndex === groupIndex
                                        ? {
                                            ...entry,
                                            label,
                                          }
                                        : entry,
                                  ),
                                },
                              }));
                            }}
                          />
                        </label>
                        <label>
                          {uiText("分组标识")}
                          <input
                            value={group.id}
                            onChange={(event) => {
                              const id = event.currentTarget.value;
                              updatePanel(index, (current) => ({
                                ...current,
                                config: {
                                  ...current.config,
                                  groups: current.config.groups.map(
                                    (entry, candidateIndex) =>
                                      candidateIndex === groupIndex
                                        ? {
                                            ...entry,
                                            id,
                                          }
                                        : entry,
                                  ),
                                },
                              }));
                            }}
                          />
                        </label>
                        <label>
                          {uiText("项目 ID（每行一个）")}
                          <textarea
                            value={group.itemIds.join("\n")}
                            onChange={(event) => {
                              const itemIds = splitLines(
                                event.currentTarget.value,
                              );
                              updatePanel(index, (current) => ({
                                ...current,
                                config: {
                                  ...current.config,
                                  groups: current.config.groups.map(
                                    (entry, candidateIndex) =>
                                      candidateIndex === groupIndex
                                        ? {
                                            ...entry,
                                            itemIds,
                                          }
                                        : entry,
                                  ),
                                },
                              }));
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            updatePanel(index, (current) => ({
                              ...current,
                              config: {
                                ...current.config,
                                groups: current.config.groups.filter(
                                  (_, candidateIndex) =>
                                    candidateIndex !== groupIndex,
                                ),
                              },
                            }))
                          }
                        >
                          {uiText("删除分组")}
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
