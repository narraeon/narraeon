import { useState } from "react";

interface HomeContentPackage {
  localId: string;
  displayName: string;
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
  onEditContent,
  onOpenPlayPresets = () => undefined,
  onCreateWorld,
  onOpenPreview,
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
  onEditContent: () => void;
  onOpenPlayPresets?: () => void;
  onCreateWorld: () => void;
  onOpenPreview: () => void;
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
    <div className="home-dashboard">
      <div className="home-primary-grid">
        <section
          className="home-surface home-world-library"
          aria-labelledby="home-worlds-title"
        >
          <header className="home-section-heading">
            <div>
              <p className="home-section-kicker">PLAY</p>
              <h2 id="home-worlds-title">继续游玩</h2>
            </div>
            <span className="home-count" aria-label={`${worlds.length} 个世界`}>
              {worlds.length.toLocaleString("zh-CN")}
            </span>
          </header>

          {worlds.length > 0 ? (
            <div className="home-world-grid">
              {worlds.map((world, index) => (
                <div className="home-world-card-shell" key={world.worldId}>
                  <button
                    className="home-world-card"
                    type="button"
                    aria-label={`打开世界：${world.title}`}
                    disabled={importPending}
                    onClick={() => onOpenWorld(world.worldId)}
                  >
                    <span className="home-world-card-meta">
                      世界 {String(index + 1).padStart(2, "0")}
                    </span>
                    <strong>{world.title}</strong>
                    <span className="home-world-card-action">
                      进入世界 <span aria-hidden="true">→</span>
                    </span>
                  </button>
                  <div className="home-world-card-actions">
                    <button
                      className="home-world-rename"
                      type="button"
                      aria-label={`重命名世界：${world.title}`}
                      disabled={importPending}
                      onClick={() => {
                        setRenamingWorldId(world.worldId);
                        setWorldNameDraft(world.title);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="home-world-delete"
                      type="button"
                      aria-label={`删除世界：${world.title}`}
                      disabled={importPending}
                      onClick={() => onDeleteWorld(world)}
                    >
                      删除
                    </button>
                  </div>
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
                        <span>世界名称</span>
                        <input
                          aria-label="世界名称"
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
                          aria-label="保存世界名称"
                          disabled={
                            worldNameDraft.trim() === "" ||
                            worldNameDraft.trim() === world.title
                          }
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setRenamingWorldId(null)}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty-world">
              <span className="home-empty-orbit" aria-hidden="true">
                <span />
              </span>
              <div>
                <h3>还没有正在游玩的世界</h3>
                <p>
                  先新建内容包，或上传一份
                  ZIP，再整理开场与世界文档并创建独立世界。
                </p>
              </div>
            </div>
          )}
        </section>

        <aside className="home-surface home-readiness" aria-label="工作区状态">
          <header>
            <p className="home-section-kicker">READY CHECK</p>
            <h2>工作区状态</h2>
          </header>
          <dl className="home-readiness-list">
            <div>
              <dt>
                <span
                  className={`home-status-mark ${modelConfigured ? "is-ready" : "needs-attention"}`}
                  aria-hidden="true"
                />
                模型连接
              </dt>
              <dd>{activeModelName ?? "尚未配置"}</dd>
            </div>
            <div>
              <dt>
                <span
                  className={`home-status-mark ${currentPresetName === null ? "needs-attention" : "is-ready"}`}
                  aria-hidden="true"
                />
                当前预设
              </dt>
              <dd>{currentPresetName ?? "尚未选择"}</dd>
            </div>
            <div>
              <dt>
                <span
                  className={`home-status-mark ${usablePackageCount > 0 ? "is-ready" : "needs-attention"}`}
                  aria-hidden="true"
                />
                可用内容包
              </dt>
              <dd>
                {usablePackageCount} 份
                {repairPackageCount > 0 && ` · ${repairPackageCount} 份待修复`}
              </dd>
            </div>
          </dl>
          <p className="home-readiness-note">
            内容包是世界模板；创建后的世界会独立保存状态、控制与历史。
          </p>
        </aside>
      </div>

      <section className="home-task-section" aria-labelledby="home-tasks-title">
        <header className="home-section-heading home-task-heading">
          <div>
            <p className="home-section-kicker">WORKBENCH</p>
            <h2 id="home-tasks-title">创作工作台</h2>
          </div>
          <p>四个入口各自完成一件事，运行中的世界从上方直接进入。</p>
        </header>
        <div className="home-task-grid" aria-label="四个任务入口">
          <TaskCard
            index="01"
            title="内容编辑"
            description="编辑内容包里的开场、世界文档与控制文件。"
            detail={
              contentPackages.length > 0
                ? `${contentPackages.length} 份内容包`
                : "从空白内容包开始"
            }
            disabled={importPending}
            onClick={onEditContent}
          />
          <TaskCard
            index="02"
            title="预设"
            description="编辑提示块库、叙事规则、后置请求与扩展资源。"
            detail={currentPresetName ?? "选择预设"}
            disabled={importPending}
            onClick={onOpenPlayPresets}
          />
          <TaskCard
            index="03"
            title="新建世界"
            description="从一份可用内容包复制出独立演化的世界。"
            detail={
              usablePackageCount > 0
                ? `${usablePackageCount} 份可用`
                : "需要可用内容包"
            }
            disabled={importPending}
            onClick={onCreateWorld}
          />
          <TaskCard
            index="04"
            title="提示词预览"
            description="检查真实 role、材料、工具、预算与缓存边界。"
            detail={modelConfigured ? "模型已就绪" : "需要模型连接"}
            disabled={importPending}
            onClick={onOpenPreview}
          />
        </div>
      </section>

      <section
        className="home-surface home-content-library"
        aria-labelledby="home-content-title"
      >
        <header className="home-section-heading">
          <div>
            <p className="home-section-kicker">CONTENT</p>
            <h2 id="home-content-title">内容包</h2>
          </div>
          <button
            type="button"
            disabled={importPending}
            onClick={onCreatePackage}
          >
            新建内容包
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
                    aria-label={`打开内容包：${item.displayName}`}
                    aria-pressed={item.localId === selectedPackageId}
                    disabled={importPending}
                    onClick={() => onOpenPackage(item.localId)}
                  >
                    <span className="home-package-card-heading">
                      <strong>{item.displayName}</strong>
                      <span className={`home-package-state ${item.status}`}>
                        {item.status === "usable" ? "可用" : "待修复"}
                      </span>
                    </span>
                    <span className="home-package-card-copy">
                      {item.status === "usable"
                        ? "可编辑、预览并创建新世界"
                        : "打开并修复当前树中的问题"}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="home-empty-packages">
                <h3>从一组人类可读文件开始</h3>
                <p>
                  内容包由 opening.md、world 与 control
                  组成，可以从空白新建，也可以上传一份内容包 ZIP。
                </p>
              </div>
            )}
          </div>

          <form
            className="home-import-card"
            onSubmit={(event) => {
              event.preventDefault();
              onImportPackage();
            }}
          >
            <div>
              <p className="home-section-kicker">IMPORT</p>
              <h3>导入 ZIP</h3>
              <p>
                选择本应用导出或遵循相同结构的内容包
                ZIP；导入会创建新的本地身份，不覆盖同名内容包。
              </p>
            </div>
            <label className="home-zip-picker">
              <span>内容包 ZIP</span>
              <input
                className="home-zip-picker-input"
                key={
                  importArchive === null
                    ? "empty"
                    : `${importArchive.name}:${importArchive.size}:${importArchive.lastModified}`
                }
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                aria-label="内容包 ZIP 文件"
                disabled={importPending}
                onChange={(event) =>
                  onImportArchiveChange(event.target.files?.[0] ?? null)
                }
              />
              <span className="home-zip-picker-control">
                <strong>选择 ZIP 文件</strong>
                <span aria-live="polite">
                  {importArchive === null
                    ? "尚未选择"
                    : `${importArchive.name} · ${formatFileSize(importArchive.size)}`}
                </span>
              </span>
            </label>
            <button
              type="submit"
              disabled={importArchive === null || importPending}
            >
              {importPending ? "正在导入…" : "导入 ZIP"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function TaskCard({
  index,
  title,
  description,
  detail,
  disabled,
  onClick,
}: {
  index: string;
  title: string;
  description: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="home-task-card"
      aria-labelledby={`home-task-title-${index}`}
      aria-describedby={`home-task-description-${index} home-task-detail-${index}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="home-task-index">{index}</span>
      <span className="home-task-arrow" aria-hidden="true">
        ↗
      </span>
      <strong id={`home-task-title-${index}`}>{title}</strong>
      <span
        className="home-task-description"
        id={`home-task-description-${index}`}
      >
        {description}
      </span>
      <span className="home-task-detail" id={`home-task-detail-${index}`}>
        {detail}
      </span>
    </button>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
