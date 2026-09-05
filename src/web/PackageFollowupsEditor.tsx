import { useState } from "react";
import { parseDocument, stringify } from "yaml";
import type { ContentTreeFile } from "../protocol/v1.ts";
import { FollowupListEditor } from "./FollowupListEditor.tsx";
import { FollowupResourcesEditor } from "./FollowupResourcesEditor.tsx";
import {
  ArtifactDefinitionEditor,
  type PlayPresetFollowupDefinition,
} from "./PlayPresetScreen.tsx";
import { uiText } from "./i18n.ts";

type PackageRequest = PlayPresetFollowupDefinition & {
  enabled: boolean;
  mount:
    | "story"
    | "sidebar"
    | "composer_above"
    | "composer_below"
    | "overlay"
    | "debug";
};
const declarationPath = "control/followups.yaml";

/** Edits the same current tree as the document workbench, including a locked world revision. */
export function PackageFollowupsEditor({
  files,
  onChange,
}: {
  files: readonly ContentTreeFile[];
  onChange: (files: ContentTreeFile[]) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const parsed = readEditor(files);
  const resources = Object.fromEntries(
    files
      .filter(
        (file) =>
          file.path.startsWith("control/") && file.encoding === undefined,
      )
      .map((file) => [file.path.slice(8), file.contents]),
  );
  function save(
    requests: PackageRequest[],
    writes: Record<string, string> = {},
  ): void {
    const replacements = {
      ...Object.fromEntries(
        Object.entries(writes).map(([path, body]) => [`control/${path}`, body]),
      ),
      [declarationPath]: stringify(
        {
          format: "narraeon.package-followups/v1",
          followups: requests.map(({ prompt, ...request }) => ({
            ...request,
            prompt: { role: prompt.role, markdown: prompt.path },
          })),
        },
        { aliasDuplicateObjects: false },
      ),
    };
    onChange([
      ...files.filter((file) => !(file.path in replacements)),
      ...Object.entries(replacements).map(([path, contents]) => ({
        path,
        contents,
      })),
    ]);
  }
  function update(
    id: string,
    change: (request: PackageRequest) => PackageRequest,
    writes: Record<string, string> = {},
  ): void {
    if (parsed.kind === "valid")
      save(
        parsed.requests.map((request) =>
          request.id === id ? change(request) : request,
        ),
        writes,
      );
  }
  return (
    <section className="package-followups-editor">
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {uiText("内容包后置请求")}
      </button>
      {open ? (
        parsed.kind === "invalid" ? (
          <p role="alert">
            {uiText("后置声明无法编辑，请在文件编辑中修复后重试。")}
          </p>
        ) : (
          <>
            <p>
              {uiText(
                "主剧情完成后按此顺序生成额外内容。关闭保留提示和资源；创建世界后独立保存，后续修改需通过世界修订应用。",
              )}
            </p>
            <button
              type="button"
              onClick={() => {
                const id = `followup_${crypto.randomUUID().replaceAll("-", "")}`;
                const path = `prompts/${id}.md`;
                save(
                  [
                    ...parsed.requests,
                    {
                      id,
                      displayName: uiText("新后置请求"),
                      enabled: true,
                      mount: "story",
                      prompt: { role: "author_instruction", path },
                      artifacts: [newArtifact("output_1", `${id}.output_1`)],
                      maxArtifactBytes: 32768,
                    },
                  ],
                  {
                    [path]: uiText(
                      "根据已完成的剧情，通过 artifact_emit 输出 output_1。",
                    ),
                  },
                );
              }}
            >
              {uiText("新增包后置请求")}
            </button>
            <FollowupListEditor
              definitions={parsed.requests}
              items={parsed.requests.map((request) => ({
                id: request.id,
                kind: "user",
                enabled: request.enabled,
              }))}
              onItemsChange={(items) =>
                save(
                  items.map((item) => ({
                    ...parsed.requests.find(
                      (request) => request.id === item.id,
                    )!,
                    enabled: item.enabled,
                  })),
                )
              }
              onClone={() => undefined}
              renderUser={(request) => {
                const current = parsed.requests.find(
                  (item) => item.id === request.id,
                )!;
                return (
                  <article className="play-preset-followup-card">
                    <label>
                      {uiText("包请求名称")}
                      <input
                        value={current.displayName}
                        onChange={(event) =>
                          update(current.id, (request) => ({
                            ...request,
                            displayName: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      {uiText("包请求提示词")}
                      <textarea
                        rows={6}
                        value={resources[current.prompt.path] ?? ""}
                        onChange={(event) =>
                          update(current.id, (request) => request, {
                            [current.prompt.path]: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      {uiText("包请求显示位置")}
                      <select
                        value={current.mount}
                        onChange={(event) =>
                          update(current.id, (request) => ({
                            ...request,
                            mount: event.target
                              .value as PackageRequest["mount"],
                          }))
                        }
                      >
                        <option value="story">{uiText("故事正文")}</option>
                        <option value="sidebar">{uiText("侧栏")}</option>
                        <option value="composer_above">
                          {uiText("输入框上方")}
                        </option>
                        <option value="composer_below">
                          {uiText("输入框下方")}
                        </option>
                        <option value="overlay">{uiText("浮层")}</option>
                        <option value="debug">{uiText("调试区")}</option>
                      </select>
                    </label>
                    {current.artifacts.map((artifact, index) => (
                      <section key={index}>
                        <ArtifactDefinitionEditor
                          artifact={artifact}
                          files={resources}
                          mount={current.mount}
                          onChange={(change) =>
                            update(current.id, (request) => ({
                              ...request,
                              artifacts: request.artifacts.map((entry, at) =>
                                at === index ? change(entry) : entry,
                              ),
                            }))
                          }
                          onRemove={() =>
                            update(current.id, (request) => ({
                              ...request,
                              artifacts: request.artifacts.filter(
                                (_, at) => at !== index,
                              ),
                            }))
                          }
                        />
                        <FollowupResourcesEditor
                          files={resources}
                          renderer={artifact.renderer}
                          scripts={artifact.scripts}
                          assets={artifact.assets}
                          onWrite={(path, body) =>
                            update(current.id, (request) => request, {
                              [path]: body,
                            })
                          }
                          onAttach={(kind, path, body) =>
                            update(
                              current.id,
                              (request) => ({
                                ...request,
                                artifacts: request.artifacts.map((entry, at) =>
                                  at !== index
                                    ? entry
                                    : {
                                        ...entry,
                                        ...(kind === "renderer"
                                          ? {
                                              renderer: path,
                                              rendererRevision: "v1",
                                            }
                                          : {
                                              [kind]: [
                                                ...(entry[kind] ?? []),
                                                path,
                                              ],
                                            }),
                                      },
                                ),
                              }),
                              { [path]: body },
                            )
                          }
                        />
                      </section>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        let number = current.artifacts.length + 1;
                        while (
                          current.artifacts.some(
                            (item) => item.name === `output_${number}`,
                          )
                        )
                          number++;
                        const name = `output_${number}`;
                        update(current.id, (request) => ({
                          ...request,
                          artifacts: [
                            ...request.artifacts,
                            newArtifact(name, `${request.id}.${name}`),
                          ],
                        }));
                      }}
                    >
                      {uiText("新增产物")}
                    </button>
                    <details>
                      <summary>{uiText("高级请求设置")}</summary>
                      <label>
                        {uiText("稳定请求身份")}
                        <input readOnly value={current.id} />
                      </label>
                      <label>
                        {uiText("产物字节上限")}
                        <input
                          type="number"
                          min={1}
                          value={current.maxArtifactBytes}
                          onChange={(event) =>
                            update(current.id, (request) => ({
                              ...request,
                              maxArtifactBytes: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                    </details>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={() =>
                        save(
                          parsed.requests.filter(
                            (request) => request.id !== current.id,
                          ),
                        )
                      }
                    >
                      {uiText("删除请求")}
                    </button>
                  </article>
                );
              }}
            />
          </>
        )
      ) : null}
    </section>
  );
}

function newArtifact(
  name: string,
  channel: string,
): PackageRequest["artifacts"][number] {
  return {
    name,
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

/** UI shape guard only; the Runtime performs full semantic and resource validation on save. */
function readEditor(
  files: readonly ContentTreeFile[],
): { kind: "valid"; requests: PackageRequest[] } | { kind: "invalid" } {
  const source = files.find((file) => file.path === declarationPath);
  if (source === undefined) return { kind: "valid", requests: [] };
  try {
    if (source.encoding !== undefined) throw new Error("Binary declaration");
    const doc = parseDocument(source.contents, { uniqueKeys: true });
    if (doc.errors.length) throw new Error("Invalid YAML");
    const raw: unknown = doc.toJS({ maxAliasCount: 0 });
    if (
      !record(raw) ||
      raw.format !== "narraeon.package-followups/v1" ||
      !Array.isArray(raw.followups) ||
      Object.keys(raw).some((key) => !["format", "followups"].includes(key))
    )
      throw new Error("Invalid declaration");
    const requests = raw.followups.map((entry: unknown): PackageRequest => {
      if (
        !record(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.displayName !== "string" ||
        typeof entry.enabled !== "boolean" ||
        typeof entry.mount !== "string" ||
        ![
          "story",
          "sidebar",
          "composer_above",
          "composer_below",
          "overlay",
          "debug",
        ].includes(entry.mount) ||
        !record(entry.prompt) ||
        typeof entry.prompt.markdown !== "string" ||
        typeof entry.prompt.role !== "string" ||
        Object.keys(entry.prompt).some(
          (key) => !["role", "markdown"].includes(key),
        ) ||
        (entry.maxArtifactBytes !== undefined &&
          (typeof entry.maxArtifactBytes !== "number" ||
            !Number.isSafeInteger(entry.maxArtifactBytes))) ||
        !Array.isArray(entry.artifacts)
      )
        throw new Error("Invalid request");
      const artifacts = entry.artifacts.map((artifact: unknown) => {
        if (
          !record(artifact) ||
          typeof artifact.name !== "string" ||
          typeof artifact.channel !== "string" ||
          typeof artifact.strategy !== "string" ||
          [
            "renderer",
            "rendererRevision",
            "regex",
            "key",
            "contentType",
            "save",
            "invalidation",
            "rendererMode",
          ].some(
            (key) =>
              artifact[key] !== undefined && typeof artifact[key] !== "string",
          ) ||
          (artifact.required !== undefined &&
            typeof artifact.required !== "boolean") ||
          (artifact.maxEmits !== undefined &&
            typeof artifact.maxEmits !== "number") ||
          ["scripts", "assets"].some(
            (key) =>
              artifact[key] !== undefined &&
              (!Array.isArray(artifact[key]) ||
                !artifact[key].every(
                  (path: unknown) => typeof path === "string",
                )),
          )
        )
          throw new Error("Invalid artifact");
        const save = artifact.save ?? "operation";
        return {
          contentType: "text/plain",
          rendererMode: "document",
          save,
          invalidation:
            save === "commit"
              ? "head_change"
              : save === "operation"
                ? "operation_end"
                : "explicit_clear",
          required: false,
          maxEmits: 1,
          ...artifact,
        } as PackageRequest["artifacts"][number];
      });
      return {
        ...entry,
        id: entry.id,
        displayName: entry.displayName,
        enabled: entry.enabled,
        mount: entry.mount as PackageRequest["mount"],
        prompt: { role: entry.prompt.role, path: entry.prompt.markdown },
        artifacts,
        maxArtifactBytes:
          typeof entry.maxArtifactBytes === "number"
            ? entry.maxArtifactBytes
            : 32768,
      };
    });
    if (new Set(requests.map((request) => request.id)).size !== requests.length)
      throw new Error("Duplicate identity");
    return { kind: "valid", requests };
  } catch {
    return { kind: "invalid" };
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
