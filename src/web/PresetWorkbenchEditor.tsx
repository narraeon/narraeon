import type { ModelConnectionView } from "../protocol/modelConnections.ts";
import { browserUUID } from "./browser-uuid.ts";
import {
  builtinFollowupSource,
  newPresetArtifact,
  type PresetResourceEdit,
} from "./preset-resource-editor.ts";
import { createPresetScriptExample } from "./preset-script-examples.ts";
import { useState, type ReactNode } from "react";
import { OrderedPlayPromptEditor } from "./OrderedPlayPromptEditor.tsx";
import {
  defaultFollowupItems,
  builtinFollowupExample,
  isBuiltinExtensionFollowupId,
  withBuiltinExtensionFollowups,
  type FollowupItem,
} from "../shared/ordered-followups.ts";
import {
  builtinExtensionLabel,
  builtinStatusPanelId,
} from "../shared/first-party-play-preset-templates.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import type {
  PlayPresetStructuredEditor,
  PlayPresetFollowupDefinition,
  PlayPresetArtifactDefinition,
} from "./PlayPresetScreen.tsx";
import { PlayerViewPanelsEditor } from "./PlayerViewPanelsEditor.tsx";
import { PresetDisplayEditor } from "./PresetDisplayEditor.tsx";
import { MountSelect } from "./PlayPresetEditorControls.tsx";
import { artifactOptionLabel, mountLabel } from "./playPresetEditorLabels.ts";

export function PresetWorkbenchEditor({
  structure,
  files,
  authoring,
  initialPromptId,
  onChange,
  onWrite,
  onResourceEdit,
  onFocusPrompt,
  entryDetails,
  preview,
  promptPreview,
  modelConnection,
  onEditModelConnection,
}: {
  structure: PlayPresetStructuredEditor;
  files: Record<string, string>;
  authoring: boolean;
  initialPromptId?: string | null | undefined;
  onChange: (
    update: (s: PlayPresetStructuredEditor) => PlayPresetStructuredEditor,
  ) => void;
  onWrite: (path: string, body: string) => void;
  onResourceEdit: (edit: PresetResourceEdit) => void;
  onFocusPrompt?:
    ((id: string | undefined, name: string | undefined) => void) | undefined;
  promptPreview?: ReactNode;
  entryDetails?: ((entryId: string) => ReactNode) | undefined;
  modelConnection?: ModelConnectionView | undefined;
  onEditModelConnection?: (() => void) | undefined;
  preview: (requestId?: string, output?: string) => ReactNode;
}) {
  const [requestedSelection, setSelection] = useState<{
    kind: "followup" | "panel";
    id: string;
    fallback?: string;
  }>();
  const [tab, setTab] = useState("prompt");
  const [output, setOutput] = useState("");
  const items = withBuiltinExtensionFollowups(
    structure.followupItems ?? defaultFollowupItems(structure.followups),
  );
  // A failed clone must keep the source selected; the new identity only exists
  // after the complete resource edit has been applied.
  const selection =
    requestedSelection?.fallback &&
    !(requestedSelection.kind === "followup"
      ? items.some((item) => item.id === requestedSelection.id)
      : structure.playerViewPanels.some(
          (panel) => panel.id === requestedSelection.id,
        ))
      ? { ...requestedSelection, id: requestedSelection.fallback }
      : requestedSelection;
  const locale = getWebLocale();
  const selectedItem = items.find((i) => i.id === selection?.id);
  const builtin =
    selectedItem?.kind === "builtin"
      ? builtinFollowupSource(selectedItem.id)
      : undefined;
  const followup: PlayPresetFollowupDefinition | undefined =
    builtin?.definition ??
    structure.followups.find((f) => f.id === selection?.id);
  const followupMounts = builtin?.mounts ?? structure.mounts;
  const panel = structure.playerViewPanels.find((p) => p.id === selection?.id);
  const statusPanelLabel = builtinExtensionLabel(builtinStatusPanelId, locale);
  const artifact =
    followup?.artifacts.find((a) => a.name === output) ??
    followup?.artifacts[0];
  const readonly = selectedItem?.kind !== "user";
  function updateFollowup(
    update: (f: PlayPresetFollowupDefinition) => PlayPresetFollowupDefinition,
  ) {
    if (readonly || !followup) return;
    onChange((s) => ({
      ...s,
      followups: s.followups.map((f) => (f.id === followup.id ? update(f) : f)),
    }));
  }
  function updateArtifact(next: PlayPresetArtifactDefinition) {
    updateFollowup((f) => ({
      ...f,
      artifacts: f.artifacts.map((a) => (a.name === artifact?.name ? next : a)),
    }));
  }
  function addFollowup(source?: string) {
    const id = `request_${browserUUID().replaceAll("-", "")}`;
    onResourceEdit(
      source
        ? {
            type: "clone-followup",
            id,
            source,
          }
        : {
            type: "create-followup",
            id,
            displayName: uiText("orchestration.followup.new"),
            body: uiText("根据本轮已提交叙事，生成下面声明的界面产物。"),
          },
    );
    setSelection({
      kind: "followup",
      id,
      ...(source && selection ? { fallback: selection.id } : {}),
    });
    setTab("prompt");
  }
  function name(item: FollowupItem) {
    if (item.kind === "builtin")
      return isBuiltinExtensionFollowupId(item.id)
        ? builtinExtensionLabel(item.id, locale)
        : builtinFollowupExample(locale).definition.displayName;
    return item.kind === "content-package"
      ? uiText("内容包后置组")
      : (structure.followups.find((f) => f.id === item.id)?.displayName ??
          item.id);
  }
  function move(id: string, to: number) {
    const next = [...items];
    const from = next.findIndex((i) => i.id === id);
    if (from < 0 || to < 0 || to >= next.length) return;
    next.splice(to, 0, ...next.splice(from, 1));
    onChange((s) => ({ ...s, followupItems: next }));
  }
  const directory = (
    <>
      <section className="preset-directory-group">
        <header>
          <span>{uiText("回复完成后")}</span>
          <button
            type="button"
            aria-label={uiText("新增后置请求")}
            onClick={() => addFollowup()}
          >
            ＋
          </button>
        </header>
        <p>{uiText("每个启用的后置请求会在回复完成后额外调用模型一次。")}</p>
        <ol aria-label={uiText("后置请求")}>
          {items.map((item, index) => (
            <li
              key={item.id}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData(
                  "application/x-narraeon-followup",
                  item.id,
                )
              }
              onDragOver={(e) => {
                if (
                  e.dataTransfer.types.includes(
                    "application/x-narraeon-followup",
                  )
                )
                  e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                move(
                  e.dataTransfer.getData("application/x-narraeon-followup"),
                  index,
                );
              }}
            >
              <button
                type="button"
                aria-pressed={selection?.id === item.id}
                onClick={() => {
                  setSelection({ kind: "followup", id: item.id });
                  setTab("prompt");
                }}
                onKeyDown={(e) => {
                  if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
                    e.preventDefault();
                    move(item.id, index + (e.key === "ArrowUp" ? -1 : 1));
                  }
                }}
              >
                {name(item)}
                <small>
                  {item.kind === "builtin"
                    ? uiText("系统")
                    : item.kind === "content-package"
                      ? uiText("orchestration.followup.source.package")
                      : uiText("用户")}
                </small>
              </button>
              <input
                type="checkbox"
                aria-label={`${uiText("启用")} ${name(item)}`}
                checked={item.enabled}
                onChange={(e) =>
                  onChange((s) => ({
                    ...s,
                    followupItems: items.map((i) =>
                      i.id === item.id
                        ? { ...i, enabled: e.target.checked }
                        : i,
                    ),
                  }))
                }
              />
            </li>
          ))}
        </ol>
      </section>
      <section className="preset-directory-group">
        <header>
          <span>{uiText("纯界面 · 不调用模型")}</span>
          <button
            type="button"
            aria-label={uiText("新增纯界面")}
            onClick={() => {
              const id = `panel_${browserUUID().replaceAll("-", "")}`;
              onResourceEdit({
                type: "create-panel",
                id,
                title: uiText("世界状态栏"),
                emptyMessage: uiText("orchestration.panel.empty"),
              });
              setSelection({ kind: "panel", id });
            }}
          >
            ＋
          </button>
        </header>
        <ol>
          <li>
            <button
              type="button"
              aria-pressed={selection?.id === builtinStatusPanelId}
              onClick={() =>
                setSelection({ kind: "panel", id: builtinStatusPanelId })
              }
            >
              {statusPanelLabel}
              <small>{uiText("系统")}</small>
            </button>
            <input
              type="checkbox"
              aria-label={`${uiText("启用")} ${statusPanelLabel}`}
              checked={structure.statusPanelEnabled === true}
              onChange={(event) => {
                const statusPanelEnabled = event.currentTarget.checked;
                onChange((s) => ({ ...s, statusPanelEnabled }));
              }}
            />
          </li>
          {structure.playerViewPanels.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={selection?.id === p.id}
                onClick={() => setSelection({ kind: "panel", id: p.id })}
              >
                {p.config.title ?? p.source.view}
              </button>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
  const detail =
    selection?.id === builtinStatusPanelId ? (
      <div className="preset-object-detail">
        <h2>{statusPanelLabel}</h2>
        <p>
          {uiText(
            "用内置样式展示世界已有的状态视图。关闭后恢复默认卡片，不调用模型。",
          )}
        </p>
        <button
          type="button"
          onClick={() => {
            const id = `panel_${browserUUID().replaceAll("-", "")}`;
            onResourceEdit({ type: "clone-status-panel", id });
            setSelection({ kind: "panel", id, fallback: builtinStatusPanelId });
          }}
        >
          {uiText("克隆状态栏")}
        </button>
        {preview()}
      </div>
    ) : selection?.kind === "panel" && panel ? (
      <div className="preset-object-detail">
        <PlayerViewPanelsEditor
          panels={[panel]}
          files={files}
          onFileChange={onWrite}
          onResourceEdit={onResourceEdit}
          onChange={(panels) =>
            onChange((s) => ({
              ...s,
              playerViewPanels: s.playerViewPanels.flatMap((p) =>
                p.id === panel.id ? panels : [p],
              ),
            }))
          }
        />
        {preview()}
      </div>
    ) : selection?.kind === "followup" ? (
      <div className="preset-object-detail">
        <div className="preset-object-toolbar">
          <span>
            {uiText("回复完成后")} /{" "}
            {readonly ? uiText("系统 / 内容包") : uiText("用户")}
          </span>
          <button
            type="button"
            disabled={items[0]?.id === selection.id}
            onClick={() =>
              move(
                selection.id,
                items.findIndex((i) => i.id === selection.id) - 1,
              )
            }
          >
            ↑
          </button>
          <button
            type="button"
            disabled={items.at(-1)?.id === selection.id}
            onClick={() =>
              move(
                selection.id,
                items.findIndex((i) => i.id === selection.id) + 1,
              )
            }
          >
            ↓
          </button>
          {followup && (
            <button type="button" onClick={() => addFollowup(followup.id)}>
              {uiText("orchestration.followup.clone")}
            </button>
          )}
          {!readonly && (
            <button
              type="button"
              onClick={() => {
                onResourceEdit({ type: "remove-followup", id: selection.id });
                setSelection(undefined);
              }}
            >
              {uiText("删除")}
            </button>
          )}
        </div>
        {!followup ? (
          <>
            <h2>{uiText("内容包后置组")}</h2>
            <p>{uiText("orchestration.followup.packageExpansion")}</p>
          </>
        ) : (
          <>
            <nav className="preset-detail-tabs">
              {[
                ["prompt", uiText("提示词")],
                ["outputs", uiText("界面产物")],
                ["advanced", uiText("高级设置")],
              ].map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={tab === id}
                  onClick={() => setTab(id!)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {readonly && <p>{uiText("系统示例完整只读；克隆后独立编辑。")}</p>}
            {tab === "prompt" ? (
              <div className="preset-manuscript">
                <label>
                  {uiText("后置请求名称")}
                  <input
                    aria-label={uiText("后置请求名称")}
                    readOnly={readonly}
                    value={followup.displayName}
                    onChange={(e) =>
                      updateFollowup((f) => ({
                        ...f,
                        displayName: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  {uiText("提示词")}
                  <textarea
                    aria-label={uiText(
                      "orchestration.followup.promptPlaceholder",
                    )}
                    rows={16}
                    readOnly={readonly}
                    value={builtin?.body ?? files[followup.prompt.path] ?? ""}
                    onChange={(e) =>
                      onWrite(followup.prompt.path, e.target.value)
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={readonly}
                  onClick={() =>
                    onWrite(
                      followup.prompt.path,
                      `${files[followup.prompt.path] ?? ""}\n\n${followup.artifacts.map((a) => `output=${a.name}: ${a.purpose ?? a.displayName ?? a.name}`).join("\n")}`,
                    )
                  }
                >
                  {uiText("将产物引用加入提示词")}
                </button>
              </div>
            ) : (
              <>
                <h2>
                  {tab === "outputs"
                    ? uiText("orchestration.followup.outputs.heading")
                    : uiText("此产物的数据格式要求")}
                </h2>
                <p>{uiText("一条请求，可以生成多个界面产物。")}</p>
                <div className="preset-output-cards">
                  {followup.artifacts.map((a) => (
                    <button
                      type="button"
                      key={a.name}
                      aria-pressed={artifact?.name === a.name}
                      onClick={() => setOutput(a.name)}
                    >
                      <strong>{a.displayName ?? a.name}</strong>
                      <small>{a.purpose ?? uiText("尚未填写用途")}</small>
                      <span>
                        {mountLabel(
                          followupMounts.find((m) => m.channel === a.channel)
                            ?.mount ?? "story",
                        )}
                      </span>
                    </button>
                  ))}
                  {!readonly && (
                    <button
                      type="button"
                      onClick={() => {
                        let suffix = followup.artifacts.length + 1;
                        while (
                          followup.artifacts.some(
                            (a) => a.name === `output_${suffix}`,
                          ) ||
                          structure.mounts.some(
                            (m) =>
                              m.channel === `${followup.id}.output_${suffix}`,
                          )
                        )
                          suffix++;
                        const a = newPresetArtifact(
                          `${followup.id}.output_${suffix}`,
                          `output_${suffix}`,
                        );
                        onResourceEdit({
                          type: "add-artifact",
                          requestId: followup.id,
                          artifact: a,
                        });
                        setOutput(a.name);
                      }}
                    >
                      {uiText("＋ 新增产物")}
                    </button>
                  )}
                </div>
                {!readonly && (
                  <details>
                    <summary>
                      {uiText("JavaScript 示例 · 新建独立产物")}
                    </summary>
                    <p>
                      {uiText("新建示例不会覆盖现有资源，不会授予脚本许可。")}
                    </p>
                    {(["actions", "card"] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => {
                          const example = createPresetScriptExample(
                            kind,
                            followup.id,
                          );
                          onResourceEdit({
                            type: "add-artifact",
                            requestId: followup.id,
                            ...example,
                            mount:
                              kind === "actions" ? "composer_above" : "story",
                          });
                          setOutput(example.artifact.name);
                        }}
                      >
                        {kind === "actions"
                          ? uiText("新建行动按钮示例")
                          : uiText("新建场景卡片示例")}
                      </button>
                    ))}
                  </details>
                )}
                <details>
                  <summary>{uiText("AI 如何提交这些产物")}</summary>
                  <p>
                    {uiText(
                      "同一次后置模型响应，分别调用 artifact_emit；output 指定产物，payload 提交数据。不为每个产物另发请求。提交名自动分配，友好名称修改不改变绑定。",
                    )}
                  </p>
                  {followup.artifacts.map((a) => (
                    <div key={a.name}>
                      <strong>
                        {a.name} → {a.displayName ?? a.name}
                      </strong>
                      <p>{a.purpose}</p>
                      <code>{`artifact_emit({"output":${JSON.stringify(a.name)},"payload":${a.contentType === "application/json" ? "<JSON>" : '"<text>"'}})`}</code>
                    </div>
                  ))}
                </details>
                {artifact && (
                  <fieldset
                    disabled={readonly}
                    className="preset-output-fields"
                  >
                    <legend>{artifact.displayName ?? artifact.name}</legend>
                    <div className="preset-inline">
                      {[-1, 1].map((delta) => (
                        <button
                          type="button"
                          key={delta}
                          disabled={
                            followup.artifacts.indexOf(artifact) + delta < 0 ||
                            followup.artifacts.indexOf(artifact) + delta >=
                              followup.artifacts.length
                          }
                          onClick={() =>
                            updateFollowup((f) => {
                              const artifacts = [...f.artifacts];
                              const from = artifacts.findIndex(
                                (a) => a.name === artifact.name,
                              );
                              artifacts.splice(
                                from + delta,
                                0,
                                ...artifacts.splice(from, 1),
                              );
                              return { ...f, artifacts };
                            })
                          }
                        >
                          {delta === -1
                            ? uiText("产物前移")
                            : uiText("产物后移")}
                        </button>
                      ))}
                    </div>
                    {tab === "outputs" ? (
                      <>
                        <label>
                          {uiText("产物名称")}
                          <input
                            aria-label={uiText("产物名称")}
                            maxLength={160}
                            value={artifact.displayName ?? artifact.name}
                            onChange={(e) =>
                              updateArtifact({
                                ...artifact,
                                displayName: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          {uiText("生成内容用途")}
                          <textarea
                            aria-label={uiText("生成内容用途")}
                            maxLength={16000}
                            value={artifact.purpose ?? ""}
                            onChange={(e) =>
                              updateArtifact({
                                ...artifact,
                                purpose: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          {uiText("orchestration.output.displayPosition")}
                          <MountSelect
                            ariaLabel={uiText("orchestration.output.position")}
                            value={
                              followupMounts.find(
                                (m) => m.channel === artifact.channel,
                              )?.mount ?? ""
                            }
                            allowNone
                            onChange={(mount) =>
                              onChange((s) => ({
                                ...s,
                                mounts: [
                                  ...s.mounts.filter(
                                    (m) => m.channel !== artifact.channel,
                                  ),
                                  ...(mount
                                    ? [{ channel: artifact.channel, mount }]
                                    : []),
                                ],
                              }))
                            }
                          />
                        </label>
                        <PresetDisplayEditor
                          value={artifact}
                          files={builtin?.files ?? files}
                          onWrite={onWrite}
                          onEdit={(edit) =>
                            onResourceEdit({
                              type: "display",
                              target: {
                                kind: "artifact",
                                requestId: followup.id,
                                output: artifact.name,
                              },
                              edit,
                            })
                          }
                        />
                      </>
                    ) : (
                      <ArtifactAdvancedEditor
                        artifact={artifact}
                        onChange={updateArtifact}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        onResourceEdit({
                          type: "remove-artifact",
                          requestId: followup.id,
                          output: artifact.name,
                        })
                      }
                    >
                      {uiText("移除此产物")}
                    </button>
                  </fieldset>
                )}
                {tab === "advanced" && (
                  <label>
                    {uiText("orchestration.followup.maxTotalBytes")}
                    <input
                      type="number"
                      readOnly={readonly}
                      min={1}
                      max={1048576}
                      value={followup.maxArtifactBytes}
                      onChange={(e) =>
                        updateFollowup((f) => ({
                          ...f,
                          maxArtifactBytes: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                )}
              </>
            )}
            {isBuiltinExtensionFollowupId(followup.id) &&
            selectedItem?.enabled === false ? (
              <p>{uiText("启用此项后可预览样例。")}</p>
            ) : (
              preview(followup.id, artifact?.name)
            )}
          </>
        )}
      </div>
    ) : undefined;
  return (
    <OrderedPlayPromptEditor
      mergeConsecutiveMessages={structure.mergeConsecutiveMessages ?? true}
      onMergeConsecutiveMessagesChange={(mergeConsecutiveMessages) =>
        onChange((s) => ({ ...s, mergeConsecutiveMessages }))
      }
      entries={
        (authoring ? structure.authorPrompts : structure.playPrompts) ?? []
      }
      authoring={authoring}
      initialPromptId={initialPromptId}
      modelConnection={modelConnection}
      onEditModelConnection={onEditModelConnection}
      onChange={(entries) =>
        onChange((s) => ({
          ...s,
          [authoring ? "authorPrompts" : "playPrompts"]: entries,
        }))
      }
      promptPreview={promptPreview}
      onSelectPrompt={() => setSelection(undefined)}
      onFocusPrompt={onFocusPrompt}
      entryDetails={entryDetails}
      {...(!authoring ? { directory, detail } : {})}
    />
  );
}
function ArtifactAdvancedEditor({
  artifact,
  onChange,
}: {
  artifact: PlayPresetArtifactDefinition;
  onChange: (a: PlayPresetArtifactDefinition) => void;
}) {
  return (
    <>
      <label>
        {uiText("内容格式")}
        <select
          aria-label={uiText("内容格式")}
          value={artifact.contentType}
          onChange={(e) => {
            const next = {
              ...artifact,
              contentType: e.target
                .value as PlayPresetArtifactDefinition["contentType"],
            };
            if (next.contentType !== "application/json")
              delete next.payloadContract;
            onChange(next);
          }}
        >
          {["text/markdown", "text/plain", "application/json", "text/html"].map(
            (type) => (
              <option key={type} value={type}>
                {artifactOptionLabel(type)}
              </option>
            ),
          )}
        </select>
      </label>
      {artifact.contentType === "application/json" && (
        <>
          <p>
            {uiText(
              "约定字段、类型与必填项。要求会说明给模型，提交时由应用校验；不为模型开启 JSON 输出模式，不保证模型合法输出，也不自动往返修复。",
            )}
          </p>
          <label>
            {uiText("此产物的数据格式要求（JSON）")}
            <textarea
              rows={12}
              value={
                typeof artifact.payloadContract === "string"
                  ? artifact.payloadContract
                  : JSON.stringify(artifact.payloadContract ?? {}, null, 2)
              }
              onChange={(e) => {
                let contract: Record<string, unknown>;
                try {
                  contract = JSON.parse(e.target.value) as Record<
                    string,
                    unknown
                  >;
                } catch {
                  contract = e.target.value as unknown as Record<
                    string,
                    unknown
                  >;
                }
                onChange({ ...artifact, payloadContract: contract });
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const next = { ...artifact };
              delete next.payloadContract;
              onChange(next);
            }}
          >
            {uiText("移除格式要求")}
          </button>
        </>
      )}
      {(
        [
          [
            "strategy",
            uiText("更新方式"),
            ["replace", "append", "upsert", "transient", "hidden"],
          ],
          ["save", uiText("保存范围"), ["commit", "operation", "none"]],
          [
            "invalidation",
            uiText("清空条件"),
            [
              "explicit_clear",
              "new_operation",
              "head_change",
              "operation_end",
              "never",
            ],
          ],
        ] as const
      ).map(([key, label, options]) => (
        <label key={key}>
          {label}
          <select
            aria-label={label}
            value={artifact[key]}
            onChange={(e) => onChange({ ...artifact, [key]: e.target.value })}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {artifactOptionLabel(o)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p>
        {uiText(
          "更新方式决定同一产物如何合并：替换只留最新一份，追加保留多份，按标识更新只替换同标识的内容。保存范围、清空条件和生成期间显示的限制共同决定何时可见；关闭世界中的扩展仍会隐藏产物，清空指令仍可清除它。",
        )}
      </p>
      {artifact.strategy === "upsert" && (
        <label>
          {uiText("更新标识（相同标识覆盖旧内容）")}
          <input
            value={artifact.key ?? ""}
            onChange={(e) => onChange({ ...artifact, key: e.target.value })}
          />
        </label>
      )}
      <label>
        {uiText("orchestration.output.maxEmits")}
        <input
          type="number"
          min={1}
          value={artifact.maxEmits}
          onChange={(e) =>
            onChange({ ...artifact, maxEmits: Number(e.target.value) })
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={artifact.required}
          onChange={(e) =>
            onChange({ ...artifact, required: e.target.checked })
          }
        />
        {uiText("AI 必须生成此产物")}
      </label>
    </>
  );
}
