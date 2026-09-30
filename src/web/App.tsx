import { PackageScriptPermissionControl } from "./PackageScriptPermissionControl.tsx";
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
  V1SettingImprovementOverview,
} from "../protocol/v1.ts";
import { firstPartyPlayPresetTemplatesForLocale } from "../shared/first-party-play-preset-templates.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { createClientId } from "./ClientId.ts";
import { setWebLocale, uiText } from "./i18n.ts";
import type { ContentTreeIssue } from "./ContentTreeEditor.tsx";
import { WorkspaceHeader, type WorkspaceScreen } from "./WorkspaceHeader.tsx";
import { CreateWorldScreen } from "./CreateWorldScreen.tsx";
import { DismissibleNotice } from "./DismissibleNotice.tsx";
import { HomeScreen } from "./HomeScreen.tsx";
import { ModelConnectionScreen } from "./ModelConnectionScreen.tsx";
import { PlayPresetScreen } from "./PlayPresetScreen.tsx";
import { PromptPreviewScreen } from "./PromptPreviewScreen.tsx";
import { SettingImprovementPanel } from "./SettingImprovementPanel.tsx";
import { useAuthoringWorkspace } from "./useAuthoringWorkspace.ts";
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

type Screen = WorkspaceScreen;
export function App({ client }: { client: RuntimeClient }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [selected, setSelected] = useState<string>("");
  const [creatingWorld, setCreatingWorld] = useState(false);
  const creatingWorldRef = useRef(false);
  const [childNavigationLocked, setChildNavigationLocked] = useState(false);
  const [playPresetDraftDirty, setPlayPresetDraftDirty] = useState(false);
  const [modelDraftDirty, setModelDraftDirty] = useState(false);
  const [promptPreviewPlayPreset, setPromptPreviewPlayPreset] = useState<{
    presetId: string;
    revision: string;
  } | null>(null);
  const [importArchive, setImportArchive] = useState<File | null>(null);
  const [importPending, setImportPending] = useState(false);
  const { workspace: authoringWorkspace, state: authoring } =
    useAuthoringWorkspace(client, "setting", selected, screen === "content");
  const filesDirty = authoring.dirty;
  const files = authoring.files;
  const packageDetail = authoring.target?.packageDetail ?? null;
  const [worldId, setWorldId] = useState("");
  const [notice, setNotice] = useState(uiText("正在读取工作区…"));
  const [localeSaving, setLocaleSaving] = useState(false);
  const filesDirtyRef = useRef(filesDirty);
  filesDirtyRef.current = filesDirty;
  const packageOpenRequest = useRef(0);
  const navigationDraftLockedRef = useRef(false);
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

  useEffect(() => {
    let previous: typeof packageDetail = null;
    return authoringWorkspace.subscribe(() => {
      const detail = authoringWorkspace.getSnapshot().target?.packageDetail;
      if (detail === undefined || detail === previous) return;
      previous = detail;
      setWorkspace((current) =>
        current === null
          ? null
          : {
              ...current,
              contentPackages: current.contentPackages.map((item) =>
                item.localId === detail.localId ? { ...item, ...detail } : item,
              ),
            },
      );
    });
  }, [authoringWorkspace]);

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
    try {
      await client.request<PackageDetail>({
        type: "content.read",
        packageId,
      });
      if (packageOpenRequest.current !== requestVersion) return;
      if (navigationDraftLockedRef.current) {
        setNotice(uiText("已保留当前页面的未保存修改，请保存或放弃后再切换。"));
        return;
      }
      authoringWorkspace.close();
      setSelected(packageId);
      if (packageId === selected && screen === "content")
        void authoringWorkspace.open();
      setScreen("content");
    } catch (error: unknown) {
      if (packageOpenRequest.current === requestVersion) report(error);
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
    packageId = selected,
  ): Promise<void> {
    try {
      await client.request({ type, packageId });
      await refresh();
      authoringWorkspace.close();
      setScreen("home");
    } catch (error: unknown) {
      report(error);
    }
  }

  async function renamePackage(
    title: string,
    packageId = selected,
  ): Promise<void> {
    try {
      await client.request({
        type: "content.rename",
        packageId,
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
    authoringWorkspace.close();
    setScreen("preview");
  }

  async function createWorld(): Promise<void> {
    if (
      creatingWorldRef.current ||
      filesDirtyRef.current ||
      authoring.view?.runStatus === "running"
    )
      return;
    const source =
      packageDetail?.localId === selected
        ? packageDetail
        : workspace?.contentPackages.find(
            ({ localId }) => localId === selected,
          );
    if (
      source?.status !== "usable" ||
      (screen === "content" && authoring.loading)
    )
      return;
    if (workspace?.model.configured !== true) {
      setScreen("model");
      setNotice(uiText("请先保存并启用一份模型配置。"));
      return;
    }
    creatingWorldRef.current = true;
    setCreatingWorld(true);
    const packageId = selected;
    const model = modelBinding();
    try {
      const authoring = await client.request<V1SettingImprovementOverview>({
        type: "setting-improvement.overview",
        packageId,
      });
      if (
        authoring.latest?.runStatus === "running" ||
        authoring.history.some((session) => session.runStatus === "running")
      ) {
        setNotice(uiText("这份内容包正在完善，请在回复完成后创建世界。"));
        return;
      }
      const created = await client.request<{ world: { worldId: string } }>({
        type: "world.create",
        operationId: createClientId("create"),
        packageId,
        model,
      });
      await refresh();
      openWorld(created.world.worldId);
    } catch (error: unknown) {
      report(error);
    } finally {
      creatingWorldRef.current = false;
      setCreatingWorld(false);
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
    packageOpenRequest.current += 1;
    authoringWorkspace.close();
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
  const displayedImprovementView = authoring.view;
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

  const navigationLocked =
    filesDirty ||
    improvementActive ||
    playPresetDraftDirty ||
    modelDraftDirty ||
    importPending ||
    creatingWorld ||
    childNavigationLocked;
  navigationDraftLockedRef.current =
    filesDirty ||
    playPresetDraftDirty ||
    modelDraftDirty ||
    childNavigationLocked ||
    improvementActive;
  function navigate(next: Screen): void {
    if (navigationLocked) return;
    if (next !== "content" || next === screen) packageOpenRequest.current += 1;
    if (next === screen) return;
    if (next === "content") {
      if (selectedPackage === undefined) void createPackage();
      else void openPackage(selectedPackage.localId);
    } else if (next === "preview") openPromptPreview();
    else {
      authoringWorkspace.close();
      setScreen(next);
    }
  }

  const worldContent =
    screen === "world" ? (
      <WorldPage
        showWorkspaceBack={false}
        key={worldId}
        client={client}
        worldId={worldId}
        worldTitle={selectedWorld?.title ?? uiText("未命名世界")}
        modelConfigured={workspace.model.configured}
        onBack={() => navigate("home")}
        onConfigureModel={() => navigate("model")}
        onNavigationLockChange={setChildNavigationLocked}
        onRenameWorld={(name) => renameWorld(worldId, name)}
        initialReadingPreferences={
          workspace.preferences.reading ?? defaultAppReadingPreferences
        }
        onOpenWorld={async (nextWorldId) => {
          await refresh();
          setWorldId(nextWorldId);
        }}
      />
    ) : null;

  const authoringContent =
    screen === "content" ? (
      <SettingImprovementPanel
        showWorkspaceBack={false}
        key={selected}
        onPreview={() => authoringWorkspace.preview()}
        packageName={selectedPackage?.title ?? selected}
        modelConfigured={workspace.model.configured}
        hasUnsavedFileDraft={filesDirty}
        loading={authoring.loading || creatingWorld}
        onCreateWorld={() => void createWorld()}
        onNavigationLockChange={setChildNavigationLocked}
        view={displayedImprovementView}
        history={authoring.target?.history ?? []}
        latestSessionId={
          authoring.target?.latest?.sessionId ??
          authoring.target?.history[0]?.sessionId ??
          null
        }
        notice={notice || authoring.notice}
        requestFailure={
          authoring.requestFailure ?? authoring.observationFailure
        }
        now={authoring.now}
        contentEditor={{
          scriptPermission: (
            <PackageScriptPermissionControl
              key={selected}
              client={client}
              kind="content"
              id={selected}
              dirty={filesDirty}
            />
          ),
          files,
          status:
            selectedPackageDetail?.status ??
            selectedPackage?.status ??
            "needs_repair",
          issues: selectedPackageDetail?.issues ?? [],
          dirty: filesDirty,
          onFilesChange: (nextFiles) => authoringWorkspace.editFiles(nextFiles),
          onSave: () => {
            setNotice("");
            void authoringWorkspace.saveFiles();
          },
          onReset: () => {
            setNotice("");
            authoringWorkspace.resetFiles();
          },
          onCopy: () => void contentCommand("content.copy"),
          onExport: () => void exportPackage(),
          onDelete: () => void contentCommand("content.delete"),
          title: selectedPackage?.title ?? selected,
          onRename: (name) => void renamePackage(name),
        }}
        onSend={(message) => {
          setNotice("");
          return authoringWorkspace.send(message);
        }}
        onCancel={() => authoringWorkspace.cancel()}
        onFreshContext={() => authoringWorkspace.startFresh()}
        onSelectSession={(id) => authoringWorkspace.selectSession(id)}
        onDeleteSession={(id) => {
          setNotice("");
          return authoringWorkspace.deleteSession(id);
        }}
        onRollbackFile={(id, change, path) => {
          setNotice("");
          return authoringWorkspace.rollbackFile(id, change, path);
        }}
        onConfigureModel={() => navigate("model")}
        onBack={() => navigate("home")}
      />
    ) : null;

  return (
    <div className="workspace-shell" data-screen={screen}>
      <WorkspaceHeader
        screen={screen}
        locale={workspace.preferences.locale}
        localeSaving={localeSaving}
        navigationLocked={navigationLocked}
        activeModelName={activeModel?.name ?? null}
        onNavigate={navigate}
        onLocaleChange={(locale) => void saveLocale(locale)}
      />
      <div className="workspace-body">
        {worldContent}
        {authoringContent}
        {screen !== "content" &&
          screen !== "world" &&
          (notice || workspace.storageNotices.length > 0) && (
            <div className="workspace-feedback">
              {notice && (
                <DismissibleNotice
                  text={notice}
                  onDismiss={() => setNotice("")}
                />
              )}
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
            onOpenPlayPresets={() => navigate("plays")}
            onCreateWorld={() => navigate("create")}
            onCreatePackage={() => void createPackage()}
            onImportPackage={() => void importPackage()}
            onOpenPackage={(packageId) => void openPackage(packageId)}
            onRenamePackage={(item, name) =>
              void renamePackage(name, item.localId)
            }
            onDeletePackage={(item) => {
              if (
                globalThis.confirm(
                  uiText(
                    "删除内容包“{title}”？它会从本机移除，且无法撤销。已创建的世界不受影响。",
                    { title: item.title },
                  ),
                )
              )
                void contentCommand("content.delete", item.localId);
            }}
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
          <CreateWorldScreen
            key={selected}
            client={client}
            packages={workspace.contentPackages}
            selectedId={selected}
            pending={creatingWorld}
            modelConfigured={workspace.model.configured}
            onSelect={setSelected}
            onCreate={() => void createWorld()}
            onEdit={() => navigate("content")}
            onConfigureModel={() => navigate("model")}
          />
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
      </div>
    </div>
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
