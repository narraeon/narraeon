import type { WorkspaceNavigationProtection } from "./WorkspaceLocation.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { gameplayLabel, type Gameplay } from "../protocol/gameplay.ts";
import type {
  ProtagonistTemplate,
  ProtagonistTemplatesView,
} from "../protocol/protagonistTemplates.ts";
import { ProtagonistTemplateManager } from "./ProtagonistTemplateManager.tsx";
import type { ContentTreeFile } from "../protocol/v1.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { getWebLocale, uiText } from "./i18n.ts";
import { StoryMarkdown } from "./StoryMarkdown.tsx";
import { StorySourceCopy } from "./StorySourceCopy.tsx";

export function CreateWorldScreen({
  client,
  titleRef,
  packages,
  selectedId,
  selectedTemplateId,
  pending,
  modelConfigured,
  onSelect,
  onTemplateSelect,
  onCreate,
  onEdit,
  onConfigureModel,
  onNavigationProtectionChange,
}: {
  client: Pick<RuntimeClient, "request">;
  titleRef?: (title: HTMLHeadingElement | null) => void;
  packages: readonly {
    localId: string;
    title: string;
    gameplay: Gameplay;
    status: "usable" | "needs_repair";
  }[];
  selectedId: string;
  selectedTemplateId: string;
  pending: boolean;
  modelConfigured: boolean;
  onSelect: (id: string) => void;
  onTemplateSelect: (id: string) => void;
  onCreate: (template?: ProtagonistTemplate) => void;
  onEdit: (opener: HTMLButtonElement) => void;
  onConfigureModel: () => void;
  onNavigationProtectionChange?: (
    protection: WorkspaceNavigationProtection,
  ) => void;
}): React.JSX.Element {
  const [templates, setTemplates] = useState<ProtagonistTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [managingTemplates, setManagingTemplates] = useState(false);
  const manageTemplatesButton = useRef<HTMLButtonElement>(null);
  const {
    target: templateTarget,
    syncFailed: templatesFailed,
    syncError: templatesError,
  } = useReadTarget(
    useCallback(
      () =>
        client.request<ProtagonistTemplatesView>({
          type: "protagonist-templates.read",
        }),
      [client],
    ),
    useCallback((view: ProtagonistTemplatesView) => {
      setTemplates(view.templates);
      setTemplatesLoading(false);
    }, []),
  );
  useEffect(() => {
    void templateTarget.read().finally(() => setTemplatesLoading(false));
  }, [templateTarget]);
  const selected = packages.find(({ localId }) => localId === selectedId);
  const selectedTemplate = templates.find(
    ({ id }) => id === selectedTemplateId,
  );
  const templatePending =
    selectedTemplateId !== "" && (templatesLoading || templatesFailed);
  useEffect(() => {
    if (
      selectedTemplateId !== "" &&
      !templatePending &&
      selectedTemplate === undefined
    )
      onTemplateSelect("");
  }, [onTemplateSelect, selectedTemplateId, selectedTemplate, templatePending]);
  const [preview, setPreview] = useState<{
    packageId: string;
    opening: string;
  } | null>(null);
  const {
    target: openingTarget,
    syncFailed: openingFailed,
    syncError: openingError,
  } = useReadTarget(
    useCallback(
      () =>
        client.request<{ files: ContentTreeFile[] }>({
          type: "content.read",
          packageId: selectedId,
        }),
      [client, selectedId],
    ),
    useCallback(
      ({ files }: { files: ContentTreeFile[] }) =>
        setPreview({
          packageId: selectedId,
          opening:
            files.find(({ path }) => path === "opening.md")?.contents ?? "",
        }),
      [selectedId],
    ),
  );
  useEffect(() => {
    if (selectedId) void openingTarget.read();
  }, [openingTarget, selectedId]);

  return (
    <main className="create-world-screen">
      <aside>
        <h1 ref={titleRef} tabIndex={titleRef === undefined ? undefined : -1}>
          {uiText("新建世界")}
        </h1>
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
              {selected === undefined && (
                <option value="" disabled>
                  {uiText("请选择内容包")}
                </option>
              )}
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
            value={selectedTemplate?.id ?? ""}
            disabled={pending || templatesLoading}
            onChange={(event) => onTemplateSelect(event.currentTarget.value)}
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
          ref={manageTemplatesButton}
          type="button"
          disabled={pending || templatesLoading || templatesFailed}
          onClick={() => setManagingTemplates(true)}
        >
          {uiText("管理主角模板")}
        </button>
        <SyncNotice
          failed={templatesFailed}
          reason={templatesError}
          onRead={() => void templateTarget.recover()}
        />
        {selected?.status === "needs_repair" && (
          <p role="status">{uiText("内容包需要修复后才能创建世界。")}</p>
        )}
        {!modelConfigured && (
          <>
            <small>
              {uiText("可以先创建世界并阅读开场，发送行动时再配置模型连接。")}
            </small>
            <button type="button" disabled={pending} onClick={onConfigureModel}>
              {uiText("配置模型连接")}
            </button>
          </>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={pending || selected?.status !== "usable" || templatePending}
          onClick={() => onCreate(selectedTemplate)}
        >
          {pending ? uiText("正在创建世界…") : uiText("从当前内容包创建")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={(event) => onEdit(event.currentTarget)}
        >
          {uiText(selected === undefined ? "新建内容包" : "编辑这份内容包")}
        </button>
        <small>{uiText("新世界独立保存，之后的游玩不会修改源内容包。")}</small>
      </aside>
      <article aria-label={uiText("开场白预览")}>
        <header>
          <span>{uiText("开场白")}</span>
          {preview?.packageId === selectedId && preview.opening ? (
            <StorySourceCopy
              key={preview.packageId}
              className="create-world-opening-copy"
              text={preview.opening}
            />
          ) : null}
        </header>
        {selected === undefined ? null : (
          <div className="create-world-preview-title">
            <h2>{selected.title}</h2>
            <p className="create-world-gameplay">
              {gameplayLabel(selected.gameplay, getWebLocale())}
            </p>
          </div>
        )}
        <SyncNotice
          failed={openingFailed}
          reason={openingError}
          onRead={() => void openingTarget.recover()}
        />
        {preview?.packageId === selectedId ? (
          preview.opening ? (
            <StoryMarkdown
              className="create-world-opening"
              text={preview.opening}
            />
          ) : (
            <p className="create-world-opening">
              {uiText("这份内容包还没有开场白。")}
            </p>
          )
        ) : selected !== undefined ? (
          <p role="status">{uiText("正在读取开场白…")}</p>
        ) : null}
      </article>
      {managingTemplates && (
        <ProtagonistTemplateManager
          client={client}
          templates={templates}
          opener={manageTemplatesButton}
          onChange={(view) => {
            templateTarget.accept();
            setTemplates(view.templates);
          }}
          onClose={() => setManagingTemplates(false)}
          {...(onNavigationProtectionChange === undefined
            ? {}
            : { onNavigationProtectionChange })}
        />
      )}
    </main>
  );
}
