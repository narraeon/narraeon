import { getWebLocale, uiText } from "./i18n.ts";
import { useState } from "react";

interface HomeContentPackage {
  localId: string;
  title: string;
  status: "usable" | "needs_repair";
}

interface HomeWorld {
  worldId: string;
  title: string;
}

export function HomeScreen({
  contentPackages,
  worlds,
  selectedPackageId,
  modelConfigured,
  activeModelName,
  currentPresetName,
  importArchive,
  importPending,
  onImportArchiveChange,
  onOpenPlayPresets = () => undefined,
  onCreateWorld,
  onCreatePackage,
  onImportPackage,
  onOpenPackage,
  onOpenWorld,
  onRenameWorld,
  onDeleteWorld,
}: {
  contentPackages: HomeContentPackage[];
  worlds: HomeWorld[];
  selectedPackageId: string;
  modelConfigured: boolean;
  activeModelName: string | null;
  currentPresetName: string | null;
  importArchive: File | null;
  importPending: boolean;
  onImportArchiveChange: (archive: File | null) => void;
  onOpenPlayPresets?: () => void;
  onCreateWorld: () => void;
  onCreatePackage: () => void;
  onImportPackage: () => void;
  onOpenPackage: (packageId: string) => void;
  onOpenWorld: (worldId: string) => void;
  onRenameWorld: (world: HomeWorld, name: string) => void;
  onDeleteWorld: (world: HomeWorld) => void;
}): React.JSX.Element {
  const [renamingWorldId, setRenamingWorldId] = useState<string | null>(null);
  const [worldNameDraft, setWorldNameDraft] = useState("");
  const usablePackageCount = contentPackages.filter(
    ({ status }) => status === "usable",
  ).length;
  const repairPackageCount = contentPackages.length - usablePackageCount;

  return (
    <main className="home-dashboard">
      <header className="home-page-heading">
        <h1>{uiText("世界工作区")}</h1>
        <p>{uiText("选择一个世界继续故事，或从内容包开始创作。")}</p>
      </header>
      <div className="home-library-grid">
        <section
          className="home-surface home-world-library"
          aria-labelledby="home-worlds-title"
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
            <button
              type="button"
              disabled={importPending}
              onClick={onCreateWorld}
            >
              {uiText("新建世界")}
            </button>
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
                    disabled={importPending}
                    onClick={() => onOpenWorld(world.worldId)}
                  >
                    <strong>{world.title}</strong>
                    <span className="home-world-card-action">
                      {uiText("进入世界")}
                      <span aria-hidden="true">→</span>
                    </span>
                  </button>
                  <details className="home-world-card-actions">
                    <summary
                      aria-label={uiText("世界操作：{title}", {
                        title: world.title,
                      })}
                    >
                      •••
                    </summary>
                    <div>
                      <button
                        className="home-world-rename"
                        type="button"
                        aria-label={uiText("重命名世界：{title}", {
                          title: world.title,
                        })}
                        disabled={importPending}
                        onClick={() => {
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
                        disabled={importPending}
                        onClick={() => onDeleteWorld(world)}
                      >
                        {uiText("删除")}
                      </button>
                    </div>
                  </details>
                  {renamingWorldId === world.worldId ? (
                    <form
                      className="home-world-rename-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = worldNameDraft.trim();
                        if (name === "" || name === world.title) return;
                        onRenameWorld(world, name);
                        setRenamingWorldId(null);
                      }}
                    >
                      <label>
                        <span>{uiText("世界名称")}</span>
                        <input
                          aria-label={uiText("世界名称")}
                          autoFocus
                          maxLength={160}
                          value={worldNameDraft}
                          onChange={(event) =>
                            setWorldNameDraft(event.currentTarget.value)
                          }
                        />
                      </label>
                      <div className="button-row">
                        <button
                          type="submit"
                          aria-label={uiText("保存世界名称")}
                          disabled={
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
            <button
              type="button"
              disabled={importPending}
              onClick={onCreatePackage}
            >
              {uiText("新建内容包")}
            </button>
          </header>

          <div className="home-content-layout">
            <div>
              {contentPackages.length > 0 ? (
                <div className="home-package-list">
                  {contentPackages.map((item) => (
                    <button
                      className="home-package-card"
                      key={item.localId}
                      type="button"
                      aria-label={uiText("打开内容包：{name}", {
                        name: item.title,
                      })}
                      aria-pressed={item.localId === selectedPackageId}
                      disabled={importPending}
                      onClick={() => onOpenPackage(item.localId)}
                    >
                      <span className="home-package-card-heading">
                        <strong>{item.title}</strong>
                        <span className={`home-package-state ${item.status}`}>
                          {item.status === "usable"
                            ? uiText("可用")
                            : uiText("待修复")}
                        </span>
                      </span>
                      <span className="home-package-card-copy">
                        {item.status === "usable"
                          ? uiText("可编辑、预览并创建新世界")
                          : uiText("打开并修复当前树中的问题")}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="home-empty-packages">
                  <h3>{uiText("从一组人类可读文件开始")}</h3>
                  <p>
                    {uiText("先新建或导入一份内容包，再完善开场与世界设定。")}
                  </p>
                </div>
              )}
            </div>

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
                      "选择本应用导出或遵循相同结构的内容包 ZIP；导入会创建新的本地身份，不覆盖同名内容包。",
                    )}
                  </p>
                </div>
                <label className="home-zip-picker">
                  <span>{uiText("内容包 ZIP")}</span>
                  <input
                    className="home-zip-picker-input"
                    key={
                      importArchive === null
                        ? "empty"
                        : `${importArchive.name}:${importArchive.size}:${importArchive.lastModified}`
                    }
                    type="file"
                    accept=".zip,application/zip,application/x-zip-compressed"
                    aria-label={uiText("内容包 ZIP 文件")}
                    disabled={importPending}
                    onChange={(event) =>
                      onImportArchiveChange(event.target.files?.[0] ?? null)
                    }
                  />
                  <span className="home-zip-picker-control">
                    <span aria-live="polite">
                      {importArchive === null
                        ? uiText("尚未选择")
                        : `${importArchive.name} · ${formatFileSize(importArchive.size)}`}
                    </span>
                  </span>
                </label>
                <button
                  type="submit"
                  disabled={importArchive === null || importPending}
                >
                  {importPending ? uiText("正在导入…") : uiText("导入 ZIP")}
                </button>
              </form>
            </details>
          </div>
        </section>
      </div>
      <footer className="home-status-line" aria-label={uiText("工作区状态")}>
        <span>
          {uiText("模型连接")} ·{" "}
          {modelConfigured ? activeModelName : uiText("尚未配置")}
        </span>
        <button
          type="button"
          disabled={importPending}
          onClick={onOpenPlayPresets}
        >
          {uiText("当前预设")} · {currentPresetName ?? uiText("尚未选择")}
        </button>
        <span>
          {uiText("可用内容包")} · {usablePackageCount}
          {repairPackageCount > 0 &&
            uiText(" · {count} 份待修复", { count: repairPackageCount })}
        </span>
      </footer>
    </main>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
