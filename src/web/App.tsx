import { useEffect, useRef, useState } from "react";

import { maxPortableContentArchiveBytes } from "../protocol/contentTree.ts";
import type { ModelConnectionLibraryView } from "../protocol/modelConnections.ts";
import {
  defaultAppReadingPreferences,
  type AppLocale,
  type AppPreferences,
} from "../protocol/appPreferences.ts";
import type {
  ContentTreeFile,
  V1SettingImprovementHistoryItem,
  V1SettingImprovementOverview,
  V1SettingImprovementStatus,
} from "../protocol/v1.ts";
import { firstPartyPlayPresetTemplatesForLocale } from "../shared/first-party-play-preset-templates.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { createClientId } from "./ClientId.ts";
import { setWebLocale, uiText } from "./i18n.ts";
import type { ContentTreeIssue } from "./ContentTreeEditor.tsx";
import { HomeScreen } from "./HomeScreen.tsx";
import { ModelConnectionScreen } from "./ModelConnectionScreen.tsx";
import { PlayPresetScreen } from "./PlayPresetScreen.tsx";
import { PromptPreviewScreen } from "./PromptPreviewScreen.tsx";
import {
  SettingImprovementPanel,
  type SettingImprovementView,
} from "./SettingImprovementPanel.tsx";
import { WorldPage } from "./WorldPage.tsx";

interface Workspace {
  preferences: AppPreferences;
  contentPackages: PackageSummary[];
  playPresets: PlayPresetLibrary;
  worlds: { worldId: string; title: string }[];
  storageNotices: { surface: string; message: string }[];
  model: ModelConnectionLibraryView;
}

interface PlayPresetLibrary {
  currentPresetId: string;
  presets: {
    id: string;
    name: string;
    revision: string;
    files: Record<string, string>;
    validation: { status: "valid" } | { status: "invalid"; message: string };
  }[];
}

interface PackageSummary {
  localId: string;
  title: string;
  status: "usable" | "needs_repair";
  files?: ContentTreeFile[];
}

interface PackageDetail extends PackageSummary {
  files: ContentTreeFile[];
  issues: ContentTreeIssue[];
}

type Screen =
  "home" | "content" | "plays" | "model" | "create" | "preview" | "world";
export function App({ client }: { client: RuntimeClient }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [selected, setSelected] = useState<string>("");
  const [files, setFiles] = useState<ContentTreeFile[]>([]);
  const [currentPackageFiles, setCurrentPackageFiles] = useState<
    ContentTreeFile[]
  >([]);
  const [packageDetail, setPackageDetail] = useState<PackageDetail | null>(
    null,
  );
  const [filesDirty, setFilesDirty] = useState(false);
  const [playPresetDraftDirty, setPlayPresetDraftDirty] = useState(false);
  const [modelDraftDirty, setModelDraftDirty] = useState(false);
  const [promptPreviewPlayPreset, setPromptPreviewPlayPreset] = useState<{
    presetId: string;
    revision: string;
  } | null>(null);
  const [importArchive, setImportArchive] = useState<File | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [improvementView, setImprovementView] =
    useState<SettingImprovementView | null>(null);
  const [improvementHistory, setImprovementHistory] = useState<
    V1SettingImprovementHistoryItem[]
  >([]);
  const [improvementHistoryView, setImprovementHistoryView] =
    useState<SettingImprovementView | null>(null);
  const [improvementStartingFresh, setImprovementStartingFresh] =
    useState(false);
  const [improvementHistoryLoading, setImprovementHistoryLoading] =
    useState(false);
  const [improvementLoading, setImprovementLoading] = useState(false);
  const [improvementRequestFailure, setImprovementRequestFailure] = useState<
    string | null
  >(null);
  const [improvementNow, setImprovementNow] = useState(0);
  const [worldId, setWorldId] = useState("");
  const [notice, setNotice] = useState(uiText("正在读取工作区…"));
  const [localeSaving, setLocaleSaving] = useState(false);
  const packageOpenRequest = useRef(0);
  const improvementPollScope = useRef(0);
  const improvementHistoryRequest = useRef(0);
  const improvementSelection = useRef<
    | string
    | {
        kind: "fresh";
        previousSessionId: string | null;
        requestStarted: boolean;
      }
    | null
  >(null);

  async function refresh(): Promise<void> {
    const next = await client.request<Workspace>({ type: "workspace.read" });
    setWebLocale(next.preferences.locale);
    setWorkspace(next);
    setSelected((current) =>
      next.contentPackages.some(({ localId }) => localId === current)
        ? current
        : (next.contentPackages[0]?.localId ?? ""),
    );
    setNotice("");
  }

  // Poll a lightweight status projection. Full transcripts are fetched only
  // when durable conversation history changes; live Provider deltas overlay
  // the currently selected conversation without resending content files.
  useEffect(() => {
    if (screen !== "content" || selected === "") return;
    let active = true;
    let pollPending = false;
    let loadedRevision = "";
    const pollScope = improvementPollScope.current;
    const poll = async (): Promise<void> => {
      if (pollPending) return;
      pollPending = true;
      const historyRequestVersion = improvementHistoryRequest.current;
      try {
        const status = await client.request<V1SettingImprovementStatus>({
          type: "setting-improvement.status",
          packageId: selected,
          ...(typeof improvementSelection.current === "string"
            ? { sessionId: improvementSelection.current }
            : {}),
        });
        if (
          !active ||
          improvementPollScope.current !== pollScope ||
          improvementHistoryRequest.current !== historyRequestVersion
        )
          return;
        if (status.revision !== loadedRevision) {
          const next = await client.request<V1SettingImprovementOverview>({
            type: "setting-improvement.overview",
            packageId: selected,
          });
          if (
            !active ||
            improvementPollScope.current !== pollScope ||
            improvementHistoryRequest.current !== historyRequestVersion
          )
            return;
          setImprovementView(next.latest);
          setImprovementHistory(next.history);
          const selectedSessionId = improvementSelection.current;
          if (
            typeof selectedSessionId === "string" &&
            selectedSessionId !== next.latest?.sessionId
          ) {
            const selectedView = await client.request<SettingImprovementView>({
              type: "setting-improvement.session.read",
              packageId: selected,
              sessionId: selectedSessionId,
            });
            if (
              !active ||
              improvementPollScope.current !== pollScope ||
              improvementHistoryRequest.current !== historyRequestVersion
            )
              return;
            setImprovementHistoryView(selectedView);
          } else if (
            typeof selectedSessionId === "object" &&
            selectedSessionId !== null &&
            selectedSessionId.kind === "fresh" &&
            selectedSessionId.requestStarted &&
            next.latest !== null &&
            next.latest.sessionId !== selectedSessionId.previousSessionId
          ) {
            setImprovementHistoryView(null);
            setImprovementStartingFresh(false);
            improvementSelection.current = next.latest.sessionId;
          } else if (selectedSessionId === null) {
            setImprovementHistoryView(null);
            if (next.latest !== null)
              improvementSelection.current = next.latest.sessionId;
          }
          loadedRevision = status.revision;
        } else if (status.selected !== null) {
          const selectedStatus = status.selected;
          const overlay = (current: SettingImprovementView | null) =>
            current?.sessionId !== selectedStatus.sessionId
              ? current
              : {
                  ...current,
                  runStatus: selectedStatus.runStatus,
                  progress: selectedStatus.progress,
                };
          setImprovementView(overlay);
          setImprovementHistoryView(overlay);
        }
      } catch {
        // Keep the last authoritative snapshot when one poll fails.
      } finally {
        pollPending = false;
        if (active && improvementPollScope.current === pollScope) {
          setImprovementNow(Date.now());
          setImprovementLoading(false);
        }
      }
    };
    const initialPoll = window.setTimeout(() => {
      if (!active) return;
      setImprovementLoading(true);
      void poll();
    }, 0);
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(initialPoll);
      clearInterval(timer);
    };
  }, [client, screen, selected]);

  useEffect(() => {
    let active = true;
    void client
      .request<Workspace>({ type: "workspace.read" })
      .then((next) => {
        if (!active) return;
        setWebLocale(next.preferences.locale);
        setWorkspace(next);
        setSelected(next.contentPackages[0]?.localId ?? "");
        setNotice("");
      })
      .catch((error: unknown) => {
        if (active)
          setNotice(
            error instanceof Error ? error.message : uiText("工作区读取失败"),
          );
      });
    return () => {
      active = false;
    };
  }, [client]);

  async function saveLocale(locale: AppLocale): Promise<void> {
    if (workspace === null || localeSaving) return;
    setLocaleSaving(true);
    try {
      const preferences = await client.request<AppPreferences>({
        type: "preferences.save",
        locale,
      });
      setWebLocale(preferences.locale);
      await refresh();
      setNotice(uiText("界面语言已保存。"));
    } catch (error: unknown) {
      report(error);
    } finally {
      setLocaleSaving(false);
    }
  }

  async function openPackage(packageId: string): Promise<void> {
    const requestVersion = packageOpenRequest.current + 1;
    packageOpenRequest.current = requestVersion;
    improvementHistoryRequest.current += 1;
    try {
      const package_ = await client.request<PackageDetail>({
        type: "content.read",
        packageId,
      });
      if (packageOpenRequest.current !== requestVersion) return;
      if (packageId !== selected) improvementPollScope.current += 1;
      const packageFiles = package_.files;
      setSelected(packageId);
      setPackageDetail(package_);
      setCurrentPackageFiles(packageFiles.map((file) => ({ ...file })));
      setImprovementView(null);
      setImprovementHistory([]);
      setImprovementHistoryView(null);
      setImprovementStartingFresh(false);
      improvementSelection.current = null;
      setImprovementHistoryLoading(false);
      setImprovementRequestFailure(null);
      setFiles(packageFiles.map((file) => ({ ...file })));
      setFilesDirty(false);
      setScreen("content");
    } catch (error: unknown) {
      if (packageOpenRequest.current === requestVersion) report(error);
    }
  }

  async function savePackage(): Promise<void> {
    try {
      const saved = await client.request<PackageDetail>({
        type: "content.replace",
        packageId: selected,
        files,
      });
      setPackageDetail(saved);
      setFiles(saved.files.map((file) => ({ ...file })));
      setCurrentPackageFiles(saved.files.map((file) => ({ ...file })));
      setFilesDirty(false);
      await refresh();
      setNotice(uiText("内容包当前树已整批保存。"));
    } catch (error: unknown) {
      report(error);
    }
  }

  async function createPackage(): Promise<void> {
    try {
      const created = await client.request<PackageSummary>({
        type: "content.create",
      });
      await refresh();
      await openPackage(created.localId);
    } catch (error: unknown) {
      report(error);
    }
  }

  async function contentCommand(
    type: "content.copy" | "content.delete",
  ): Promise<void> {
    try {
      await client.request({ type, packageId: selected });
      await refresh();
      setScreen("home");
    } catch (error: unknown) {
      report(error);
    }
  }

  async function renamePackage(title: string): Promise<void> {
    try {
      await client.request({
        type: "content.rename",
        packageId: selected,
        name: title,
      });
      await refresh();
      setNotice(uiText("内容包已重命名。"));
    } catch (error: unknown) {
      report(error);
    }
  }

  async function importPackage(): Promise<void> {
    if (importArchive === null || importPending) return;
    if (importArchive.size > maxPortableContentArchiveBytes) {
      setNotice(uiText("内容包 ZIP 自身大小超过安全上限。"));
      return;
    }
    setImportPending(true);
    try {
      const archiveBase64 = await readFileAsBase64(importArchive);
      const imported = await client.request<PackageSummary>({
        type: "content.import",
        archiveBase64,
        title: contentPackageTitleFromArchiveName(importArchive.name),
      });
      setImportArchive(null);
      await refresh();
      await openPackage(imported.localId);
      setNotice(uiText("ZIP 内容包已导入为新的本地身份。"));
    } catch (error: unknown) {
      report(error);
    } finally {
      setImportPending(false);
    }
  }

  async function exportPackage(): Promise<void> {
    try {
      const exported = await client.request<{
        fileName: string;
        base64: string;
      }>({ type: "content.export", packageId: selected });
      const bytes = Uint8Array.from(atob(exported.base64), (character) =>
        character.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      report(error);
    }
  }

  async function sendImprovement(message: string): Promise<void> {
    if (filesDirty) {
      const error = new Error(uiText("请先保存文件编辑，再继续 AI 设定完善。"));
      report(error);
      throw error;
    }
    setImprovementRequestFailure(null);
    setNotice("");
    if (
      improvementStartingFresh &&
      typeof improvementSelection.current === "object" &&
      improvementSelection.current !== null
    )
      improvementSelection.current = {
        ...improvementSelection.current,
        requestStarted: true,
      };
    const selectedConversation = improvementStartingFresh
      ? null
      : (improvementHistoryView ?? improvementView);
    try {
      const next = await client.request<SettingImprovementView>({
        type: "setting-improvement.message",
        packageId: selected,
        requestId: createClientId("setting-message"),
        message,
        continuation:
          selectedConversation === null
            ? { kind: "fresh_context" }
            : {
                kind: "continue_context",
                sessionId: selectedConversation.sessionId,
              },
      });
      setImprovementView(next);
      setImprovementHistoryView(null);
      setImprovementStartingFresh(false);
      improvementSelection.current = next.sessionId;
      try {
        const package_ = await client.request<PackageDetail>({
          type: "content.read",
          packageId: selected,
        });
        setPackageDetail(package_);
        setFiles(package_.files.map((file) => ({ ...file })));
        setCurrentPackageFiles(package_.files.map((file) => ({ ...file })));
        await refresh();
      } catch (refreshError: unknown) {
        report(refreshError);
      }
    } catch (error: unknown) {
      setImprovementRequestFailure(
        error instanceof Error ? error.message : uiText("操作失败"),
      );
      report(error);
      throw error;
    }
  }

  async function cancelImprovement(): Promise<void> {
    const selectedConversation = improvementStartingFresh
      ? null
      : (improvementHistoryView ?? improvementView);
    if (selectedConversation === null) return;
    setImprovementRequestFailure(null);
    try {
      const next = await client.request<SettingImprovementView>({
        type: "setting-improvement.cancel",
        sessionId: selectedConversation.sessionId,
      });
      if (improvementHistoryView === null) setImprovementView(next);
      else setImprovementHistoryView(next);
    } catch (error: unknown) {
      setImprovementRequestFailure(
        error instanceof Error ? error.message : uiText("操作失败"),
      );
      report(error);
    }
  }

  async function selectImprovementSession(sessionId: string): Promise<void> {
    const requestVersion = improvementHistoryRequest.current + 1;
    improvementHistoryRequest.current = requestVersion;
    setImprovementStartingFresh(false);
    improvementSelection.current = sessionId;
    if (improvementView?.sessionId === sessionId) {
      setImprovementHistoryView(null);
      return;
    }
    setImprovementHistoryLoading(true);
    setImprovementRequestFailure(null);
    try {
      const historical = await client.request<SettingImprovementView>({
        type: "setting-improvement.session.read",
        packageId: selected,
        sessionId,
      });
      if (improvementHistoryRequest.current !== requestVersion) return;
      setImprovementHistoryView(historical);
    } catch (error: unknown) {
      if (improvementHistoryRequest.current !== requestVersion) return;
      setImprovementRequestFailure(
        error instanceof Error ? error.message : uiText("操作失败"),
      );
      report(error);
    } finally {
      if (improvementHistoryRequest.current === requestVersion)
        setImprovementHistoryLoading(false);
    }
  }

  async function deleteImprovementSession(sessionId: string): Promise<void> {
    const selectedSessionId = improvementStartingFresh
      ? null
      : (improvementHistoryView?.sessionId ??
        improvementView?.sessionId ??
        null);
    const deletingSelected = selectedSessionId === sessionId;
    const previousSelection = improvementSelection.current;
    improvementHistoryRequest.current += 1;
    if (deletingSelected) improvementSelection.current = null;
    setImprovementHistoryLoading(true);
    setImprovementRequestFailure(null);
    try {
      const next = await client.request<V1SettingImprovementOverview>({
        type: "setting-improvement.session.delete",
        packageId: selected,
        sessionId,
      });
      improvementHistoryRequest.current += 1;
      setImprovementView(next.latest);
      setImprovementHistory(next.history);
      if (improvementStartingFresh) {
        setImprovementHistoryView(null);
        improvementSelection.current = {
          kind: "fresh",
          previousSessionId: next.latest?.sessionId ?? null,
          requestStarted: false,
        };
      } else if (deletingSelected) {
        setImprovementHistoryView(null);
        improvementSelection.current = next.latest?.sessionId ?? null;
      } else if (
        typeof previousSelection === "string" &&
        next.history.some(({ sessionId: id }) => id === previousSelection)
      ) {
        improvementSelection.current = previousSelection;
        if (next.latest?.sessionId === previousSelection)
          setImprovementHistoryView(null);
      } else {
        setImprovementHistoryView(null);
        improvementSelection.current = next.latest?.sessionId ?? null;
      }
      setNotice(uiText("对话历史已删除；内容包当前树没有回滚。"));
    } catch (error: unknown) {
      improvementHistoryRequest.current += 1;
      improvementSelection.current = previousSelection;
      const message =
        error instanceof Error ? error.message : uiText("操作失败");
      setImprovementRequestFailure(message);
      report(error);
      throw error;
    } finally {
      setImprovementHistoryLoading(false);
    }
  }

  function startFreshImprovementContext(): void {
    const selectedConversation = improvementHistoryView ?? improvementView;
    if (selectedConversation?.runStatus === "running") return;
    improvementHistoryRequest.current += 1;
    setImprovementHistoryLoading(false);
    setImprovementHistoryView(null);
    setImprovementStartingFresh(true);
    improvementSelection.current = {
      kind: "fresh",
      previousSessionId:
        improvementView?.sessionId ?? improvementHistory[0]?.sessionId ?? null,
      requestStarted: false,
    };
    setImprovementRequestFailure(null);
  }

  function openPromptPreview(target?: {
    presetId: string;
    revision: string;
  }): void {
    setPromptPreviewPlayPreset(target ?? null);
    if (workspace?.model.configured !== true) {
      setScreen("model");
      setNotice(uiText("请先保存并启用一份模型配置。"));
      return;
    }
    setScreen("preview");
  }

  async function createWorld(): Promise<void> {
    if (workspace?.model.configured !== true) {
      setScreen("model");
      setNotice(uiText("请先保存并启用一份模型配置。"));
      return;
    }
    try {
      const created = await client.request<{ world: { worldId: string } }>({
        type: "world.create",
        operationId: createClientId("create"),
        packageId: selected,
        model: modelBinding(),
      });
      await refresh();
      openWorld(created.world.worldId);
    } catch (error: unknown) {
      report(error);
    }
  }

  function modelBinding() {
    const connection = workspace?.model.connections.find(
      ({ id }) => id === workspace.model.activeConnectionId,
    );
    if (connection === undefined)
      return {
        provider: "chat_completions" as const,
        modelId: "",
        contextWindowTokens: 0,
        maxOutputTokens: 0,
      };
    return {
      provider: connection.provider,
      modelId: connection.modelId,
      contextWindowTokens: connection.contextWindowTokens,
      maxOutputTokens: connection.maxOutputTokens,
    };
  }

  function openWorld(id: string): void {
    setWorldId(id);
    setScreen("world");
  }

  async function renameWorld(worldId: string, name: string): Promise<void> {
    await client.request({
      type: "world.rename",
      worldId,
      name,
    });
    await refresh();
    setNotice(uiText("世界已重命名为“{name}”。", { name }));
  }

  async function deleteWorld(world: {
    worldId: string;
    title: string;
  }): Promise<void> {
    if (
      !globalThis.confirm(
        uiText(
          "删除世界“{title}”？它的全部提交、历史和存档都会从本机移除，且无法撤销。",
          { title: world.title },
        ),
      )
    )
      return;
    try {
      await client.request({ type: "world.delete", worldId: world.worldId });
      await refresh();
      setNotice(uiText("世界已从本机删除。"));
    } catch (error: unknown) {
      report(error);
    }
  }

  function report(error: unknown): void {
    setNotice(error instanceof Error ? error.message : uiText("操作失败"));
  }

  if (workspace === null)
    return (
      <main className="center-card" role="status">
        {notice}
      </main>
    );

  const selectedPackage = workspace.contentPackages.find(
    ({ localId }) => localId === selected,
  );
  const selectedPackageDetail =
    packageDetail?.localId === selected ? packageDetail : null;
  const displayedImprovementView = improvementStartingFresh
    ? null
    : (improvementHistoryView ?? improvementView);
  const improvementActive = displayedImprovementView?.runStatus === "running";
  const selectedWorld = workspace.worlds.find(
    (world) => world.worldId === worldId,
  );
  const activeModel = workspace.model.connections.find(
    ({ id }) => id === workspace.model.activeConnectionId,
  );
  const currentPresetName =
    workspace.playPresets.presets.find(
      ({ id }) => id === workspace.playPresets.currentPresetId,
    )?.name ?? null;

  if (screen === "world")
    return (
      <WorldPage
        key={worldId}
        client={client}
        worldId={worldId}
        worldTitle={selectedWorld?.title ?? uiText("未命名世界")}
        modelConfigured={workspace.model.configured}
        onBack={() => setScreen("home")}
        onConfigureModel={() => setScreen("model")}
        onRenameWorld={(name) => renameWorld(worldId, name)}
        initialReadingPreferences={
          workspace.preferences.reading ?? defaultAppReadingPreferences
        }
        onOpenWorld={async (nextWorldId) => {
          await refresh();
          setWorldId(nextWorldId);
        }}
      />
    );

  if (screen === "content")
    return (
      <SettingImprovementPanel
        packageName={selectedPackage?.title ?? selected}
        modelConfigured={workspace.model.configured}
        hasUnsavedFileDraft={filesDirty}
        loading={improvementLoading || improvementHistoryLoading}
        view={displayedImprovementView}
        history={improvementHistory}
        latestSessionId={
          improvementView?.sessionId ?? improvementHistory[0]?.sessionId ?? null
        }
        notice={notice}
        requestFailure={improvementRequestFailure}
        now={improvementNow}
        contentEditor={{
          files,
          status:
            selectedPackageDetail?.status ??
            selectedPackage?.status ??
            "needs_repair",
          issues: selectedPackageDetail?.issues ?? [],
          dirty: filesDirty,
          onFilesChange: (nextFiles) => {
            setFiles(nextFiles);
            setFilesDirty(true);
          },
          onSave: () => void savePackage(),
          onReset: () => {
            setFiles(currentPackageFiles.map((file) => ({ ...file })));
            setFilesDirty(false);
            setNotice(uiText("已放弃未保存修改；内容包当前树未改变。"));
          },
          onCopy: () => void contentCommand("content.copy"),
          onExport: () => void exportPackage(),
          onDelete: () => void contentCommand("content.delete"),
          title: selectedPackage?.title ?? selected,
          onRename: (name) => void renamePackage(name),
        }}
        onSend={sendImprovement}
        onCancel={cancelImprovement}
        onFreshContext={startFreshImprovementContext}
        onSelectSession={selectImprovementSession}
        onDeleteSession={deleteImprovementSession}
        onConfigureModel={() => setScreen("model")}
        onBack={() => setScreen("home")}
      />
    );

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">{uiText("Narraeon · 本地优先")}</p>
          <h1>{uiText("世界工作区")}</h1>
          {screen === "home" && (
            <p className="workspace-header-copy">
              {uiText("创作内容包，连接 AI 主持，让每个世界独立演化。")}
            </p>
          )}
        </div>
        <div className="workspace-header-actions">
          <label className="workspace-locale-picker">
            <span>{uiText("界面语言")}</span>
            <select
              aria-label={uiText("界面语言")}
              value={workspace.preferences.locale}
              disabled={localeSaving}
              onChange={(event) =>
                void saveLocale(event.target.value as AppLocale)
              }
            >
              <option value="en">English</option>
              <option value="zh-CN">{uiText("简体中文")}</option>
            </select>
          </label>
          <button
            className="workspace-model-button secondary-button"
            aria-label={uiText("模型连接")}
            disabled={
              filesDirty ||
              improvementActive ||
              playPresetDraftDirty ||
              modelDraftDirty ||
              importPending
            }
            onClick={() => setScreen("model")}
          >
            <span
              className={`workspace-model-dot ${workspace.model.configured ? "is-ready" : "needs-attention"}`}
              aria-hidden="true"
            />
            <span>
              <small>{uiText("模型连接")}</small>
              <strong>{activeModel?.name ?? uiText("尚未配置")}</strong>
            </span>
          </button>
          {screen !== "home" && (
            <button
              className="secondary-button"
              disabled={
                filesDirty ||
                improvementActive ||
                playPresetDraftDirty ||
                modelDraftDirty ||
                importPending
              }
              onClick={() => setScreen("home")}
            >
              {uiText("返回工作区")}
            </button>
          )}
        </div>
      </header>
      {(notice || workspace.storageNotices.length > 0) && (
        <div className="workspace-feedback">
          {notice && <p role="status">{notice}</p>}
          {workspace.storageNotices.map((item) => (
            <p role="alert" key={item.surface}>
              {item.message}
            </p>
          ))}
        </div>
      )}
      {screen === "home" && (
        <HomeScreen
          contentPackages={workspace.contentPackages}
          worlds={workspace.worlds}
          selectedPackageId={selected}
          modelConfigured={workspace.model.configured}
          activeModelName={activeModel?.name ?? null}
          currentPresetName={currentPresetName}
          importArchive={importArchive}
          importPending={importPending}
          onImportArchiveChange={(archive) => {
            setImportArchive(archive);
            setNotice("");
          }}
          onEditContent={() =>
            selectedPackage === undefined
              ? void createPackage()
              : void openPackage(selectedPackage.localId)
          }
          onOpenPlayPresets={() => setScreen("plays")}
          onCreateWorld={() => setScreen("create")}
          onOpenPreview={openPromptPreview}
          onCreatePackage={() => void createPackage()}
          onImportPackage={() => void importPackage()}
          onOpenPackage={(packageId) => void openPackage(packageId)}
          onOpenWorld={openWorld}
          onRenameWorld={(world, name) =>
            void renameWorld(world.worldId, name).catch(report)
          }
          onDeleteWorld={(world) => void deleteWorld(world)}
        />
      )}
      {screen === "plays" && (
        <PlayPresetScreen
          client={client}
          initialLibrary={workspace.playPresets}
          recommendedTemplates={firstPartyPlayPresetTemplatesForLocale(
            workspace.preferences.locale,
          )}
          onLibraryChange={(playPresets) =>
            setWorkspace((current) =>
              current === null ? current : { ...current, playPresets },
            )
          }
          onDirtyChange={setPlayPresetDraftDirty}
          renderPromptPreview={(target) => (
            <PromptPreviewScreen
              key={`${target.presetId}:${target.revision}`}
              embedded
              client={client}
              packages={workspace.contentPackages}
              initialPackageId={selected}
              playPresets={workspace.playPresets}
              model={workspace.model}
              onPackageSelect={setSelected}
              playPresetTarget={target}
            />
          )}
        />
      )}
      {screen === "model" && (
        <ModelConnectionScreen
          client={client}
          library={workspace.model}
          onLibraryChange={(model) =>
            setWorkspace((current) =>
              current === null ? current : { ...current, model },
            )
          }
          onNotice={setNotice}
          onDirtyChange={setModelDraftDirty}
        />
      )}
      {screen === "create" && (
        <section className="panel-card">
          <h2>{uiText("新建世界")}</h2>
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {workspace.contentPackages.map((item) => (
              <option key={item.localId} value={item.localId}>
                {item.title}
              </option>
            ))}
          </select>
          <button disabled={!selected} onClick={() => void createWorld()}>
            {uiText("从当前内容包创建")}
          </button>
        </section>
      )}
      {screen === "preview" && (
        <PromptPreviewScreen
          client={client}
          packages={workspace.contentPackages}
          initialPackageId={selected}
          playPresets={workspace.playPresets}
          model={workspace.model}
          onPackageSelect={setSelected}
          {...(promptPreviewPlayPreset === null
            ? {}
            : { playPresetTarget: promptPreviewPlayPreset })}
        />
      )}
    </main>
  );
}

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(
        reader.error ?? new Error("Unable to read the content package ZIP"),
      ),
    );
    reader.addEventListener("abort", () =>
      reject(new Error("Reading the content package ZIP was cancelled")),
    );
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The content package ZIP read result is invalid"));
        return;
      }
      const marker = ";base64,";
      const markerIndex = reader.result.indexOf(marker);
      if (markerIndex < 0) {
        reject(
          new Error("The content package ZIP could not be encoded for upload"),
        );
        return;
      }
      resolve(reader.result.slice(markerIndex + marker.length));
    });
    reader.readAsDataURL(file);
  });
}

function contentPackageTitleFromArchiveName(fileName: string): string {
  const normalized = fileName
    .replace(/\.zip$/iu, "")
    .replace(/[\r\n]+/gu, " ")
    .trim();
  const limited = Array.from(normalized).slice(0, 160).join("");
  return limited.length > 0 ? limited : uiText("导入的内容包");
}
