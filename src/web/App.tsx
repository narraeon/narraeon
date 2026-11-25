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
  useLayoutEffect,
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
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";
import {
  HomeScreen,
  type HomeWorld,
  type HomeContentPackage,
} from "./HomeScreen.tsx";
import { ModelConnectionScreen } from "./ModelConnectionScreen.tsx";
import { PlayPresetScreen } from "./PlayPresetScreen.tsx";
import { PromptPreviewScreen } from "./PromptPreviewScreen.tsx";
import { SettingImprovementPanel } from "./SettingImprovementPanel.tsx";
import {
  authoringConversationActions,
  useAuthoringWorkspace,
} from "./useAuthoringWorkspace.ts";
import { WorldPage } from "./WorldPage.tsx";
import {
  idleWorkspaceNavigation,
  parseWorkspaceHash,
  readBrowserWorkspaceEntry,
  returnToBrowserWorkspaceEntry,
  sameBrowserWorkspaceEntry,
  workspaceHash,
  writeBrowserWorkspaceEntry,
  type BrowserWorkspaceEntry,
  type WorkspaceLocation,
  type WorkspaceNavigationProtection,
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
type LeaveIntent =
  | { kind: "browser"; entry: BrowserWorkspaceEntry }
  | { kind: "program"; navigate: () => void };

export function App({ client }: { client: RuntimeClient }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const workspaceReceiptVersion = useRef(0);
  const currentWorkspace = useEffectEvent(() => workspace);

  const [screen, setScreen] = useState<Screen>("home");
  const locationRef = useRef<WorkspaceLocation>({ screen: "home" });
  const browserEntry = useRef<BrowserWorkspaceEntry | null>(null);
  const leaveIntent = useRef<LeaveIntent | null>(null);
  const [leaveConfirmation, setLeaveConfirmation] =
    useState<ConfirmationRequest<null> | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetPageVersion, setPresetPageVersion] = useState(0);
  const presetPageInstanceRef = useRef(0);
  const [selected, setSelected] = useState<string>("");
  const [creatingWorld, setCreatingWorld] = useState(false);
  const creatingWorldRef = useRef(false);
  const [deletingPackage, setDeletingPackage] = useState(false);
  const deletingPackageRef = useRef(false);
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
  const [childNavigation, setChildNavigation] =
    useState<WorkspaceNavigationProtection>(idleWorkspaceNavigation);
  const [playPresetNavigation, setPlayPresetNavigation] =
    useState<WorkspaceNavigationProtection>(idleWorkspaceNavigation);
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
  const {
    workspace: authoringWorkspace,
    state: authoring,
    conversation,
  } = useAuthoringWorkspace(client, "setting", selected, screen === "content");
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
  const packageRetryEntry = useRef<BrowserWorkspaceEntry | null>(null);
  const [packageSyncFailed, setPackageSyncFailed] = useState(false);
  const [packageSyncError, setPackageSyncError] = useState<unknown>();
  const navigationProtection = useRef(idleWorkspaceNavigation);
  const navigationDirty =
    filesDirty ||
    playPresetNavigation.dirty ||
    modelDraftDirty ||
    childNavigation.dirty;
  const navigationBusy =
    authoring.view?.runStatus === "running" ||
    importPending ||
    archivePending ||
    samplePending ||
    creatingWorld ||
    deletingPackage ||
    creatingPackage ||
    playPresetNavigation.busy ||
    (modelDraftDirty && pendingModelAction !== null) ||
    childNavigation.busy;
  const navigationLocked = navigationDirty || navigationBusy;
  navigationProtection.current = {
    dirty: navigationDirty,
    busy: navigationBusy,
  };

  function switchLocation(next: WorkspaceLocation, mode?: "replace"): void {
    const previous = locationRef.current;
    const hash = workspaceHash(next);
    packageOpenRequest.current += 1;
    packageReadTarget.current?.dispose();
    packageRetryEntry.current = null;
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
    const replace = mode === "replace" || previous.screen === next.screen;
    const position =
      readBrowserWorkspaceEntry().position ??
      browserEntry.current?.position ??
      0;
    browserEntry.current = writeBrowserWorkspaceEntry(
      hash,
      replace ? "replace" : "push",
      replace ? position : position + 1,
    );
  }

  function cancelBrowserNavigation(destination: BrowserWorkspaceEntry): void {
    const original = browserEntry.current;
    if (
      original !== null &&
      !returnToBrowserWorkspaceEntry(original, destination)
    )
      setNotice(uiText("浏览器无法恢复旧历史地址，当前页面的修改仍在。"));
  }

  function askToLeave(intent: LeaveIntent): void {
    leaveIntent.current = intent;
    const opener = document.activeElement;
    setLeaveConfirmation(
      (current) =>
        current ?? {
          action: null,
          message: uiText("此页有未保存的修改。要放弃修改并离开吗？"),
          confirmLabel: uiText("放弃并离开"),
          opener: opener instanceof HTMLElement ? opener : null,
        },
    );
  }

  function clearLeave(): void {
    leaveIntent.current = null;
    setLeaveConfirmation(null);
  }

  function blockBrowserNavigation(entry: BrowserWorkspaceEntry): boolean {
    if (navigationProtection.current.busy || creatingWorldRef.current) {
      clearLeave();
      setNotice(uiText("当前操作仍在进行，请等它结束后再切换页面。"));
      cancelBrowserNavigation(entry);
      return true;
    }
    if (navigationProtection.current.dirty) {
      askToLeave({ kind: "browser", entry });
      return true;
    }
    return false;
  }

  function restoreAddress(
    next: Workspace,
    {
      entry,
      discard = false,
    }: { entry?: BrowserWorkspaceEntry; discard?: boolean } = {},
  ): void {
    const target = parseWorkspaceHash(entry?.hash ?? window.location.hash);
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
    } else if (target.screen === "content" && !discard) {
      void openPackage(target.packageId, "replace", entry);
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
  }

  const restoreInitialAddress = useEffectEvent((next: Workspace) => {
    restoreAddress(next);
  });
  const restoreBrowserAddress = useEffectEvent(
    (entry: BrowserWorkspaceEntry, refreshSameEntry = false) => {
      const version = ++packageOpenRequest.current;
      const original = browserEntry.current;
      if (original !== null && sameBrowserWorkspaceEntry(entry, original)) {
        browserEntry.current = entry;
        if (leaveIntent.current?.kind === "browser") clearLeave();
        if (
          !refreshSameEntry ||
          navigationProtection.current.busy ||
          navigationProtection.current.dirty
        )
          return;
      } else if (blockBrowserNavigation(entry)) {
        return;
      }
      // Recheck local identities: another tab may have deleted the target.
      if (workspace === null) return;
      const receiptVersion = workspaceReceiptVersion.current;
      void workspaceTarget.read().then((next) => {
        if (
          version !== packageOpenRequest.current ||
          !sameBrowserWorkspaceEntry(entry, readBrowserWorkspaceEntry())
        )
          return;
        if (
          (original === null || !sameBrowserWorkspaceEntry(entry, original)) &&
          blockBrowserNavigation(entry)
        )
          return;
        const latest =
          next ??
          (receiptVersion !== workspaceReceiptVersion.current
            ? currentWorkspace()
            : null);
        if (latest !== null) restoreAddress(latest, { entry });
        else cancelBrowserNavigation(entry);
      });
    },
  );

  useEffect(() => () => packageReadTarget.current?.dispose(), []);
  useEffect(() => {
    let lastPop: BrowserWorkspaceEntry | null = null;
    const onPopState = (event: PopStateEvent) => {
      let entry = readBrowserWorkspaceEntry();
      if (entry.position === undefined) {
        const previous = browserEntry.current;
        // A growing stack identifies a new hash entry. Never guess the direction
        // of travel to an unmarked legacy entry without a browser-provided key.
        if (
          previous?.position !== undefined &&
          (!event.isTrusted || entry.historyLength > previous.historyLength)
        )
          entry = writeBrowserWorkspaceEntry(
            entry.hash,
            "replace",
            previous.position + (event.isTrusted ? 1 : 0),
          );
      }
      lastPop = entry;
      restoreBrowserAddress(entry, !event.isTrusted);
    };
    const onHashChange = (event: HashChangeEvent) => {
      const entry = readBrowserWorkspaceEntry();
      if (new URL(event.newURL).hash !== entry.hash) return;
      if (lastPop === null || !sameBrowserWorkspaceEntry(lastPop, entry))
        restoreBrowserAddress(entry);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  // Editors report their draft state in layout effects, so the browser
  // guard is installed before the input event finishes.
  useLayoutEffect(() => {
    if (!navigationDirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [navigationDirty]);
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
      if (active && next !== null) restoreInitialAddress(next);
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
      window.location.hash !== workspaceHash(locationRef.current) ||
      navigationProtection.current.dirty ||
      navigationProtection.current.busy ||
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
    const missingPreset =
      location.screen === "plays" &&
      location.presetId !== undefined &&
      !workspace.playPresets.presets.some(({ id }) => id === location.presetId);
    if (!missingPackage && !missingWorld && !missingPreset) return;
    switchLocation({ screen: "home" }, "replace");
    setSelected(workspace.contentPackages[0]?.localId ?? "");
    setNotice(
      uiText(
        missingPackage
          ? "找不到该内容包。"
          : missingWorld
            ? "找不到该世界。"
            : "找不到该编排方案。",
      ),
    );
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
    entry?: BrowserWorkspaceEntry,
  ): Promise<void> {
    const requestVersion = packageOpenRequest.current + 1;
    packageOpenRequest.current = requestVersion;
    packageReadTarget.current?.dispose();
    packageRetryEntry.current = null;
    setPackageSyncFailed(false);
    const target = new ReadTarget<unknown>({
      load: () => client.request({ type: "content.read", packageId }),
      apply: () => {
        if (packageOpenRequest.current !== requestVersion) return;
        if (entry !== undefined) {
          if (
            !sameBrowserWorkspaceEntry(entry, readBrowserWorkspaceEntry()) ||
            blockBrowserNavigation(entry)
          )
            return;
        } else if (
          navigationProtection.current.busy ||
          creatingWorldRef.current
        )
          return;
        const accept = () =>
          switchLocation({ screen: "content", packageId }, mode);
        if (entry === undefined && navigationProtection.current.dirty)
          askToLeave({ kind: "program", navigate: accept });
        else accept();
      },
      onSyncFailure: (failed, error) => {
        if (packageOpenRequest.current !== requestVersion) return;
        setPackageSyncFailed(failed);
        setPackageSyncError(failed ? error : undefined);
        if (failed && mode === "replace") {
          if (entry !== undefined) {
            packageRetryEntry.current = entry;
            cancelBrowserNavigation(entry);
          } else
            browserEntry.current = writeBrowserWorkspaceEntry(
              workspaceHash(locationRef.current),
              "replace",
              readBrowserWorkspaceEntry().position ?? 0,
            );
        }
      },
    });
    packageReadTarget.current = target;
    await target.read();
  }

  function retryPackageRead(): void {
    const retryEntry = packageRetryEntry.current;
    const current = readBrowserWorkspaceEntry();
    if (retryEntry !== null && !sameBrowserWorkspaceEntry(retryEntry, current))
      returnToBrowserWorkspaceEntry(retryEntry, current);
    else void packageReadTarget.current?.recover();
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
    const deletingFromEditor =
      origin.screen === "content" && type === "content.delete";
    if (deletingFromEditor) {
      if (
        origin.packageId !== packageId ||
        deletingPackageRef.current ||
        navigationProtection.current.dirty ||
        navigationProtection.current.busy ||
        creatingWorldRef.current
      )
        return;
      deletingPackageRef.current = true;
      setDeletingPackage(true);
    }
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
      if (
        locationRef.current === origin &&
        !navigationProtection.current.dirty &&
        (deletingFromEditor || !navigationProtection.current.busy)
      )
        switchLocation({ screen: "home" });
    } catch (error: unknown) {
      await workspaceTarget.recover();
      report(error);
    } finally {
      if (deletingFromEditor) {
        deletingPackageRef.current = false;
        setDeletingPackage(false);
      }
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
        setNotice(uiText("正在编辑这份内容包，请在回复完成后创建世界。"));
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

  async function deleteWorld(world: HomeWorld): Promise<void> {
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
    if (navigationBusy || creatingWorldRef.current || next === screen) return;
    if (navigationDirty)
      askToLeave({
        kind: "program",
        navigate: () => performNavigation(next, true),
      });
    else performNavigation(next);
  }

  function performNavigation(next: Screen, discard = false): void {
    packageOpenRequest.current += 1;
    if (next === "content") {
      if (selectedPackage === undefined) setPackageDialogOpen(true);
      else if (discard)
        switchLocation({
          screen: "content",
          packageId: selectedPackage.localId,
        });
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
      if (next === "home" || next === "library") void refresh().catch(report);
    }
  }

  function decideLeave(confirmed: boolean): void {
    const intent = leaveIntent.current;
    clearLeave();
    if (intent === null) return;
    const busy = navigationProtection.current.busy || creatingWorldRef.current;
    if (intent.kind === "program") {
      if (confirmed && !busy) intent.navigate();
      return;
    }
    const destination = readBrowserWorkspaceEntry();
    if (!sameBrowserWorkspaceEntry(destination, intent.entry)) return;
    if (!confirmed || busy) {
      cancelBrowserNavigation(destination);
      return;
    }
    if (workspace === null) return;
    restoreAddress(workspace, { entry: destination, discard: true });
    if (locationRef.current.screen !== "home") void refresh().catch(report);
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
        onNavigationProtectionChange={setChildNavigation}
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
        draftsLocked={authoring.draftsLocked || deletingPackage}
        loading={authoring.loading || creatingWorld}
        onCreateWorld={() => void createWorld()}
        onNavigationProtectionChange={setChildNavigation}
        conversation={conversation}
        conversationActions={authoringConversationActions(
          authoringWorkspace,
          () => setNotice(""),
        )}
        notice={notice || authoring.notice}
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
          onDelete: () => void contentCommand("content.delete", selected),
          title:
            selectedPackage?.title ?? selectedPackageDetail?.title ?? selected,
          onRename: (name) => void renamePackage(name),
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
        localeDisabled={localeSaving || navigationLocked}
        navigationLocked={navigationBusy}
        model={workspace.model}
        modelBusy={pendingModelAction !== null || modelDraftDirty}
        onSelectModel={quickSelectModel}
        onNavigate={navigate}
        onLocaleChange={(locale) => void saveLocale(locale)}
      />
      {leaveConfirmation !== null && (
        <ConfirmationDialog
          request={leaveConfirmation}
          onDecision={decideLeave}
        />
      )}
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
            if (packageSyncFailed) retryPackageRead();
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
        {(screen === "home" || screen === "library") && (
          <HomeScreen
            libraryOnly={screen === "library"}
            worldLibrary={{
              worlds: workspace.worlds,
              renderWorldBackupExport: (world) => (
                <WorldBackupExportButton
                  client={client}
                  worldId={world.worldId}
                  label="导出备份"
                  disabled={importPending || archivePending || samplePending}
                  onBusyChange={setArchivePending}
                  onFailure={() => workspaceTarget.recover()}
                />
              ),
              onCreateWorld: () => navigate("create"),
              onOpenWorld: openWorld,
              onRenameWorld: async (world, name) => {
                try {
                  await renameWorld(world.worldId, name);
                  return true;
                } catch (error) {
                  report(error);
                  return false;
                }
              },
              onDeleteWorld: (world) => void deleteWorld(world),
            }}
            contentLibrary={{
              contentPackages: workspace.contentPackages,
              selectedPackageId: selected,
              samplePending,
              onCreatePackage: () => setPackageDialogOpen(true),
              onCreateSamplePackage: () => void createSamplePackage(),
              onOpenPackage: (packageId) => void openPackage(packageId),
              onRenamePackage: (item, name) =>
                renamePackage(name, item.localId),
              onDeletePackage: (item) =>
                void contentCommand("content.delete", item.localId),
            }}
            imports={{
              worldBackupImport: (
                <WorldBackupImportButton
                  client={client}
                  disabled={importPending || samplePending || archivePending}
                  onBusyChange={setArchivePending}
                  onImported={acceptWorld}
                  onFailure={() => workspaceTarget.recover()}
                />
              ),
              sillyTavernContentImport: (
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
              ),
              importArchive,
              importPending: importPending || archivePending,
              onImportArchiveChange: (archive) => {
                setImportArchive(archive);
                setNotice("");
              },
              onImportPackage: () => void importPackage(),
            }}
            model={{
              modelConfigured: workspace.model.configured,
              activeModelName: activeModel?.name ?? null,
              onConfigureModel: () => navigate("model"),
            }}
            currentPresetName={currentPresetName}
            onOpenPlayPresets={() => navigate("plays")}
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
            onNavigationProtectionChange={setPlayPresetNavigation}
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
            onNavigationProtectionChange={setChildNavigation}
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
