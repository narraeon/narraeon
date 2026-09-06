import { createPresetScriptExample } from "./preset-script-examples.ts";
import { useState, type ReactNode } from "react";
import { OrderedPlayPromptEditor } from "./OrderedPlayPromptEditor.tsx";
import {
  defaultFollowupItems,
  builtinFollowupExample,
  type FollowupItem,
} from "../shared/ordered-followups.ts";
import { getWebLocale } from "./i18n.ts";
import type {
  PlayPresetStructuredEditor,
  PlayPresetFollowupDefinition,
  PlayPresetArtifactDefinition,
} from "./PlayPresetScreen.tsx";
import { PlayerViewPanelsEditor } from "./PlayerViewPanelsEditor.tsx";
import { PresetDisplayEditor } from "./PresetDisplayEditor.tsx";
import { MountSelect } from "./PlayPresetEditorControls.tsx";
import { mountLabel } from "./playPresetEditorLabels.ts";

const t = (cn: string, en: string) => (getWebLocale() === "zh-CN" ? cn : en);
export function PresetWorkbenchEditor({
  structure,
  files,
  authoring,
  onChange,
  onWrite,
  preview,
  promptPreview,
}: {
  structure: PlayPresetStructuredEditor;
  files: Record<string, string>;
  authoring: boolean;
  onChange: (
    update: (s: PlayPresetStructuredEditor) => PlayPresetStructuredEditor,
  ) => void;
  onWrite: (path: string, body: string) => void;
  promptPreview?: ReactNode;
  preview: (requestId?: string, output?: string) => ReactNode;
}) {
  const [selection, setSelection] = useState<{
    kind: "followup" | "panel";
    id: string;
  }>();
  const [tab, setTab] = useState("prompt");
  const [output, setOutput] = useState("");
  const items =
    structure.followupItems ?? defaultFollowupItems(structure.followups);
  const example = builtinFollowupExample(getWebLocale());
  const selectedItem = items.find((i) => i.id === selection?.id);
  const followup: PlayPresetFollowupDefinition | undefined =
    selectedItem?.kind === "builtin"
      ? example.definition
      : structure.followups.find((f) => f.id === selection?.id);
  const panel = structure.playerViewPanels.find((p) => p.id === selection?.id);
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
  function addFollowup(clone?: PlayPresetFollowupDefinition, body?: string) {
    const id = `request_${crypto.randomUUID().replaceAll("-", "")}`;
    const path = `prompts/${id}.md`;
    onWrite(
      path,
      body ??
        t(
          "根据本轮已提交叙事，生成下面声明的界面产物。",
          "Generate the declared interface outputs from the settled narrative.",
        ),
    );
    // Clone a complete resource closure, preserving sharing within the clone only.
    const refs = new Map<string, string>();
    function copy(path: string) {
      let next = refs.get(path);
      if (!next) {
        const [dir] = path.split("/");
        next = `${dir}/${crypto.randomUUID()}-${path.split("/").at(-1)}`;
        refs.set(path, next);
      }
      return next;
    }
    const artifacts = clone
      ? clone.artifacts.map((a, i) => ({
          ...a,
          channel: `${id}.output_${i + 1}`,
          ...(a.renderer ? { renderer: copy(a.renderer) } : {}),
          ...(a.regex ? { regex: copy(a.regex) } : {}),
          ...(a.scripts ? { scripts: a.scripts.map(copy) } : {}),
          ...(a.assets ? { assets: a.assets.map(copy) } : {}),
        }))
      : [newArtifact(`${id}.output_1`, "output_1")];
    for (const [path, target] of refs) {
      let body = files[path] ?? "";
      for (const [source, replacement] of refs)
        body = body.replaceAll(source, replacement);
      onWrite(target, body);
    }
    onChange((s) => ({
      ...s,
      followups: [
        ...s.followups,
        {
          id,
          displayName: clone
            ? `${clone.displayName} ${t("副本", "copy")}`
            : t("新后置请求", "New follow-up"),
          prompt: { role: "author_instruction", path },
          artifacts,
          maxArtifactBytes: clone?.maxArtifactBytes ?? 32768,
        },
      ],
      followupItems: [
        ...(s.followupItems ?? defaultFollowupItems(s.followups)),
        { id, kind: "user", enabled: true },
      ],
      mounts: [
        ...s.mounts,
        ...artifacts.map((a, i) => ({
          channel: a.channel,
          mount:
            s.mounts.find((m) => m.channel === clone?.artifacts[i]?.channel)
              ?.mount ?? ("story" as const),
        })),
      ],
      extensionRefs: [...new Set([...s.extensionRefs, ...refs.values()])],
    }));
    setSelection({ kind: "followup", id });
    setTab("prompt");
  }
  function name(item: FollowupItem) {
    return item.kind === "builtin"
      ? example.definition.displayName
      : item.kind === "content-package"
        ? t("内容包后置组", "Content-package follow-ups")
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
          <span>{t("回复完成后", "After the reply")}</span>
          <button
            type="button"
            aria-label={t("新增后置请求", "Add follow-up request")}
            onClick={() => addFollowup()}
          >
            ＋
          </button>
        </header>
        <ol aria-label={t("后置请求", "Follow-up requests")}>
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
                    ? t("系统", "System")
                    : item.kind === "content-package"
                      ? t("内容包", "Package")
                      : t("用户", "User")}
                </small>
              </button>
              <input
                type="checkbox"
                aria-label={`${t("启用", "Enable")} ${name(item)}`}
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
          <span>{t("纯界面 · 不调用模型", "Interface · no model")}</span>
          <button
            type="button"
            aria-label={t("新增纯界面", "Add interface panel")}
            onClick={() => {
              const id = `panel_${crypto.randomUUID().replaceAll("-", "")}`;
              onChange((s) => ({
                ...s,
                playerViewPanels: [
                  ...s.playerViewPanels,
                  {
                    id,
                    source: { kind: "player_view", view: "status" },
                    channel: `player.view.${id}`,
                    key: "current",
                    mount: "sidebar",
                    rendererMode: "document",
                    config: {
                      title: t("世界状态栏", "World status"),
                      layout: "stack",
                      theme: "default",
                      empty: "message",
                      emptyMessage: t(
                        "当前没有可显示内容。",
                        "No content to display.",
                      ),
                      groups: [],
                    },
                  },
                ],
              }));
              setSelection({ kind: "panel", id });
            }}
          >
            ＋
          </button>
        </header>
        <ol>
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
    selection?.kind === "panel" && panel ? (
      <div className="preset-object-detail">
        <PlayerViewPanelsEditor
          panels={[panel]}
          files={files}
          onFileChange={onWrite}
          onChange={(panels) =>
            onChange((s) => ({
              ...s,
              playerViewPanels: s.playerViewPanels.flatMap((p) =>
                p.id === panel.id ? panels : [p],
              ),
              extensionRefs: [
                ...new Set([
                  ...s.extensionRefs,
                  ...panels.flatMap((p) =>
                    [
                      p.renderer,
                      p.regex,
                      ...(p.scripts ?? []),
                      ...(p.assets ?? []),
                    ].filter((p): p is string => p !== undefined),
                  ),
                ]),
              ],
            }))
          }
        />
        {preview()}
      </div>
    ) : selection?.kind === "followup" ? (
      <div className="preset-object-detail">
        <div className="preset-object-toolbar">
          <span>
            {t("回复完成后", "After the reply")} /{" "}
            {readonly
              ? t("系统 / 内容包", "System / package")
              : t("用户", "User")}
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
            <button
              type="button"
              onClick={() =>
                addFollowup(
                  followup,
                  readonly ? example.body : files[followup.prompt.path],
                )
              }
            >
              {t("克隆后置请求", "Clone follow-up")}
            </button>
          )}
          {!readonly && (
            <button
              type="button"
              onClick={() => {
                onChange((s) => ({
                  ...s,
                  followups: s.followups.filter((f) => f.id !== selection.id),
                  followupItems: items.filter((i) => i.id !== selection.id),
                }));
                setSelection(undefined);
              }}
            >
              {t("删除", "Delete")}
            </button>
          )}
        </div>
        {!followup ? (
          <>
            <h2>{t("内容包后置组", "Content-package follow-ups")}</h2>
            <p>
              {t(
                "在此位置展开当前世界的内容包后置请求。无声明时为空组，不调用模型；正文由内容包管理。",
                "The current world's follow-ups expand here. An empty group makes no model requests; edit definitions in the content package.",
              )}
            </p>
          </>
        ) : (
          <>
            <nav className="preset-detail-tabs">
              {[
                ["prompt", t("提示词", "Prompt")],
                ["outputs", t("界面产物", "Outputs")],
                ["advanced", t("高级设置", "Advanced")],
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
            {readonly && (
              <p>
                {t(
                  "系统示例完整只读；克隆后独立编辑。",
                  "The complete system example is read-only. Clone to edit independently.",
                )}
              </p>
            )}
            {tab === "prompt" ? (
              <div className="preset-manuscript">
                <label>
                  {t("后置请求名称", "Follow-up name")}
                  <input
                    aria-label={t("后置请求名称", "Follow-up name")}
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
                  {t("提示词", "Prompt")}
                  <textarea
                    aria-label={t(
                      "这次额外请求要做什么",
                      "What should this follow-up do?",
                    )}
                    rows={16}
                    readOnly={readonly}
                    value={
                      readonly
                        ? example.body
                        : (files[followup.prompt.path] ?? "")
                    }
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
                  {t("将产物引用加入提示词", "Insert output references")}
                </button>
              </div>
            ) : (
              <>
                <h2>
                  {tab === "outputs"
                    ? t("界面产物", "Interface outputs")
                    : t(
                        "此产物的数据格式要求",
                        "This output's data requirements",
                      )}
                </h2>
                <p>
                  {t(
                    "一条请求，可以生成多个界面产物。",
                    "One request can generate several interface outputs.",
                  )}
                </p>
                <div className="preset-output-cards">
                  {followup.artifacts.map((a) => (
                    <button
                      type="button"
                      key={a.name}
                      aria-pressed={artifact?.name === a.name}
                      onClick={() => setOutput(a.name)}
                    >
                      <strong>{a.displayName ?? a.name}</strong>
                      <small>
                        {a.purpose ?? t("尚未填写用途", "No purpose yet")}
                      </small>
                      <span>
                        {mountLabel(
                          structure.mounts.find((m) => m.channel === a.channel)
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
                        const a = newArtifact(
                          `${followup.id}.output_${suffix}`,
                          `output_${suffix}`,
                        );
                        onChange((s) => ({
                          ...s,
                          mounts: [
                            ...s.mounts,
                            { channel: a.channel, mount: "story" },
                          ],
                          followups: s.followups.map((f) =>
                            f.id === followup.id
                              ? { ...f, artifacts: [...f.artifacts, a] }
                              : f,
                          ),
                        }));
                        setOutput(a.name);
                      }}
                    >
                      {t("＋ 新增产物", "＋ Add output")}
                    </button>
                  )}
                </div>
                {!readonly && (
                  <details>
                    <summary>
                      {t(
                        "JavaScript 示例 · 新建独立产物",
                        "JavaScript examples · create independent output",
                      )}
                    </summary>
                    <p>
                      {t(
                        "新建示例不会覆盖现有资源，不会授予脚本许可。",
                        "Creates independent files without overwriting resources or granting script permission.",
                      )}
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
                          for (const [path, body] of Object.entries(
                            example.files,
                          ))
                            onWrite(path, body);
                          onChange((s) => ({
                            ...s,
                            followups: s.followups.map((f) =>
                              f.id === followup.id
                                ? {
                                    ...f,
                                    artifacts: [
                                      ...f.artifacts,
                                      example.artifact,
                                    ],
                                  }
                                : f,
                            ),
                            mounts: [
                              ...s.mounts,
                              {
                                channel: example.artifact.channel,
                                mount:
                                  kind === "actions"
                                    ? "composer_below"
                                    : "story",
                              },
                            ],
                            extensionRefs: [
                              ...s.extensionRefs,
                              ...Object.keys(example.files),
                            ],
                          }));
                          setOutput(example.artifact.name);
                        }}
                      >
                        {kind === "actions"
                          ? t(
                              "新建行动按钮示例",
                              "Create action button example",
                            )
                          : t("新建场景卡片示例", "Create scene card example")}
                      </button>
                    ))}
                  </details>
                )}
                <details>
                  <summary>
                    {t("AI 如何提交这些产物", "How AI submits these outputs")}
                  </summary>
                  <p>
                    {t(
                      "同一次后置模型响应，分别调用 artifact_emit；output 指定产物，payload 提交数据。不为每个产物另发请求。提交名自动分配，友好名称修改不改变绑定。",
                      "In the same follow-up response, call artifact_emit for each output. output selects the declaration; payload supplies data. No separate request per output. Renaming a display label preserves its stable submission name.",
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
                            ? t("产物前移", "Move output earlier")
                            : t("产物后移", "Move output later")}
                        </button>
                      ))}
                    </div>
                    {tab === "outputs" ? (
                      <>
                        <label>
                          {t("产物名称", "Output name")}
                          <input
                            aria-label={t("产物名称", "Output name")}
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
                          {t("生成内容用途", "Generation purpose")}
                          <textarea
                            aria-label={t("生成内容用途", "Generation purpose")}
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
                          {t("显示位置", "Display position")}
                          <MountSelect
                            ariaLabel={t("产物显示位置", "Output position")}
                            value={
                              structure.mounts.find(
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
                          files={files}
                          onWrite={onWrite}
                          onChange={(display) => {
                            const next = { ...artifact };
                            for (const key of [
                              "renderer",
                              "rendererRevision",
                              "regex",
                              "scripts",
                              "assets",
                            ] as const)
                              delete next[key];
                            updateArtifact({ ...next, ...display });
                            onChange((s) => ({
                              ...s,
                              extensionRefs: [
                                ...new Set([
                                  ...s.extensionRefs,
                                  ...[
                                    display.renderer,
                                    display.regex,
                                    ...(display.scripts ?? []),
                                    ...(display.assets ?? []),
                                  ].filter((p): p is string => p !== undefined),
                                ]),
                              ],
                            }));
                          }}
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
                        updateFollowup((f) => ({
                          ...f,
                          artifacts: f.artifacts.filter(
                            (a) => a.name !== artifact.name,
                          ),
                        }))
                      }
                    >
                      {t("移除此产物", "Remove output")}
                    </button>
                  </fieldset>
                )}
                {tab === "advanced" && (
                  <label>
                    {t(
                      "本次所有产物合计上限（bytes）",
                      "Total output byte limit",
                    )}
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
            {preview(followup.id, artifact?.name)}
          </>
        )}
      </div>
    ) : undefined;
  return (
    <OrderedPlayPromptEditor
      entries={
        (authoring ? structure.authorPrompts : structure.playPrompts) ?? []
      }
      authoring={authoring}
      onChange={(entries) =>
        onChange((s) => ({
          ...s,
          [authoring ? "authorPrompts" : "playPrompts"]: entries,
        }))
      }
      promptPreview={promptPreview}
      onSelectPrompt={() => setSelection(undefined)}
      {...(!authoring ? { directory, detail } : {})}
    />
  );
}
function newArtifact(
  channel: string,
  name: string,
): PlayPresetArtifactDefinition {
  return {
    name,
    displayName: t("新产物", "New output"),
    channel,
    strategy: "replace",
    contentType: "text/markdown",
    rendererMode: "document",
    save: "commit",
    invalidation: "explicit_clear",
    required: false,
    maxEmits: 1,
  };
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
        {t("内容格式", "Content format")}
        <select
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
              <option key={type}>{type}</option>
            ),
          )}
        </select>
      </label>
      {artifact.contentType === "application/json" && (
        <>
          <p>
            {t(
              "约定字段、类型与必填项。要求会说明给模型，提交前由 Runtime 校验；不启用 Provider JSON 模式，不保证模型合法输出，也不自动往返修复。",
              "Fields, types and required values are explained to the model and checked by Runtime before submission. This does not enable Provider JSON mode, guarantee valid output, or automatically repair responses.",
            )}
          </p>
          <label>
            {t(
              "此产物的数据格式要求（JSON）",
              "This output's data requirements (JSON)",
            )}
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
            {t("移除格式要求", "Remove requirements")}
          </button>
        </>
      )}
      {(
        [
          [
            "strategy",
            t("更新方式", "Update policy"),
            ["replace", "append", "upsert", "transient", "hidden"],
          ],
          ["save", t("保存到", "Save scope"), ["commit", "operation", "none"]],
          [
            "invalidation",
            t("何时清空", "Invalidation"),
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
            value={artifact[key]}
            onChange={(e) => onChange({ ...artifact, [key]: e.target.value })}
          >
            {options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      ))}
      {artifact.strategy === "upsert" && (
        <label>
          {t("更新 key（固定身份）", "Update key (fixed identity)")}
          <input
            value={artifact.key ?? ""}
            onChange={(e) => onChange({ ...artifact, key: e.target.value })}
          />
        </label>
      )}
      <label>
        {t("单次最多输出次数", "Maximum emits")}
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
        {t("AI 必须生成此产物", "Required output")}
      </label>
    </>
  );
}
