import { SillyTavernContentImport } from "./SillyTavernContentImport.tsx";
import type { ProtagonistTemplate } from "../protocol/protagonistTemplates.ts";
import {
  WorldBackupExportButton,
  WorldBackupImportButton,
} from "./WorldArchiveControls.tsx";
import { PackageScriptPermissionControl } from "./PackageScriptPermissionControl.tsx";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { maxPortableContentArchiveBytes } from "../protocol/contentTree.ts";
import type { Gameplay, ResolutionScheme } from "../protocol/gameplay.ts";
import type { ModelConnectionLibraryView } from "../protocol/modelConnections.ts";
import {
  defaultAppReadingPreferences,
  type AppLocale,
  type AppPreferences,
} from "../protocol/appPreferences.ts";
import type { V1SettingImprovementOverview } from "../protocol/v1.ts";
import { firstPartyPlayPresetTemplatesForLocale } from "../shared/first-party-play-preset-templates.ts";
import { RuntimeRequestError, type RuntimeClient } from "./runtimeClient.ts";
import { ReadTarget } from "./ReadTarget.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { readAfterCommit } from "./RequestOutcome.ts";
import { compareWorldActivity } from "../shared/world-activity-order.ts";
import { saveFile } from "./androidBridge.ts";
import { WorldCreation } from "./WorldCreation.ts";
import { setWebLocale, uiText } from "./i18n.ts";
import { WorkspaceHeader, type WorkspaceScreen } from "./WorkspaceHeader.tsx";
import { CreateContentPackageDialog } from "./CreateContentPackageDialog.tsx";
import { CreateWorldScreen } from "./CreateWorldScreen.tsx";
import { DismissibleNotice } from "./DismissibleNotice.tsx";
import {
  HomeScreen,
  type HomeWorld,
  type HomeContentPackage,
} from "./HomeScreen.tsx";
import { ModelConnectionScreen } from "./ModelConnectionScreen.tsx";
import { PlayPresetScreen } from "./PlayPresetScreen.tsx";
import { PromptPreviewScreen } from "./PromptPreviewScreen.tsx";
import { SettingImprovementPanel } from "./SettingImprovementPanel.tsx";
import { useAuthoringWorkspace } from "./useAuthoringWorkspace.ts";
import { WorldPage } from "./WorldPage.tsx";
import {
  parseWorkspaceHash,
  workspaceHash,
  type WorkspaceLocation,
} from "./WorkspaceLocation.ts";

interface Workspace {
  preferences: AppPreferences;
  contentPackages: HomeContentPackage[];
  playPresets: PlayPresetLibrary;
  worlds: HomeWorld[];
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

type Screen = WorkspaceScreen;
export function App({ client }: { client: RuntimeClient }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const workspaceReceiptVersion = useRef(0);
  const currentWorkspace = useEffectEvent(() => workspace);

  const [screen, setScreen] = useState<Screen>("home");
  const locationRef = useRef<WorkspaceLocation>({ screen: "home" });
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetPageVersion, setPresetPageVersion] = useState(0);
  const presetPageInstanceRef = useRef(0);
  const [selected, setSelected] = useState<string>("");
  const [creatingWorld, setCreatingWorld] = useState(false);
  const creatingWorldRef = useRef(false);
  const [creationSyncFailed, setCreationSyncFailed] = useState(false);
  const [creationSyncError, setCreationSyncError] = useState<unknown>();
  const [worldCreation] = useState(
    () =>
      new WorldCreation((failed, error) => {
        setCreationSyncFailed(failed);
        setCreationSyncError(failed ? error : undefined);
      }),
  );
  const creationTemplate = useRef<ProtagonistTemplate | undefined>(undefined);
  const [packageDialogOpen, setPackageDialogOpen] = useState(false);
  const [creatingPackage, setCreatingPackage] = useState(false);
  const [childNavigationLocked, setChildNavigationLocked] = useState(false);
  const [playPresetDraftDirty, setPlayPresetDraftDirty] = useState(false);
  const [pendingModelAction, setPendingModelAction] = useState<string | null>(
    null,
  );
  const [modelDraftDirty, setModelDraftDirty] = useState(false);
  const [promptPreviewPlayPreset, setPromptPreviewPlayPreset] = useState<{
    presetId: string;
    revision: string;
  } | null>(null);
  const [importArchive, setImportArchive] = useState<File | null>(null);
  const [importPending, setImportPending] = useState(false);
  const [samplePending, setSamplePending] = useState(false);
  const samplePendingRef = useRef(false);
  const [archivePending, setArchivePending] = useState(false);
  const { workspace: authoringWorkspace, state: authoring } =
    useAuthoringWorkspace(client, "setting", selected, screen === "content");
  const filesDirty = authoring.dirty;
  const files = authoring.files;
  const packageDetail = authoring.target?.packageDetail ?? null;
  const [worldId, setWorldId] = useState("");
  const [protagonistRevision, setProtagonistRevision] = useState<{
    worldId: string;
    message: string;
    started: boolean;
  } | null>(null);
  const [notice, setNotice] = useState(uiText("正在读取工作区…"));
  const [localeSaving, setLocaleSaving] = useState(false);
  const [localeRejection, setLocaleRejection] = useState<string | null>(null);
  const filesDirtyRef = useRef(filesDirty);
  filesDirtyRef.current = filesDirty;
  const packageOpenRequest = useRef(0);
  const packageReadTarget = useRef<ReadTarget<unknown> | null>(null);
  const [packageSyncFailed, setPackageSyncFailed] = useState(false);
  const [packageSyncError, setPackageSyncError] = useState<unknown>();
  const navigationLockedRef = useRef(false);
  const navigationDraftLockedRef = useRef(false);
  const navigationLocked =
    filesDirty ||
    authoring.view?.runStatus === "running" ||
    playPresetDraftDirty ||
    modelDraftDirty ||
    importPending ||
    archivePending ||
    samplePending ||
    creatingWorld ||
    creatingPackage ||
    childNavigationLocked;
  navigationLockedRef.current = navigationLocked;
  navigationDraftLockedRef.current =
    filesDirty ||
    authoring.view?.runStatus === "running" ||
    playPresetDraftDirty ||
    modelDraftDirty ||
    childNavigationLocked;

  function switchLocation(next: WorkspaceLocation, mode?: "replace"): void {
    const previous = locationRef.current;
    const hash = workspaceHash(next);
    packageOpenRequest.current += 1;
    packageReadTarget.current?.dispose();
    setPackageSyncFailed(false);
    if (previous.screen !== next.screen) presetPageInstanceRef.current += 1;
    if (workspaceHash(previous) !== hash) {
      worldCreation.clear();
      authoringWorkspace.close();
    }
    locationRef.current = next;
    if (next.screen === "content") setSelected(next.packageId);
    if (next.screen === "world") setWorldId(next.worldId);
    if (next.screen === "plays") setSelectedPresetId(next.presetId ?? "");
    setScreen(next.screen);
    if (mode === "replace" || previous.screen === next.screen)
      window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
  }

  function preserveLocation(): void {
    packageOpenRequest.current += 1;
    window.history.pushState(null, "", workspaceHash(locationRef.current));
    setNotice(uiText("已保留当前页面的未保存修改，请保存或放弃后再切换。"));
  }

  const restoreAddress = useEffectEvent((next: Workspace) => {
    const target = parseWorkspaceHash(window.location.hash);
    let failure = "";
    if (target === null) failure = uiText("找不到该页面。");
    else if (
      target.screen === "world" &&
      !next.worlds.some(({ worldId }) => worldId === target.worldId)
    )
      failure = uiText("找不到该世界。");
    else if (
      target.screen === "content" &&
      !next.contentPackages.some(({ localId }) => localId === target.packageId)
    )
      failure = uiText("找不到该内容包。");
    else if (
      target.screen === "plays" &&
      target.presetId !== undefined &&
      !next.playPresets.presets.some(({ id }) => id === target.presetId)
    )
      failure = uiText("找不到该编排方案。");
    if (failure || target === null) {
      switchLocation({ screen: "home" }, "replace");
      setNotice(failure);
    } else if (target.screen === "content") {
      void openPackage(target.packageId, "replace");
    } else if (target.screen === "plays") {
      const current = locationRef.current;
      if (current.screen === "plays" && current.presetId !== target.presetId) {
        presetPageInstanceRef.current += 1;
        setPresetPageVersion((version) => version + 1);
      }
      switchLocation(target, "replace");
    } else if (target.screen === "preview" && !next.model.configured) {
      switchLocation({ screen: "model" }, "replace");
      setNotice(uiText("请先保存并启用一份模型配置。"));
    } else {
      if (target.screen === "preview") setPromptPreviewPlayPreset(null);
      switchLocation(target, "replace");
    }
  });

  const restoreBrowserAddress = useEffectEvent(() => {
    if (navigationLockedRef.current || creatingWorldRef.current) {
      preserveLocation();
      return;
    }
    // Recheck local identities: another tab may have deleted the target.
    const version = ++packageOpenRequest.current;
    if (workspace === null) return;
    const hash = window.location.hash;
    const receiptVersion = workspaceReceiptVersion.current;
    void workspaceTarget.read().then((next) => {
      if (
        version !== packageOpenRequest.current ||
        window.location.hash !== hash
      )
        return;
      if (navigationLockedRef.current || creatingWorldRef.current) {
        preserveLocation();
        return;
      }
      const latest =
        next ??
        (receiptVersion !== workspaceReceiptVersion.current
          ? currentWorkspace()
          : null);
      if (latest !== null) restoreAddress(latest);
      else
        window.history.pushState(null, "", workspaceHash(locationRef.current));
    });
  });

  useEffect(() => () => packageReadTarget.current?.dispose(), []);
  useEffect(() => {
    const onPopState = () => restoreBrowserAddress();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const {
    target: workspaceTarget,
    syncFailed,
    syncError: workspaceSyncError,
  } = useReadTarget(
    useCallback(
      () => client.request<Workspace>({ type: "workspace.read" }),
      [client],
    ),
    useCallback((next: Workspace) => {
      setWebLocale(next.preferences.locale);
      setWorkspace(next);
      setSelected((current) => {
        const location = locationRef.current;
        if (location.screen === "content") return location.packageId;
        if (location.screen === "create" && current !== "") return current;
        return next.contentPackages.some(({ localId }) => localId === current)
          ? current
          : (next.contentPackages[0]?.localId ?? "");
      });
      setNotice("");
    }, []),
  );
  async function refresh(): Promise<void> {
    await workspaceTarget.read();
  }

  function updateWorkspace(update: (current: Workspace) => Workspace): void {
    workspaceReceiptVersion.current++;
    workspaceTarget.accept({ complete: false });
    setWorkspace((current) => (current === null ? null : update(current)));
  }

  async function quickSelectModel(connectionId: string): Promise<boolean> {
    if (pendingModelAction !== null || modelDraftDirty) return false;
    setPendingModelAction("quick-select");
    try {
      const model = await client.request<ModelConnectionLibraryView>({
        type: "model.select",
        connectionId,
      });
      updateWorkspace((current) => ({ ...current, model }));
      return true;
    } catch (error: unknown) {
      const recovered = await workspaceTarget.recover();
      if (recovered?.model.activeConnectionId === connectionId) return true;
      throw error;
    } finally {
      setPendingModelAction(null);
    }
  }

  function acceptPackage({
    localId,
    title,
    gameplay,
    status,
  }: HomeContentPackage): void {
    const summary = { localId, title, gameplay, status };
    updateWorkspace((current) => ({
      ...current,
      contentPackages: [
        ...current.contentPackages.filter((item) => item.localId !== localId),
        summary,
      ].sort((left, right) => left.localId.localeCompare(right.localId)),
    }));
  }

  function acceptWorld(world: HomeWorld): void {
    updateWorkspace((current) => ({
      ...current,
      worlds: [
        ...current.worlds.filter((item) => item.worldId !== world.worldId),
        world,
      ].sort(compareWorldActivity),
    }));
  }

  useEffect(() => {
    let previous: typeof packageDetail = null;
    return authoringWorkspace.subscribe(() => {
      const detail = authoringWorkspace.getSnapshot().target?.packageDetail;
      if (detail === undefined || detail === previous) return;
      previous = detail;
      workspaceReceiptVersion.current++;
      workspaceTarget.accept({ complete: false });
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
  }, [authoringWorkspace, workspaceTarget]);

  useEffect(() => {
    let active = true;
    const read =
      loadAttempt === 0 ? workspaceTarget.read() : workspaceTarget.recover();
    void read.then((next) => {
      if (active && next !== null) restoreAddress(next);
    });
    return () => {
      active = false;
      packageOpenRequest.current += 1;
      presetPageInstanceRef.current += 1;
    };
  }, [workspaceTarget, loadAttempt]);

  const reconcileVisibleResource = useEffectEvent(() => {
    if (
      workspace === null ||
      navigationLockedRef.current ||
      creatingWorldRef.current
    )
      return;
    const location = locationRef.current;
    const missingPackage =
      (location.screen === "content" ||
        (location.screen === "create" && selected !== "")) &&
      !workspace.contentPackages.some(
        ({ localId }) =>
          localId ===
          (location.screen === "content" ? location.packageId : selected),
      );
    const missingWorld =
      location.screen === "world" &&
      !workspace.worlds.some((world) => world.worldId === location.worldId);
    if (!missingPackage && !missingWorld) return;
    switchLocation({ screen: "home" }, "replace");
    setSelected(workspace.contentPackages[0]?.localId ?? "");
    setNotice(uiText(missingPackage ? "找不到该内容包。" : "找不到该世界。"));
  });
  useEffect(() => {
    reconcileVisibleResource();
  }, [workspace, screen, selected, navigationLocked, creatingWorld]);

  async function saveLocale(locale: AppLocale): Promise<void> {
    if (workspace === null || localeSaving) return;
    setLocaleSaving(true);
    setLocaleRejection(null);
    try {
      const preferences = await workspaceTarget.command(() =>
        client.request<AppPreferences>({
          type: "preferences.save",
          locale,
        }),
      );
      setWebLocale(preferences.locale);
      updateWorkspace((current) => ({ ...current, preferences }));
      await readAfterCommit(refresh);
      setNotice(uiText("界面语言已保存。"));
    } catch (error: unknown) {
      if (error instanceof RuntimeRequestError && error.kind === "runtime")
        setLocaleRejection(error.message);
      else report(error);
    } finally {
      setLocaleSaving(false);
    }
  }

  async function openPackage(
    packageId: string,
    mode?: "replace",
  ): Promise<void> {
    const requestVersion = packageOpenRequest.current + 1;
    packageOpenRequest.current = requestVersion;
    packageReadTarget.current?.dispose();
    setPackageSyncFailed(false);
    const target = new ReadTarget<unknown>({
      load: () => client.request({ type: "content.read", packageId }),
      apply: () => {
        if (packageOpenRequest.current !== requestVersion) return;
        if (
          navigationDraftLockedRef.current ||
          (mode === "replace" &&
            (navigationLockedRef.current || creatingWorldRef.current))
        ) {
          if (mode === "replace") preserveLocation();
          else
            setNotice(
              uiText("已保留当前页面的未保存修改，请保存或放弃后再切换。"),
            );
          return;
        }
        switchLocation({ screen: "content", packageId }, mode);
      },
      onSyncFailure: (failed, error) => {
        if (packageOpenRequest.current !== requestVersion) return;
        setPackageSyncFailed(failed);
        setPackageSyncError(failed ? error : undefined);
        if (failed && mode === "replace")
          window.history.replaceState(
            null,
            "",
            workspaceHash(locationRef.current),
          );
      },
    });
    packageReadTarget.current = target;
    await target.read();
  }

  /** The creation dialog keeps itself open and shows the error when Runtime refuses the package. */
  async function createPackage(gameplay: Gameplay): Promise<void> {
    setCreatingPackage(true);
    try {
      const created = await client.request<HomeContentPackage>({
        type: "content.create",
        gameplay,
      });
      setPackageDialogOpen(false);
      acceptPackage(created);
      switchLocation({ screen: "content", packageId: created.localId });
    } catch (error) {
      await workspaceTarget.recover();
      throw error;
    } finally {
      setCreatingPackage(false);
    }
  }

  async function setPackageScheme(scheme: ResolutionScheme): Promise<void> {
    try {
      // File drafts stay closed until the saved tree is re-read, so none can be saved over the scheme.
      await authoringWorkspace.holdDraftsWhile(async () => {
        await client.request({
          type: "content.gameplay.set",
          packageId: selected,
          scheme,
        });
      });
      setNotice(uiText("判定方案已保存；已有世界保持原方案。"));
    } catch (error: unknown) {
      report(error);
    }
  }

  async function createSamplePackage(): Promise<void> {
    if (workspace === null || samplePendingRef.current || importPending) return;
    samplePendingRef.current = true;
    setSamplePending(true);
    try {
      const created = await workspaceTarget.command(() =>
        client.request<HomeContentPackage>({
          type: "content.create-sample",
          locale: workspace.preferences.locale,
        }),
      );
      acceptPackage(created);
      setSelected(created.localId);
      switchLocation({ screen: "create" });
    } catch (error: unknown) {
      report(error);
    } finally {
      samplePendingRef.current = false;
      setSamplePending(false);
    }
  }

  async function contentCommand(
    type: "content.copy" | "content.delete",
    packageId = selected,
  ): Promise<void> {
    const origin = locationRef.current;
    try {
      if (type === "content.copy") {
        acceptPackage(
          await client.request<HomeContentPackage>({ type, packageId }),
        );
      } else {
        await client.request({ type, packageId });
        updateWorkspace((current) => ({
          ...current,
          contentPackages: current.contentPackages.filter(
            (item) => item.localId !== packageId,
          ),
        }));
        setSelected((id) =>
          id === packageId
            ? (workspace?.contentPackages.find(
                (item) => item.localId !== packageId,
              )?.localId ?? "")
            : id,
        );
      }
      if (locationRef.current === origin && !navigationDraftLockedRef.current)
        switchLocation({ screen: "home" });
    } catch (error: unknown) {
      await workspaceTarget.recover();
      report(error);
    }
  }

  async function renamePackage(
    title: string,
    packageId = selected,
  ): Promise<boolean> {
    try {
      const receipt = await client.request<HomeContentPackage>({
        type: "content.rename",
        packageId,
        name: title,
      });
      acceptPackage(receipt);
      setNotice(uiText("内容包已重命名。"));
      return true;
    } catch (error: unknown) {
      await workspaceTarget.recover();
      if (screen === "content") await authoringWorkspace.refresh();
      report(error);
      return false;
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
      const imported = await client.request<HomeContentPackage>({
        type: "content.import",
        archiveBase64,
        title: contentPackageTitleFromArchiveName(importArchive.name),
      });
      setImportArchive(null);
      acceptPackage(imported);
      switchLocation({ screen: "content", packageId: imported.localId });
      setNotice(uiText("已将内容包导入为独立副本，现有内容包未被覆盖。"));
    } catch (error: unknown) {
      await workspaceTarget.recover();
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
      await saveFile(exported.fileName, {
        blob: new Blob([bytes], { type: "application/zip" }),
      });
    } catch (error: unknown) {
      await Promise.all([
        workspaceTarget.recover(),
        authoringWorkspace.refresh(),
      ]);
      report(error);
    }
  }

  function openPromptPreview(target?: {
    presetId: string;
    revision: string;
  }): void {
    setPromptPreviewPlayPreset(target ?? null);
    if (workspace?.model.configured !== true) {
      switchLocation({ screen: "model" });
      setNotice(uiText("请先保存并启用一份模型配置。"));
      return;
    }
    switchLocation({ screen: "preview" });
  }

  const creationOverviewVisible = screen === "create" || screen === "content";
  const {
    target: creationOverviewTarget,
    syncFailed: creationOverviewFailed,
    syncError: creationOverviewError,
  } = useReadTarget(
    useCallback(
      () =>
        creationOverviewVisible
          ? client.request<V1SettingImprovementOverview>({
              type: "setting-improvement.overview",
              packageId: selected,
            })
          : Promise.resolve(null),
      [client, selected, creationOverviewVisible],
    ),
    useCallback(() => undefined, []),
  );

  async function createWorld(template?: ProtagonistTemplate): Promise<void> {
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
      switchLocation({ screen: "model" });
      setNotice(uiText("请先保存并启用一份模型配置。"));
      return;
    }
    creatingWorldRef.current = true;
    setCreatingWorld(true);
    const packageId = selected;
    creationTemplate.current = template;
    const model = modelBinding();
    try {
      const authoring = await creationOverviewTarget.read();
      if (authoring === null) return;
      if (
        authoring.latest?.runStatus === "running" ||
        authoring.history.some((session) => session.runStatus === "running")
      ) {
        setNotice(uiText("这份内容包正在完善，请在回复完成后创建世界。"));
        return;
      }
      const created = await worldCreation.create(
        client,
        { packageId, model },
        packageDetail?.localId === packageId
          ? packageDetail.treeRevision
          : undefined,
      );
      acceptCreatedWorld(created);
    } catch (error: unknown) {
      await workspaceTarget.recover();
      report(error);
    } finally {
      creatingWorldRef.current = false;
      setCreatingWorld(false);
    }
  }

  function acceptCreatedWorld(created: HomeWorld): void {
    const template = creationTemplate.current;
    if (template !== undefined)
      setProtagonistRevision({
        worldId: created.worldId,
        message: uiText(
          "请按下面的主角模板修改本世界的主角。\n\n- 找到本世界中代表玩家的主角文档，按模板改写姓名、外貌、背景、性格等相关内容。\n- 模板与本世界设定冲突的部分，保留模板的意图，按本世界的规则调整。\n- 只修改主角相关的内容，不修改其他人物、地点、规则或世界控制。\n- 如果本世界中找不到明确的主角文档，先在回复中说明并询问我，不要擅自新建。\n\n主角模板：\n\n{body}",
          { body: template.body },
        ),
        started: false,
      });
    acceptWorld(created);
    openWorld(created.worldId);
  }

  async function rereadCreation(): Promise<void> {
    const created = await worldCreation.recover();
    if (created !== null) acceptCreatedWorld(created);
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
    switchLocation({ screen: "world", worldId: id });
  }

  async function renameWorld(worldId: string, name: string): Promise<void> {
    const renamed = await workspaceTarget.command(() =>
      client.request<HomeWorld>({
        type: "world.rename",
        worldId,
        name,
      }),
    );
    acceptWorld(renamed);
    setNotice(uiText("世界已重命名为“{name}”。", { name: renamed.title }));
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
      updateWorkspace((current) => ({
        ...current,
        worlds: current.worlds.filter((item) => item.worldId !== world.worldId),
      }));
      setNotice(uiText("世界已从本机删除。"));
    } catch (error: unknown) {
      await workspaceTarget.recover();
      report(error);
    }
  }

  function report(error: unknown): void {
    setNotice(error instanceof Error ? error.message : uiText("操作失败"));
  }

  if (workspace === null)
    return (
      <main className="center-card" role="status">
        {syncFailed ? (
          <SyncNotice
            failed
            onRead={() => setLoadAttempt((current) => current + 1)}
          />
        ) : (
          notice
        )}
      </main>
    );

  const selectedPackage = workspace.contentPackages.find(
    ({ localId }) => localId === selected,
  );
  const selectedPackageDetail =
    packageDetail?.localId === selected ? packageDetail : null;
  const selectedGameplay =
    selectedPackageDetail?.gameplay ?? selectedPackage?.gameplay;
  const displayedImprovementView = authoring.view;
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

  function navigate(next: Screen): void {
    if (navigationLocked) return;
    if (next !== "content" || next === screen) packageOpenRequest.current += 1;
    if (next === screen) return;
    if (next === "content") {
      if (selectedPackage === undefined) setPackageDialogOpen(true);
      else void openPackage(selectedPackage.localId);
    } else if (next === "preview") openPromptPreview();
    else if (next === "plays")
      switchLocation({
        screen: "plays",
        ...(selectedPresetId || workspace?.playPresets.currentPresetId
          ? {
              presetId:
                selectedPresetId ||
                (workspace?.playPresets.currentPresetId ?? ""),
            }
          : {}),
      });
    else if (next === "world") openWorld(worldId);
    else {
      switchLocation({ screen: next });
      if (next === "home") void refresh().catch(report);
    }
  }

  // Async preset actions retain this instance even after a later page mounts.
  const presetPageInstance = presetPageInstanceRef.current;
  const worldContent =
    screen === "world" ? (
      <WorldPage
        showWorkspaceBack={false}
        {...(protagonistRevision?.worldId === worldId
          ? {
              protagonistRevision,
              onProtagonistRevisionStarted: () =>
                setProtagonistRevision((current) =>
                  current === null ? null : { ...current, started: true },
                ),
              onProtagonistRevisionFinished: () => setProtagonistRevision(null),
            }
          : {})}
        key={worldId}
        client={client}
        worldId={worldId}
        worldTitle={selectedWorld?.title ?? uiText("未命名世界")}
        modelConfigured={workspace.model.configured}
        onBack={() => navigate("home")}
        onConfigureModel={() => navigate("model")}
        onNavigationLockChange={setChildNavigationLocked}
        onRenameWorld={(name) => renameWorld(worldId, name)}
        onRecoverWorkspace={() => workspaceTarget.recover()}
        initialReadingPreferences={
          workspace.preferences.reading ?? defaultAppReadingPreferences
        }
        onReadingPreferencesChange={(reading) =>
          updateWorkspace((current) => ({
            ...current,
            preferences: { ...current.preferences, reading },
          }))
        }
        onOpenWorld={async (nextWorldId) => {
          workspaceTarget.accept({ complete: false });
          openWorld(nextWorldId);
          await readAfterCommit(refresh).catch(report);
        }}
      />
    ) : null;

  const authoringContent =
    screen === "content" ? (
      <SettingImprovementPanel
        showWorkspaceBack={false}
        key={selected}
        onPreview={() => authoringWorkspace.preview()}
        onCallContext={(sessionId, callId) =>
          authoringWorkspace.callContext(sessionId, callId)
        }
        onRequestPreview={(sessionId, requestId) =>
          authoringWorkspace.requestPreview(sessionId, requestId)
        }
        packageName={
          selectedPackage?.title ?? selectedPackageDetail?.title ?? selected
        }
        modelConfigured={workspace.model.configured}
        {...(selectedGameplay === undefined
          ? {}
          : {
              packageGameplay: {
                gameplay: selectedGameplay,
                onChangeScheme: setPackageScheme,
              },
            })}
        hasUnsavedFileDraft={filesDirty}
        draftsLocked={authoring.draftsLocked}
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
        requestFailure={authoring.requestFailure}
        syncFailed={authoring.syncFailed}
        syncError={authoring.syncError}
        onRead={() => void authoringWorkspace.reread()}
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
          conflict: authoring.conflict,
          onFilesChange: (nextFiles) => authoringWorkspace.editFiles(nextFiles),
          onSave: () => {
            setNotice("");
            void authoringWorkspace.saveFiles();
          },
          onLoadLatest: () => {
            setNotice("");
            authoringWorkspace.loadLatest();
          },
          onReset: () => {
            setNotice("");
            authoringWorkspace.resetFiles();
          },
          onCopy: () => void contentCommand("content.copy"),
          onExport: () => void exportPackage(),
          onDelete: () => void contentCommand("content.delete"),
          title:
            selectedPackage?.title ?? selectedPackageDetail?.title ?? selected,
          onRename: (name) => void renamePackage(name),
        }}
        onSend={(message, requestId) => {
          setNotice("");
          return authoringWorkspace.send(message, requestId);
        }}
        onEditMessage={(messageId, message, filePolicy, requestId) =>
          authoringWorkspace.editMessage(
            messageId,
            message,
            filePolicy,
            requestId,
          )
        }
        onCancel={() => authoringWorkspace.cancel()}
        onResume={(recovery) => {
          setNotice("");
          return authoringWorkspace.resume(recovery);
        }}
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
        model={workspace.model}
        modelBusy={pendingModelAction !== null || modelDraftDirty}
        onSelectModel={quickSelectModel}
        onNavigate={navigate}
        onLocaleChange={(locale) => void saveLocale(locale)}
      />
      {packageDialogOpen ? (
        <CreateContentPackageDialog
          pending={creatingPackage}
          onCancel={() => setPackageDialogOpen(false)}
          onCreate={createPackage}
        />
      ) : null}
      <div className="workspace-body">
        <SyncNotice
          failed={
            syncFailed ||
            packageSyncFailed ||
            creationOverviewFailed ||
            creationSyncFailed
          }
          reason={
            (creationSyncFailed ? creationSyncError : undefined) ??
            (creationOverviewFailed ? creationOverviewError : undefined) ??
            (packageSyncFailed ? packageSyncError : undefined) ??
            workspaceSyncError
          }
          onRead={() => {
            if (syncFailed) void workspaceTarget.recover();
            if (packageSyncFailed) void packageReadTarget.current?.recover();
            if (creationOverviewFailed) void creationOverviewTarget.recover();
            if (creationSyncFailed) void rereadCreation();
          }}
        />
        {localeRejection !== null && (
          <DismissibleNotice
            role="alert"
            text={localeRejection}
            onDismiss={() => setLocaleRejection(null)}
          />
        )}
        {worldContent}
        {authoringContent}
        {screen !== "content" &&
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
            sillyTavernContentImport={
              <SillyTavernContentImport
                client={client}
                onFailure={() => workspaceTarget.recover()}
                onImported={(receipt) => {
                  acceptPackage(receipt);
                  switchLocation({
                    screen: "content",
                    packageId: receipt.localId,
                  });
                }}
              />
            }
            contentPackages={workspace.contentPackages}
            worlds={workspace.worlds}
            selectedPackageId={selected}
            modelConfigured={workspace.model.configured}
            activeModelName={activeModel?.name ?? null}
            currentPresetName={currentPresetName}
            importArchive={importArchive}
            importPending={importPending || archivePending}
            worldBackupImport={
              <WorldBackupImportButton
                client={client}
                disabled={importPending || samplePending || archivePending}
                onBusyChange={setArchivePending}
                onImported={acceptWorld}
                onFailure={() => workspaceTarget.recover()}
              />
            }
            renderWorldBackupExport={(world) => (
              <WorldBackupExportButton
                client={client}
                worldId={world.worldId}
                label="导出备份"
                disabled={importPending || archivePending || samplePending}
                onBusyChange={setArchivePending}
                onFailure={() => workspaceTarget.recover()}
              />
            )}
            samplePending={samplePending}
            onImportArchiveChange={(archive) => {
              setImportArchive(archive);
              setNotice("");
            }}
            onOpenPlayPresets={() => navigate("plays")}
            onCreateWorld={() => navigate("create")}
            onCreatePackage={() => setPackageDialogOpen(true)}
            onCreateSamplePackage={() => void createSamplePackage()}
            onConfigureModel={() => navigate("model")}
            onImportPackage={() => void importPackage()}
            onOpenPackage={(packageId) => void openPackage(packageId)}
            onRenamePackage={(item, name) => renamePackage(name, item.localId)}
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
            onRenameWorld={async (world, name) => {
              try {
                await renameWorld(world.worldId, name);
                return true;
              } catch (error) {
                report(error);
                return false;
              }
            }}
            onDeleteWorld={(world) => void deleteWorld(world)}
          />
        )}
        {screen === "plays" && (
          <PlayPresetScreen
            key={presetPageVersion}
            client={client}
            initialLibrary={workspace.playPresets}
            modelConnection={activeModel}
            onEditModelConnection={() => navigate("model")}
            initialSelectedId={selectedPresetId}
            onSelectionChange={(presetId) => {
              if (
                locationRef.current.screen !== "plays" ||
                window.location.hash !== workspaceHash(locationRef.current) ||
                presetPageInstanceRef.current !== presetPageInstance
              )
                return;
              switchLocation(
                { screen: "plays", ...(presetId ? { presetId } : {}) },
                "replace",
              );
            }}
            recommendedTemplates={firstPartyPlayPresetTemplatesForLocale(
              workspace.preferences.locale,
            )}
            onLibraryChange={(playPresets) => {
              if (presetPageInstanceRef.current !== presetPageInstance) {
                // A receipt from a retired editor was applied to its old library.
                void readAfterCommit(refresh).catch(report);
                return;
              }
              updateWorkspace((current) => ({ ...current, playPresets }));
            }}
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
              updateWorkspace((current) => ({ ...current, model }))
            }
            onNotice={setNotice}
            onDirtyChange={setModelDraftDirty}
            pendingState={[pendingModelAction, setPendingModelAction]}
          />
        )}
        {screen === "create" && (
          <CreateWorldScreen
            client={client}
            packages={workspace.contentPackages}
            selectedId={selected}
            pending={creatingWorld}
            modelConfigured={workspace.model.configured}
            onSelect={(id) => {
              worldCreation.clear();
              setSelected(id);
            }}
            onCreate={(template) => void createWorld(template)}
            onNavigationLockChange={setChildNavigationLocked}
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
