import { useEffect, useState } from "react";
import { gameplayLabel, type Gameplay } from "../protocol/gameplay.ts";
import type {
  ProtagonistTemplate,
  ProtagonistTemplatesView,
} from "../protocol/protagonistTemplates.ts";
import { ProtagonistTemplateManager } from "./ProtagonistTemplateManager.tsx";
import type { ContentTreeFile } from "../protocol/v1.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { getWebLocale, uiText } from "./i18n.ts";

export function CreateWorldScreen({
  client,
  packages,
  selectedId,
  pending,
  modelConfigured,
  onSelect,
  onCreate,
  onEdit,
  onConfigureModel,
  onNavigationLockChange,
}: {
  client: Pick<RuntimeClient, "request">;
  packages: readonly {
    localId: string;
    title: string;
    gameplay: Gameplay;
    status: "usable" | "needs_repair";
  }[];
  selectedId: string;
  pending: boolean;
  modelConfigured: boolean;
  onSelect: (id: string) => void;
  onCreate: (template?: ProtagonistTemplate) => void;
  onEdit: () => void;
  onConfigureModel: () => void;
  onNavigationLockChange?: (locked: boolean) => void;
}): React.JSX.Element {
  const [templates, setTemplates] = useState<ProtagonistTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesFailure, setTemplatesFailure] = useState("");
  const [templateRead, setTemplateRead] = useState(0);
  const [managingTemplates, setManagingTemplates] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .request<ProtagonistTemplatesView>({ type: "protagonist-templates.read" })
      .then((view) => {
        if (active) {
          setTemplates(view.templates);
          setTemplatesFailure("");
        }
      })
      .catch((error: unknown) => {
        if (active)
          setTemplatesFailure(
            error instanceof Error ? error.message : uiText("主角模板读取失败"),
          );
      })
      .finally(() => {
        if (active) setTemplatesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, templateRead]);
  const selected = packages.find(({ localId }) => localId === selectedId);
  const [preview, setPreview] = useState<{
    packageId: string;
    opening: string;
    failure: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (selectedId !== "") {
      void client
        .request<{ files: ContentTreeFile[] }>({
          type: "content.read",
          packageId: selectedId,
        })
        .then(({ files }) => {
          if (active)
            setPreview({
              packageId: selectedId,
              failure: "",
              opening:
                files.find(({ path }) => path === "opening.md")?.contents ?? "",
            });
        })
        .catch((error: unknown) => {
          if (active)
            setPreview({
              packageId: selectedId,
              opening: "",
              failure:
                error instanceof Error
                  ? error.message
                  : uiText("内容包读取失败"),
            });
        });
    }
    return () => {
      active = false;
    };
  }, [client, selectedId]);

  return (
    <main className="create-world-screen">
      <aside>
        <h1>{uiText("新建世界")}</h1>
        <p>{uiText("选择一份内容包，从它的开场开始。")}</p>
        {packages.length === 0 ? (
          <p>{uiText("先新建或导入一份内容包。")}</p>
        ) : (
          <label>
            {uiText("内容包")}
            <select
              aria-label={uiText("创建世界的内容包")}
              value={selectedId}
              disabled={pending}
              onChange={(event) => onSelect(event.currentTarget.value)}
            >
              {packages.map((item) => (
                <option key={item.localId} value={item.localId}>
                  {`${item.title} · ${gameplayLabel(item.gameplay, getWebLocale())}`}
                  {item.status === "needs_repair" ? uiText(" · 需要修复") : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {uiText("主角模板")}
          <select
            aria-label={uiText("主角模板")}
            value={templateId}
            disabled={pending || templatesLoading}
            onChange={(event) => setTemplateId(event.currentTarget.value)}
          >
            <option value="">{uiText("不使用")}</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={pending || templatesLoading || templatesFailure !== ""}
          onClick={() => setManagingTemplates(true)}
        >
          {uiText("管理主角模板")}
        </button>
        {templatesFailure && (
          <p role="alert">
            {templatesFailure}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setTemplatesLoading(true);
                setTemplateRead((value) => value + 1);
              }}
            >
              {uiText("重新读取主角模板")}
            </button>
          </p>
        )}
        {selected?.status === "needs_repair" && (
          <p role="status">{uiText("内容包需要修复后才能创建世界。")}</p>
        )}
        {!modelConfigured && (
          <button type="button" disabled={pending} onClick={onConfigureModel}>
            {uiText("配置模型连接")}
          </button>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={
            pending || !modelConfigured || selected?.status !== "usable"
          }
          onClick={() =>
            onCreate(templates.find(({ id }) => id === templateId))
          }
        >
          {pending ? uiText("正在创建世界…") : uiText("从当前内容包创建")}
        </button>
        <button type="button" disabled={pending} onClick={onEdit}>
          {uiText(selected === undefined ? "新建内容包" : "完善这份内容包")}
        </button>
        <small>{uiText("新世界独立保存，之后的游玩不会修改源内容包。")}</small>
      </aside>
      <article aria-label={uiText("开场白预览")}>
        <span>{uiText("开场白")}</span>
        <h2>{selected?.title}</h2>
        {selected === undefined ? null : (
          <p className="create-world-gameplay">
            {gameplayLabel(selected.gameplay, getWebLocale())}
          </p>
        )}
        {preview?.packageId === selectedId && preview.failure ? (
          <p role="alert">{preview.failure}</p>
        ) : preview?.packageId === selectedId ? (
          <p className="create-world-opening">
            {preview.opening || uiText("这份内容包还没有开场白。")}
          </p>
        ) : selected !== undefined ? (
          <p role="status">{uiText("正在读取开场白…")}</p>
        ) : null}
      </article>
      {managingTemplates && (
        <ProtagonistTemplateManager
          client={client}
          templates={templates}
          onChange={(view) => {
            setTemplates(view.templates);
            if (!view.templates.some(({ id }) => id === templateId))
              setTemplateId("");
          }}
          onClose={() => setManagingTemplates(false)}
          {...(onNavigationLockChange === undefined
            ? {}
            : { onNavigationLockChange })}
        />
      )}
    </main>
  );
}
