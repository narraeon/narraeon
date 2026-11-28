import type { SampleContentPackageId } from "../protocol/sampleContentPackages.ts";
import { SampleStoryDialog } from "./SampleStoryDialog.tsx";
import { gameplayLabel, type Gameplay } from "../protocol/gameplay.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { useRef, useState, type ReactNode } from "react";
import { relativeActivityTime } from "./worldActivityPresentation.ts";
import { HomeCardActions } from "./HomeCardActions.tsx";
import {
  ConfirmationDialog,
  type ConfirmationRequest,
} from "./ConfirmationDialog.tsx";

export interface HomeContentPackage {
  localId: string;
  title: string;
  gameplay: Gameplay;
  status: "usable" | "needs_repair";
}

export interface HomeWorld {
  worldId: string;
  title: string;
  gameplay: Gameplay;
  lastActivityAt: number | null;
  excerpt: string | null;
  playerTurns: number;
  /** No turn ledger yet; opening the world runs the storage upgrade. */
  pendingUpgrade?: true;
}

interface HomeDeletion {
  kind: "world" | "package";
  id: string;
  title: string;
}

export function HomeScreen({
  libraryOnly = false,
  worldLibrary: {
    worlds,
    renderWorldBackupExport,
    onCreateWorld,
    onOpenWorld,
    onRenameWorld,
    onDeleteWorld,
  },
  contentLibrary: {
    contentPackages,
    samplePending = false,
    onCreatePackage,
    onCreateSamplePackage,
    onOpenPackage,
    onRenamePackage,
    onDeletePackage,
  },
  imports: {
    worldBackupImport,
    sillyTavernContentImport,
    importArchive,
    importPending,
    onImportArchiveChange,
    onImportPackage,
  },
  model: { modelConfigured, onConfigureModel },
  currentPresetName,
  onOpenPlayPresets = () => undefined,
}: {
  libraryOnly?: boolean;
  worldLibrary: {
    worlds: HomeWorld[];
    renderWorldBackupExport?: (world: HomeWorld) => ReactNode;
    onCreateWorld: () => void;
    onOpenWorld: (worldId: string) => void;
    onRenameWorld: (
      world: HomeWorld,
      name: string,
    ) => void | boolean | Promise<void | boolean>;
    onDeleteWorld: (world: HomeWorld) => void;
  };
  contentLibrary: {
    contentPackages: HomeContentPackage[];
    samplePending?: boolean;
    onCreatePackage: () => void;
    onCreateSamplePackage: (id: SampleContentPackageId) => Promise<void>;
    onOpenPackage: (packageId: string) => void;
    onRenamePackage: (
      item: HomeContentPackage,
      name: string,
    ) => void | boolean | Promise<void | boolean>;
    onDeletePackage: (item: HomeContentPackage) => void;
  };
  imports: {
    worldBackupImport?: ReactNode;
    sillyTavernContentImport?: ReactNode;
    importArchive: File | null;
    importPending: boolean;
    onImportArchiveChange: (archive: File | null) => void;
    onImportPackage: () => void;
  };
  model: {
    modelConfigured: boolean;
    onConfigureModel: () => void;
  };
  currentPresetName: string | null;
  onOpenPlayPresets?: () => void;
}): React.JSX.Element {
  const [renamingWorldId, setRenamingWorldId] = useState<string | null>(null);
  const [worldNameDraft, setWorldNameDraft] = useState("");
  const [renamingPackageId, setRenamingPackageId] = useState<string | null>(
    null,
  );
  const [packageNameDraft, setPackageNameDraft] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameFailure, setRenameFailure] = useState("");
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest<HomeDeletion> | null>(null);
  const [sampleOpener, setSampleOpener] = useState<HTMLButtonElement | null>(
    null,
  );
  const [openCardActions, setOpenCardActions] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const pending = importPending || samplePending;
  const usablePackageCount = contentPackages.filter(
    ({ status }) => status === "usable",
  ).length;
  const repairPackageCount = contentPackages.length - usablePackageCount;

  function toggleCardActions(id: string, open: boolean): void {
    setOpenCardActions((current) =>
      open ? id : current === id ? null : current,
    );
  }

  function requestDeletion(
    action: HomeDeletion,
    opener: HTMLButtonElement,
  ): void {
    setConfirmation({
      action,
      opener,
      fallback:
        opener
          .closest(".home-world-card-actions")
          ?.querySelector<HTMLButtonElement>("button[aria-expanded]") ?? null,
      message: uiText(
        action.kind === "world"
          ? "删除世界“{title}”？它的全部提交、历史和存档都会从本机移除，且无法撤销。"
          : "删除内容包“{title}”？它会从本机移除，且无法撤销。已创建的世界不受影响。",
        { title: action.title },
      ),
      confirmLabel: uiText("删除"),
    });
  }

  function decideDeletion(confirmed: boolean): void {
    setConfirmation(null);
    if (!confirmed || pending || confirmation === null) return;
    const { kind, id, title } = confirmation.action;
    if (kind === "world") {
      const world = worlds.find((item) => item.worldId === id);
      if (world?.title === title) onDeleteWorld(world);
    } else {
      const item = contentPackages.find((item) => item.localId === id);
      if (item?.title === title) onDeletePackage(item);
    }
  }

  return (
    <main className="home-dashboard">
      <header className="home-page-heading">
        <h1>{uiText(libraryOnly ? "内容库" : "世界工作区")}</h1>
        {!libraryOnly && (
          <p>{uiText("选择一个世界继续故事，或从内容包开始创作。")}</p>
        )}
      </header>
      <div
        className="home-library-grid"
        data-library-only={libraryOnly || undefined}
      >
        <section
          className="home-surface home-world-library"
          aria-labelledby="home-worlds-title"
          hidden={libraryOnly}
        >
          <header className="home-section-heading">
            <div>
              <h2 id="home-worlds-title">{uiText("继续游玩")}</h2>
            </div>
            <span
              className="home-count"
              aria-label={uiText("{count} 个世界", { count: worlds.length })}
            >
              {worlds.length.toLocaleString(getWebLocale())}
            </span>
            <button type="button" disabled={pending} onClick={onCreateWorld}>
              {uiText("新建世界")}
            </button>
            {worldBackupImport}
          </header>

          {worlds.length > 0 ? (
            <div className="home-world-grid">
              {worlds.map((world) => (
                <div className="home-world-card-shell" key={world.worldId}>
                  <button
                    className="home-world-card"
                    type="button"
                    aria-label={uiText("打开世界：{title}", {
                      title: world.title,
                    })}
                    disabled={pending}
                    onClick={() => onOpenWorld(world.worldId)}
                  >
                    <span className="home-world-card-story">
                      <strong>{world.title}</strong>
                      <small className="home-world-card-gameplay">
                        {gameplayLabel(world.gameplay, getWebLocale())}
                      </small>
                      <span className="home-world-card-activity">
                        {world.pendingUpgrade === true ? (
                          <span>{uiText("待升级")}</span>
                        ) : world.lastActivityAt == null ? (
                          <span>{uiText("活动时间未记录")}</span>
                        ) : (
                          <time
                            dateTime={new Date(
                              world.lastActivityAt,
                            ).toISOString()}
                            title={new Date(
                              world.lastActivityAt,
                            ).toLocaleString(getWebLocale())}
                          >
                            {relativeActivityTime(world.lastActivityAt)}
                          </time>
                        )}
                        {world.pendingUpgrade === true ? null : (
                          <span>
                            {uiText(
                              world.playerTurns === 1
                                ? "1 回合"
                                : "{count} 回合",
                              {
                                count: (world.playerTurns ?? 0).toLocaleString(
                                  getWebLocale(),
                                ),
                              },
                            )}
                          </span>
                        )}
                      </span>
                      {world.excerpt == null ? null : (
                        <span
                          className="home-world-card-excerpt"
                          title={world.excerpt}
                        >
                          {world.excerpt}
                        </span>
                      )}
                    </span>
                    <span className="home-world-card-action">
                      {uiText("进入世界")}
                      <span aria-hidden="true">→</span>
                    </span>
                  </button>
                  <HomeCardActions
                    label={uiText("世界操作：{title}", { title: world.title })}
                    open={
                      !libraryOnly &&
                      openCardActions === `world:${world.worldId}`
                    }
                    onToggle={(open) =>
                      toggleCardActions(`world:${world.worldId}`, open)
                    }
                  >
                    {renderWorldBackupExport?.(world)}
                    <button
                      className="home-world-rename"
                      type="button"
                      aria-label={uiText("重命名世界：{title}", {
                        title: world.title,
                      })}
                      disabled={pending}
                      onClick={() => {
                        setOpenCardActions(null);
                        setRenameFailure("");
                        setRenamingWorldId(world.worldId);
                        setWorldNameDraft(world.title);
                      }}
                    >
                      {uiText("重命名")}
                    </button>
                    <button
                      className="home-world-delete"
                      type="button"
                      aria-label={uiText("删除世界：{title}", {
                        title: world.title,
                      })}
                      disabled={pending}
                      onClick={(event) =>
                        requestDeletion(
                          {
                            kind: "world",
                            id: world.worldId,
                            title: world.title,
                          },
                          event.currentTarget,
                        )
                      }
                    >
                      {uiText("删除")}
                    </button>
                  </HomeCardActions>
                  {renamingWorldId === world.worldId ? (
                    <form
                      className="home-world-rename-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = worldNameDraft.trim();
                        if (name === "" || name === world.title) return;
                        if (renamePending) return;
                        setRenamePending(true);
                        setRenameFailure("");
                        void Promise.resolve(onRenameWorld(world, name))
                          .then((confirmed) => {
                            if (confirmed !== false)
                              setRenamingWorldId((current) =>
                                current === world.worldId ? null : current,
                              );
                          })
                          .catch((error: unknown) =>
                            setRenameFailure(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          )
                          .finally(() => setRenamePending(false));
                      }}
                    >
                      {renameFailure ? (
                        <p role="alert">{renameFailure}</p>
                      ) : null}
                      <label>
                        <span>{uiText("世界名称")}</span>
                        <input
                          aria-label={uiText("世界名称")}
                          autoFocus
                          maxLength={160}
                          disabled={renamePending}
                          value={worldNameDraft}
                          onChange={(event) =>
                            setWorldNameDraft(event.currentTarget.value)
                          }
                        />
                      </label>
                      <div className="button-row">
                        <button
                          type="submit"
                          className="primary-button"
                          aria-label={uiText("保存世界名称")}
                          disabled={
                            renamePending ||
                            worldNameDraft.trim() === "" ||
                            worldNameDraft.trim() === world.title
                          }
                        >
                          {uiText("保存")}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setRenamingWorldId(null)}
                        >
                          {uiText("取消")}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty-world">
              <div>
                <h3>{uiText("还没有正在游玩的世界")}</h3>
                <p>
                  {uiText(
                    "先新建内容包，或上传一份 ZIP，再整理开场与世界文档并创建独立世界。",
                  )}
                </p>
              </div>
            </div>
          )}
        </section>

        <section
          className="home-surface home-content-library"
          aria-labelledby="home-content-title"
        >
          <header className="home-section-heading">
            <div>
              <h2 id="home-content-title">{uiText("内容包")}</h2>
            </div>
            <button type="button" disabled={pending} onClick={onCreatePackage}>
              {uiText("新建内容包")}
            </button>
            <button
              type="button"
              disabled={pending}
              aria-haspopup="dialog"
              onClick={(event) => setSampleOpener(event.currentTarget)}
            >
              {uiText("从内置故事新建")}
            </button>
          </header>

          {!modelConfigured && (
            <button type="button" disabled={pending} onClick={onConfigureModel}>
              {uiText("配置模型连接")}
            </button>
          )}

          <div className="home-content-layout">
            <div>
              {contentPackages.length > 0 ? (
                <div className="home-package-list">
                  {contentPackages.map((item) => (
                    <div className="home-world-card-shell" key={item.localId}>
                      <button
                        className="home-package-card"
                        type="button"
                        aria-label={uiText("打开内容包：{name}", {
                          name: item.title,
                        })}
                        aria-describedby={
                          item.status === "needs_repair"
                            ? `home-package-gameplay-${item.localId} home-package-repair-${item.localId}`
                            : `home-package-gameplay-${item.localId}`
                        }
                        disabled={pending}
                        onClick={() => onOpenPackage(item.localId)}
                      >
                        <span className="home-package-card-heading">
                          <strong>{item.title}</strong>
                          {item.status === "needs_repair" && (
                            <span className="home-package-state">
                              {uiText("待修复")}
                            </span>
                          )}
                        </span>
                        <span
                          className="home-package-card-gameplay"
                          id={`home-package-gameplay-${item.localId}`}
                        >
                          {gameplayLabel(item.gameplay, getWebLocale())}
                        </span>
                        {item.status === "needs_repair" && (
                          <span
                            className="home-package-card-copy"
                            id={`home-package-repair-${item.localId}`}
                          >
                            {uiText("打开并修复内容包中的问题")}
                          </span>
                        )}
                      </button>
                      <HomeCardActions
                        label={uiText("内容包操作：{title}", {
                          title: item.title,
                        })}
                        open={openCardActions === `package:${item.localId}`}
                        onToggle={(open) =>
                          toggleCardActions(`package:${item.localId}`, open)
                        }
                      >
                        <button
                          className="home-world-rename"
                          type="button"
                          aria-label={uiText("重命名内容包：{title}", {
                            title: item.title,
                          })}
                          disabled={pending}
                          onClick={() => {
                            setOpenCardActions(null);
                            setRenameFailure("");
                            setRenamingPackageId(item.localId);
                            setPackageNameDraft(item.title);
                          }}
                        >
                          {uiText("重命名")}
                        </button>
                        <button
                          className="home-world-delete"
                          type="button"
                          aria-label={uiText("删除内容包：{title}", {
                            title: item.title,
                          })}
                          disabled={pending}
                          onClick={(event) =>
                            requestDeletion(
                              {
                                kind: "package",
                                id: item.localId,
                                title: item.title,
                              },
                              event.currentTarget,
                            )
                          }
                        >
                          {uiText("删除")}
                        </button>
                      </HomeCardActions>
                      {renamingPackageId === item.localId ? (
                        <form
                          className="home-world-rename-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const name = packageNameDraft.trim();
                            if (name === "" || name === item.title) return;
                            if (renamePending) return;
                            setRenamePending(true);
                            setRenameFailure("");
                            void Promise.resolve(onRenamePackage(item, name))
                              .then((confirmed) => {
                                if (confirmed !== false)
                                  setRenamingPackageId((current) =>
                                    current === item.localId ? null : current,
                                  );
                              })
                              .catch((error: unknown) =>
                                setRenameFailure(
                                  error instanceof Error
                                    ? error.message
                                    : String(error),
                                ),
                              )
                              .finally(() => setRenamePending(false));
                          }}
                        >
                          {renameFailure ? (
                            <p role="alert">{renameFailure}</p>
                          ) : null}
                          <label>
                            <span>{uiText("内容包标题")}</span>
                            <input
                              aria-label={uiText("内容包标题")}
                              autoFocus
                              maxLength={160}
                              disabled={renamePending}
                              value={packageNameDraft}
                              onChange={(event) =>
                                setPackageNameDraft(event.currentTarget.value)
                              }
                            />
                          </label>
                          <div className="button-row">
                            <button
                              type="submit"
                              className="primary-button"
                              aria-label={uiText("保存内容包标题")}
                              disabled={
                                renamePending ||
                                packageNameDraft.trim() === "" ||
                                packageNameDraft.trim() === item.title
                              }
                            >
                              {uiText("保存")}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => setRenamingPackageId(null)}
                            >
                              {uiText("取消")}
                            </button>
                          </div>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="home-empty-packages">
                  <h3>{uiText("从一个故事开始")}</h3>
                  <p>
                    {uiText(
                      "选好题材，读开场再创建世界。你也可以新建或导入自己的内容包。",
                    )}
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={pending}
                    aria-haspopup="dialog"
                    onClick={(event) => setSampleOpener(event.currentTarget)}
                  >
                    {uiText("挑一个故事开玩")}
                  </button>
                </div>
              )}
            </div>

            {sillyTavernContentImport}
            <details className="home-import-disclosure">
              <summary>{uiText("导入内容包 ZIP")}</summary>
              <form
                className="home-import-card"
                onSubmit={(event) => {
                  event.preventDefault();
                  onImportPackage();
                }}
              >
                <div>
                  <h3>{uiText("导入 ZIP")}</h3>
                  <p>
                    {uiText(
                      "选择本应用导出或结构相同的内容包 ZIP。导入会创建独立副本，不会覆盖现有内容包。",
                    )}
                  </p>
                </div>
                <div className="home-import-picker">
                  <input
                    ref={zipInput}
                    type="file"
                    hidden
                    accept=".zip,application/zip,application/x-zip-compressed"
                    aria-label={uiText("内容包 ZIP 文件")}
                    disabled={pending}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) onImportArchiveChange(file);
                    }}
                  />
                  <button
                    type="button"
                    aria-describedby="home-zip-picker-status"
                    disabled={pending}
                    onClick={() => zipInput.current?.click()}
                  >
                    {uiText("选择内容包 ZIP")}
                  </button>
                  <span id="home-zip-picker-status" role="status">
                    {importArchive === null
                      ? uiText("尚未选择")
                      : `${importArchive.name} · ${formatFileSize(importArchive.size)}`}
                  </span>
                </div>
                <button
                  type="submit"
                  disabled={importArchive === null || pending}
                >
                  {importPending ? uiText("正在导入…") : uiText("导入 ZIP")}
                </button>
              </form>
            </details>
          </div>
        </section>
      </div>
      <footer className="home-status-line" aria-label={uiText("工作区状态")}>
        <button type="button" disabled={pending} onClick={onOpenPlayPresets}>
          {uiText("当前编排方案")} · {currentPresetName ?? uiText("尚未选择")}
        </button>
        <span>
          {uiText("可用内容包")} · {usablePackageCount}
          {repairPackageCount > 0 &&
            uiText(" · {count} 份待修复", { count: repairPackageCount })}
        </span>
      </footer>
      {sampleOpener !== null && (
        <SampleStoryDialog
          pending={samplePending}
          opener={sampleOpener}
          onCancel={() => setSampleOpener(null)}
          onChoose={onCreateSamplePackage}
        />
      )}
      {confirmation !== null && (
        <ConfirmationDialog
          request={confirmation}
          onDecision={decideDeletion}
        />
      )}
    </main>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
