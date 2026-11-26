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
import {
  saveProtagonistCustomization,
  type ProtagonistCustomization,
} from "./ProtagonistCustomization.ts";
import { WorldCreation, type CreatedWorldReceipt } from "./WorldCreation.ts";
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
import type { OrchestrationSurface } from "../protocol/orchestrationSession.ts";
import type { PromptRoleOrderTarget } from "../protocol/promptRoleOrder.ts";
import { PromptPreviewScreen } from "./PromptPreviewScreen.tsx";
import { SettingImprovementPanel } from "./SettingImprovementPanel.tsx";
import {
  authoringConversationActions,
  useAuthoringWorkspace,
} from "./useAuthoringWorkspace.ts";
import { WorldPage, type WorldComposerDraft } from "./WorldPage.tsx";
import {
  readOrchestrationAiWorkbench,
  saveOrchestrationAiWorkbench,
  type OrchestrationAiWorkbenchDraft,
} from "./orchestration-ai-workbench.ts";
import {
  idleWorkspaceNavigation,
  parseWorkspaceHash,
  readBrowserWorkspaceEntry,
  returnToBrowserWorkspaceEntry,
  sameBrowserWorkspaceEntry,
  workspaceHash,
  writeBrowserWorkspaceEntry,
  type BrowserWorkspaceEntry,
  type CreationSelection,
  type WorkspaceLocation,
  type WorkspaceNavigationProtection,
} from "./WorkspaceLocation.ts";

interface Workspace {
  scope?: "orchestration";
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

interface ModelSettingsVisit {
  origin: BrowserWorkspaceEntry;
  settings: BrowserWorkspaceEntry;
  worldDraft?: WorldComposerDraft;
  orchestration?: true;
}

export function App({ client }: { client: RuntimeClient }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const workspaceReceiptVersion = useRef(0);
  const workspaceReadScope = useRef<"full" | undefined>(undefined);
  const workspaceHasInstances = useRef(false);
  const currentWorkspace = useEffectEvent(() => workspace);

  const [screen, setScreen] = useState<Screen>("home");
  const locationRef = useRef<WorkspaceLocation>({ screen: "home" });
  const browserEntry = useRef<BrowserWorkspaceEntry | null>(null);
  const leaveIntent = useRef<LeaveIntent | null>(null);
  const [leaveConfirmation, setLeaveConfirmation] =
    useState<ConfirmationRequest<null> | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [promptOrderNavigation, setPromptOrderNavigation] = useState<{
    id: string;
    surface: OrchestrationSurface;
    target: PromptRoleOrderTarget | undefined;
  } | null>(null);
  const [orchestrationAiEditing, setOrchestrationAiEditing] =
    useState<OrchestrationAiWorkbenchDraft | null>(
      readOrchestrationAiWorkbench,
    );
  useEffect(() => {
    saveOrchestrationAiWorkbench(orchestrationAiEditing);
  }, [orchestrationAiEditing]);
  const [presetPageVersion, setPresetPageVersion] = useState(0);
  const presetPageInstanceRef = useRef(0);
  const [selected, setSelected] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const modelSettingsVisit = useRef<ModelSettingsVisit | null>(null);
  const [confirmedModelVisit, setConfirmedModelVisit] =
    useState<ModelSettingsVisit | null>(null);
  const worldComposerDraft = useRef<WorldComposerDraft | null>(null);
  const [restoredWorldDraft, setRestoredWorldDraft] =
    useState<WorldComposerDraft | null>(null);
  const rememberWorldDraft = useCallback((draft: WorldComposerDraft) => {
    worldComposerDraft.current = draft;
  }, []);
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
  const filesDirty = screen === "content" && authoring.dirty;
  const files = authoring.files;
  const packageDetail = authoring.target?.packageDetail ?? null;
  const [worldId, setWorldId] = useState("");
  const [newProtagonist, setNewProtagonist] = useState<{
    worldId: string;
    customization: ProtagonistCustomization;
  } | null>(null);
  const clearNewProtagonist = useCallback(() => setNewProtagonist(null), []);
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
    (screen === "content" && authoring.view?.runStatus === "running") ||
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

  function switchLocation(
    next: WorkspaceLocation,
    mode?: "replace",
    creation?: CreationSelection,
  ): void {
    const previous = locationRef.current;
    const hash = workspaceHash(next);
    const entry = readBrowserWorkspaceEntry();
    const modelVisit = modelSettingsVisit.current;
    if (
      modelVisit !== null &&
      (next.screen !== "model" ||
        !sameBrowserWorkspaceEntry(modelVisit.settings, entry))
    )
      modelSettingsVisit.current = null;
    packageOpenRequest.current += 1;
    packageReadTarget.current?.dispose();
    packageRetryEntry.current = null;
    setPackageSyncFailed(false);
    if (previous.screen !== next.screen) presetPageInstanceRef.current += 1;
    if (next.screen !== "plays") setPromptOrderNavigation(null);
    if (workspaceHash(previous) !== hash) {
      setRestoredWorldDraft(
        next.screen === "world" &&
          modelVisit?.worldDraft?.worldId === next.worldId &&
          sameBrowserWorkspaceEntry(modelVisit.origin, entry)
          ? modelVisit.worldDraft
          : null,
      );
      worldCreation.clear();
      authoringWorkspace.close();
    }
    locationRef.current = next;
    if (next.screen === "content") setSelected(next.packageId);
    const creationSelection =
      next.screen === "create"
        ? (creation ?? { packageId: selected, templateId: "" })
        : undefined;
    if (creationSelection !== undefined) {
      setSelected(creationSelection.packageId);
      setSelectedTemplateId(creationSelection.templateId);
    }
    if (next.screen === "world") setWorldId(next.worldId);
    if (next.screen === "plays") setSelectedPresetId(next.presetId ?? "");
    setScreen(next.screen);
    const replace = mode === "replace" || previous.screen === next.screen;
    const position = entry.position ?? browserEntry.current?.position ?? 0;
    browserEntry.current = writeBrowserWorkspaceEntry(
      hash,
      replace ? "replace" : "push",
      replace ? position : position + 1,
      creationSelection,
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
    } else if (target.screen === "create") {
      const saved = (entry ?? readBrowserWorkspaceEntry()).creationSelection;
      const packageId = saved?.packageId ?? selected;
      const exists = next.contentPackages.some(
        ({ localId }) => localId === packageId,
      );
      switchLocation(target, "replace", {
        packageId: exists
          ? packageId
          : saved === undefined
            ? (next.contentPackages[0]?.localId ?? "")
            : "",
        templateId: saved?.templateId ?? "",
      });
      if (saved?.packageId && !exists) setNotice(uiText("找不到该内容包。"));
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
            entry.creationSelection,
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
      () =>
        client.request<Workspace>({
          type: "workspace.read",
          ...(workspaceReadScope.current !== "full" &&
          (parseWorkspaceHash(window.location.hash)?.screen === "plays" ||
            (modelSettingsVisit.current?.orchestration === true &&
              parseWorkspaceHash(window.location.hash)?.screen === "model"))
            ? { scope: "orchestration" }
            : {}),
        }),
      [client],
    ),
    useCallback((next: Workspace) => {
      setWebLocale(next.preferences.locale);
      if (next.scope === "orchestration") {
        setWorkspace((current) =>
          current === null
            ? next
            : {
                ...next,
                contentPackages: current.contentPackages,
                worlds: current.worlds,
              },
        );
        setNotice("");
        return;
      }
      workspaceHasInstances.current = true;
      setWorkspace(next);
      setSelected((current) => {
        const location = locationRef.current;
        if (location.screen === "content") return location.packageId;
        if (location.screen === "create") return current;
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
                item.localId === detail.localId
                  ? {
                      ...item,
                      title: detail.title,
                      gameplay: detail.gameplay,
                      status: detail.status,
                    }
                  : item,
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
    if (
      workspace === null ||
      workspace.preferences.locale === locale ||
      localeSaving ||
      navigationProtection.current.busy
    )
      return;
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
      switchLocation({ screen: "create" }, undefined, {
        packageId: created.localId,
        templateId: "",
      });
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
        receipt: "summary",
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

  function changeCreationSelection(selection: CreationSelection): void {
    const entry = readBrowserWorkspaceEntry();
    if (locationRef.current.screen !== "create" || entry.hash !== "#/create")
      return;
    if (selection.packageId !== selected) worldCreation.clear();
    setSelected(selection.packageId);
    setSelectedTemplateId(selection.templateId);
    browserEntry.current = writeBrowserWorkspaceEntry(
      entry.hash,
      "replace",
      entry.position ?? 0,
      selection,
    );
  }

  function configureModelForCreation(): void {
    if (
      locationRef.current.screen !== "create" ||
      workspace?.model.configured !== false ||
      navigationLocked
    )
      return;
    openModelSetup();
  }

  function openModelSetup(fromOrchestration = false): void {
    const origin = readBrowserWorkspaceEntry();
    const current = locationRef.current;
    if (origin.hash !== workspaceHash(current)) return;
    const draft = worldComposerDraft.current;
    switchLocation({ screen: "model" });
    const settings = browserEntry.current;
    if (settings !== null)
      modelSettingsVisit.current = {
        origin,
        settings,
        ...(current.screen === "world" && draft?.worldId === current.worldId
          ? { worldDraft: draft }
          : {}),
        ...(fromOrchestration && current.screen === "plays"
          ? { orchestration: true }
          : {}),
      };
  }

  useEffect(() => {
    if (confirmedModelVisit === null) return;
    const stillInSettings =
      modelSettingsVisit.current === confirmedModelVisit &&
      locationRef.current.screen === "model" &&
      sameBrowserWorkspaceEntry(
        confirmedModelVisit.settings,
        readBrowserWorkspaceEntry(),
      );
    if (stillInSettings && (navigationLocked || pendingModelAction !== null))
      return;
    setConfirmedModelVisit(null);
    if (!stillInSettings || workspace?.model.configured !== true) return;
    // Traverse to the originating entry so browser Back and Forward
    // keep their original destinations. The normal restore path revalidates it.
    returnToBrowserWorkspaceEntry(
      confirmedModelVisit.origin,
      confirmedModelVisit.settings,
    );
  }, [
    confirmedModelVisit,
    navigationLocked,
    pendingModelAction,
    workspace?.model.configured,
  ]);

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
    creatingWorldRef.current = true;
    setCreatingWorld(true);
    const packageId = selected;
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
        { packageId },
        packageDetail?.localId === packageId
          ? packageDetail.treeRevision
          : undefined,
        template,
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

  function acceptCreatedWorld({
    world,
    customization,
  }: CreatedWorldReceipt): void {
    if (customization !== null) {
      saveProtagonistCustomization(world.worldId, customization);
      setNewProtagonist({ worldId: world.worldId, customization });
    }
    acceptWorld(world);
    openWorld(world.worldId);
  }

  async function rereadCreation(): Promise<void> {
    const created = await worldCreation.recover();
    if (created !== null) acceptCreatedWorld(created);
  }

  const restoreCreation = useEffectEvent(async () => {
    const created = await worldCreation.restore(client);
    if (created !== null) acceptCreatedWorld(created);
  });

  const creationLocation =
    screen === "create" ? "#/create" : screen === "content" ? selected : null;
  useEffect(() => {
    if (creationLocation !== null) void restoreCreation();
  }, [creationLocation]);

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

  function openPromptOrder(
    surface: OrchestrationSurface,
    target?: PromptRoleOrderTarget,
  ): void {
    if (navigationBusy || creatingWorldRef.current) return;
    const source = locationRef.current;
    void client
      .request<PlayPresetLibrary>({ type: "play.read" })
      .then((library) => {
        if (
          source !== locationRef.current ||
          navigationProtection.current.busy ||
          creatingWorldRef.current
        )
          return;
        const id = target?.id ?? library.currentPresetId;
        if (!library.presets.some((preset) => preset.id === id)) {
          setNotice(uiText("找不到该编排方案。"));
          return;
        }
        const open = () => {
          if (source !== locationRef.current) return;
          updateWorkspace((current) => ({ ...current, playPresets: library }));
          setPromptOrderNavigation({ id, surface, target });
          setOrchestrationAiEditing(null);
          switchLocation(
            target === undefined
              ? { screen: "plays" }
              : { screen: "plays", presetId: id },
          );
        };
        if (navigationProtection.current.dirty)
          askToLeave({ kind: "program", navigate: open });
        else open();
      })
      .catch((error: unknown) => {
        if (source === locationRef.current) report(error);
      });
  }

  function performNavigation(next: Screen, discard = false): void {
    packageOpenRequest.current += 1;
    if (
      !workspaceHasInstances.current &&
      (next === "content" || next === "create" || next === "preview")
    ) {
      workspaceReadScope.current = "full";
      const version = packageOpenRequest.current;
      void workspaceTarget
        .recover()
        .then((loaded) => {
          if (loaded?.scope === "orchestration") return;
          if (loaded !== null && packageOpenRequest.current === version) {
            if (next === "content") {
              const packageId = loaded.contentPackages[0]?.localId;
              if (packageId === undefined) setPackageDialogOpen(true);
              else void openPackage(packageId);
            } else if (next === "create") {
              switchLocation({ screen: "create" });
            } else openPromptPreview();
          }
        })
        .finally(() => {
          workspaceReadScope.current = undefined;
        });
      return;
    }
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
    else if (
      next === "model" &&
      screen === "world" &&
      !workspace?.model.configured
    )
      openModelSetup();
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
    if (
      workspaceHasInstances.current ||
      parseWorkspaceHash(destination.hash)?.screen === "plays"
    ) {
      restoreAddress(workspace, { entry: destination, discard: true });
      if (locationRef.current.screen !== "home") void refresh().catch(report);
      return;
    }
    // A direct workbench visit has no package/world index. Load the destination
    // before validating a browser entry that has just passed the leave guard.
    const version = ++packageOpenRequest.current;
    void workspaceTarget.read().then((loaded) => {
      if (
        loaded !== null &&
        version === packageOpenRequest.current &&
        sameBrowserWorkspaceEntry(destination, readBrowserWorkspaceEntry())
      )
        restoreAddress(loaded, { entry: destination, discard: true });
      else if (version === packageOpenRequest.current)
        cancelBrowserNavigation(destination);
    });
  }

  // Async preset actions retain this instance even after a later page mounts.
  const presetPageInstance = presetPageInstanceRef.current;
  const modelVisit = modelSettingsVisit.current;
  const worldContent =
    screen === "world" ? (
      <WorldPage
        showWorkspaceBack={false}
        {...(newProtagonist?.worldId === worldId
          ? { initialProtagonistCustomization: newProtagonist.customization }
          : {})}
        key={worldId}
        client={client}
        worldId={worldId}
        worldTitle={selectedWorld?.title ?? uiText("未命名世界")}
        modelConfigured={workspace.model.configured}
        activeModelProtocol={activeModel?.provider}
        onBack={() => navigate("home")}
        onConfigureModel={() => navigate("model")}
        onViewPromptOrder={openPromptOrder}
        onProtagonistCustomizationFinished={clearNewProtagonist}
        initialComposerDraft={
          restoredWorldDraft?.worldId === worldId ? restoredWorldDraft : null
        }
        onComposerDraftChange={rememberWorldDraft}
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
        onViewPromptOrder={(target) => openPromptOrder("authorPrompts", target)}
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
          saving: authoring.savingFiles,
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
        localeSaving={localeSaving}
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
            aiEditing={orchestrationAiEditing}
            onAiEditingChange={setOrchestrationAiEditing}
            onConfigureAiModel={() => {
              if (screen === "plays" && !navigationLocked) openModelSetup(true);
            }}
            initialSelectedId={selectedPresetId}
            promptOrderNavigation={promptOrderNavigation}
            onSelectionChange={(presetId) => {
              if (
                locationRef.current.screen !== "plays" ||
                window.location.hash !== workspaceHash(locationRef.current) ||
                presetPageInstanceRef.current !== presetPageInstance
              )
                return;
              if (presetId !== promptOrderNavigation?.id)
                setPromptOrderNavigation(null);
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
          />
        )}
        {screen === "model" && (
          <ModelConnectionScreen
            client={client}
            library={workspace.model}
            {...(modelVisit?.worldDraft === undefined
              ? {}
              : {
                  onReturnToWorld: () =>
                    returnToBrowserWorkspaceEntry(
                      modelVisit.origin,
                      modelVisit.settings,
                    ),
                })}
            {...(modelVisit?.orchestration === undefined
              ? {}
              : {
                  onReturnToOrchestration: () =>
                    returnToBrowserWorkspaceEntry(
                      modelVisit.origin,
                      modelVisit.settings,
                    ),
                })}
            onLibraryChange={(model) =>
              updateWorkspace((current) => ({ ...current, model }))
            }
            onConnectionActivated={() => {
              if (
                modelVisit !== null &&
                modelSettingsVisit.current === modelVisit
              )
                setConfirmedModelVisit(modelVisit);
            }}
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
            selectedTemplateId={selectedTemplateId}
            pending={creatingWorld}
            modelConfigured={workspace.model.configured}
            onSelect={(packageId) =>
              changeCreationSelection({
                packageId,
                templateId: selectedTemplateId,
              })
            }
            onTemplateSelect={(templateId) =>
              changeCreationSelection({ packageId: selected, templateId })
            }
            onCreate={(template) => void createWorld(template)}
            onNavigationProtectionChange={setChildNavigation}
            onEdit={() => navigate("content")}
            onConfigureModel={configureModelForCreation}
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
