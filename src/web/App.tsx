import { useEffect, useState } from "react";

import { maxPortableContentArchiveBytes } from "../protocol/contentTree.ts";
import type { ModelConnectionLibraryView } from "../protocol/modelConnections.ts";
import type { AppLocale, AppPreferences } from "../protocol/appPreferences.ts";
import type {
  ContentTreeFile,
  SettingImprovementStartMode,
} from "../protocol/v1.ts";
import { firstPartyPlayPresetTemplatesForLocale } from "../shared/first-party-play-preset-templates.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { createClientId } from "./ClientId.ts";
import { setWebLocale, uiText } from "./i18n.ts";
import {
  ContentTreeEditor,
  type ContentTreeIssue,
} from "./ContentTreeEditor.tsx";
import { HomeScreen } from "./HomeScreen.tsx";
import { ModelConnectionScreen } from "./ModelConnectionScreen.tsx";
import { PlayPresetScreen } from "./PlayPresetScreen.tsx";
import { PromptPreviewScreen } from "./PromptPreviewScreen.tsx";
import {
  SettingImprovementPanel,
  type SettingImprovementCandidateResult,
  type SettingImprovementPhase,
  type SettingImprovementPlanResult,
  type SettingImprovementProgress,
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
  displayName: string;
  status: "usable" | "needs_repair";
  files?: ContentTreeFile[];
}

interface PackageDetail extends PackageSummary {
  files: ContentTreeFile[];
  issues: ContentTreeIssue[];
}

type Screen =
  "home" | "content" | "plays" | "model" | "create" | "preview" | "world";
type ContentMode = "files" | "improve";

interface SettingImprovementFailure {
  message: string;
  mode: SettingImprovementStartMode;
}

export function App({ client }: { client: RuntimeClient }): React.JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [contentMode, setContentMode] = useState<ContentMode>("files");
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
  const [improvementGoal, setImprovementGoal] = useState("");
  const [improvementContextPaths, setImprovementContextPaths] = useState<
    string[]
  >([]);
  const [improvementId, setImprovementId] = useState("");
  const [improvementPhase, setImprovementPhase] =
    useState<SettingImprovementPhase>("idle");
  const [improvementPlan, setImprovementPlan] =
    useState<SettingImprovementPlanResult | null>(null);
  const [improvementCandidate, setImprovementCandidate] =
    useState<SettingImprovementCandidateResult | null>(null);
  const [improvementProgress, setImprovementProgress] =
    useState<SettingImprovementProgress | null>(null);
  const [improvementProgressNow, setImprovementProgressNow] = useState(0);
  const [improvementFailure, setImprovementFailure] =
    useState<SettingImprovementFailure | null>(null);
  const [worldId, setWorldId] = useState("");
  const [notice, setNotice] = useState(uiText("正在读取工作区…"));
  const [localeSaving, setLocaleSaving] = useState(false);

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

  // The start/confirm request stays open for the whole run, so progress can
  // only arrive out of band. A failed poll keeps the previous snapshot and
  // still advances the clock, which is what makes a stall visible.
  useEffect(() => {
    if (
      improvementId === "" ||
      (improvementPhase !== "planning" && improvementPhase !== "generating")
    )
      return;
    let active = true;
    const poll = async (): Promise<void> => {
      try {
        const next = await client.request<SettingImprovementProgress>({
          type: "setting-improvement.progress",
          improvementId,
        });
        if (active) setImprovementProgress(next);
      } catch {
        // A failed poll does not interrupt generation or replace known progress.
      } finally {
        if (active) setImprovementProgressNow(Date.now());
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, improvementId, improvementPhase]);

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

  async function openPackage(
    packageId: string,
    nextMode: ContentMode = "files",
  ): Promise<void> {
    try {
      const package_ = await client.request<PackageDetail>({
        type: "content.read",
        packageId,
      });
      const packageFiles = package_.files;
      setSelected(packageId);
      setPackageDetail(package_);
      setCurrentPackageFiles(packageFiles.map((file) => ({ ...file })));
      setImprovementContextPaths([]);
      setImprovementFailure(null);
      setImprovementProgress(null);
      setFiles(packageFiles.map((file) => ({ ...file })));
      setFilesDirty(false);
      setContentMode(nextMode);
      setScreen("content");
    } catch (error: unknown) {
      report(error);
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

  async function renamePackage(name: string): Promise<void> {
    try {
      await client.request({
        type: "content.rename",
        packageId: selected,
        name,
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

  async function startImprovement(
    mode: SettingImprovementStartMode,
  ): Promise<void> {
    if (filesDirty) {
      setNotice(uiText("请先保存手动编辑，再开始 AI 设定完善。"));
      return;
    }
    const id = createClientId("improvement");
    setImprovementId(id);
    setImprovementPhase(mode === "plan_first" ? "planning" : "generating");
    setImprovementPlan(null);
    setImprovementCandidate(null);
    setImprovementProgress(null);
    setImprovementFailure(null);
    setNotice("");
    try {
      const outcome = await client.request<
        SettingImprovementPlanResult | SettingImprovementCandidateResult
      >({
        type: "setting-improvement.start",
        improvementId: id,
        packageId: selected,
        goal: improvementGoal,
        mode,
        contextPaths: improvementContextPaths,
      });
      if (outcome.kind === "plan") {
        setImprovementPlan(outcome);
        setImprovementPhase("planned");
        setNotice(uiText("创作计划已生成；计划阶段只读取了当前设定。"));
      } else {
        setImprovementCandidate(outcome);
        setImprovementPhase("ready");
        setNotice(uiText("候选已通过机械检查；可整批应用或放弃。"));
      }
    } catch (error: unknown) {
      setImprovementId("");
      setImprovementPhase("idle");
      setImprovementFailure({
        message: error instanceof Error ? error.message : uiText("操作失败"),
        mode,
      });
      report(error);
    }
  }

  async function confirmImprovement(): Promise<void> {
    setImprovementPhase("generating");
    setImprovementProgress(null);
    try {
      const candidate = await client.request<SettingImprovementCandidateResult>(
        {
          type: "setting-improvement.confirm",
          improvementId,
        },
      );
      setImprovementCandidate(candidate);
      setImprovementPhase("ready");
      setNotice(uiText("候选已通过机械检查；可整批应用或放弃。"));
    } catch (error: unknown) {
      setImprovementPhase("planned");
      report(error);
    }
  }

  async function reviseImprovementPlan(feedback: string): Promise<void> {
    setImprovementPhase("planning");
    setImprovementProgress(null);
    try {
      const plan = await client.request<SettingImprovementPlanResult>({
        type: "setting-improvement.revise-plan",
        improvementId,
        feedback,
      });
      setImprovementPlan(plan);
      setImprovementPhase("planned");
      setNotice(uiText("已按你的意见重出创作计划。"));
    } catch (error: unknown) {
      setImprovementPhase("planned");
      report(error);
    }
  }

  async function reviseImprovementCandidate(feedback: string): Promise<void> {
    setImprovementPhase("generating");
    setImprovementProgress(null);
    try {
      const candidate = await client.request<SettingImprovementCandidateResult>(
        {
          type: "setting-improvement.revise-candidate",
          improvementId,
          feedback,
        },
      );
      setImprovementCandidate(candidate);
      setImprovementPhase("ready");
      setNotice(uiText("候选已按你的意见修改并重新通过机械检查。"));
    } catch (error: unknown) {
      setImprovementPhase("ready");
      report(error);
    }
  }

  async function applyImprovement(): Promise<void> {
    setImprovementPhase("applying");
    try {
      await client.request({
        type: "setting-improvement.apply",
        improvementId,
      });
      setImprovementId("");
      setImprovementPlan(null);
      setImprovementCandidate(null);
      setImprovementGoal("");
      setImprovementContextPaths([]);
      setImprovementFailure(null);
      setImprovementProgress(null);
      setImprovementPhase("idle");
      await refresh();
      await openPackage(selected, "improve");
      setNotice(uiText("设定候选已整批应用。"));
    } catch (error: unknown) {
      setImprovementPhase("ready");
      report(error);
    }
  }

  async function discardImprovement(): Promise<void> {
    const previousPhase = improvementCandidate === null ? "planned" : "ready";
    setImprovementPhase("discarding");
    try {
      await client.request({
        type: "setting-improvement.discard",
        improvementId,
      });
      setImprovementId("");
      setImprovementPlan(null);
      setImprovementCandidate(null);
      setImprovementFailure(null);
      setImprovementProgress(null);
      setImprovementPhase("idle");
      setNotice(uiText("设定候选已放弃，当前树未改变。"));
    } catch (error: unknown) {
      setImprovementPhase(previousPhase);
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
  const improvementActive = improvementId.length > 0;
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
        onOpenWorld={async (nextWorldId) => {
          await refresh();
          setWorldId(nextWorldId);
        }}
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
      {screen === "content" && (
        <section
          className="content-workbench"
          aria-labelledby="content-workbench-title"
        >
          <header className="content-workbench-header">
            <div>
              <p className="eyebrow">CONTENT PACKAGE</p>
              <h2 id="content-workbench-title">
                {selectedPackage?.displayName ?? uiText("内容包")}
              </h2>
            </div>
            <div
              className="content-mode-switch"
              aria-label={uiText("内容包编辑方式")}
            >
              <button
                type="button"
                className={
                  contentMode === "files" ? "selected-mode" : "secondary-button"
                }
                aria-pressed={contentMode === "files"}
                disabled={improvementActive}
                onClick={() => setContentMode("files")}
              >
                {uiText("手动编辑")}
              </button>
              <button
                type="button"
                className={
                  contentMode === "improve"
                    ? "selected-mode"
                    : "secondary-button"
                }
                aria-pressed={contentMode === "improve"}
                onClick={() => setContentMode("improve")}
              >
                {uiText("AI 完善")}
              </button>
            </div>
          </header>

          {contentMode === "files" ? (
            <ContentTreeEditor
              files={files}
              status={
                selectedPackageDetail?.status ??
                selectedPackage?.status ??
                "needs_repair"
              }
              issues={selectedPackageDetail?.issues ?? []}
              dirty={filesDirty}
              onFilesChange={(nextFiles) => {
                setFiles(nextFiles);
                setFilesDirty(true);
              }}
              onSave={() => void savePackage()}
              onReset={() => {
                setFiles(currentPackageFiles.map((file) => ({ ...file })));
                setFilesDirty(false);
                setNotice(uiText("已放弃未保存修改；内容包当前树未改变。"));
              }}
              onCopy={() => void contentCommand("content.copy")}
              onExport={() => void exportPackage()}
              onDelete={() => void contentCommand("content.delete")}
              displayName={selectedPackage?.displayName ?? selected}
              onRename={(name) => void renamePackage(name)}
            />
          ) : (
            <SettingImprovementPanel
              packageName={selectedPackage?.displayName ?? selected}
              packageStatus={selectedPackage?.status ?? "needs_repair"}
              modelConfigured={workspace.model.configured}
              currentFiles={currentPackageFiles}
              hasUnsavedFileDraft={filesDirty}
              contextPaths={improvementContextPaths}
              contextLocked={improvementActive}
              phase={improvementPhase}
              goal={improvementGoal}
              plan={improvementPlan}
              candidate={improvementCandidate}
              progress={improvementProgress}
              progressNow={improvementProgressNow}
              failure={improvementFailure}
              onGoalChange={setImprovementGoal}
              onContextPathsChange={setImprovementContextPaths}
              onStart={(mode) => void startImprovement(mode)}
              onConfirm={() => void confirmImprovement()}
              onRevisePlan={(feedback) => void reviseImprovementPlan(feedback)}
              onReviseCandidate={(feedback) =>
                void reviseImprovementCandidate(feedback)
              }
              onApply={() => void applyImprovement()}
              onDiscard={() => void discardImprovement()}
              onRetry={() => {
                if (improvementFailure !== null)
                  void startImprovement(improvementFailure.mode);
              }}
              onDismissFailure={() => {
                setImprovementFailure(null);
                setImprovementProgress(null);
              }}
              onConfigureModel={() => setScreen("model")}
            />
          )}
        </section>
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
                {item.displayName}
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
