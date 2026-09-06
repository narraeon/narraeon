import { useEffect, useRef, useState } from "react";
import type { V1Request } from "../protocol/v1.ts";
import type {
  RenderedPlayerView,
  PlayerViewDiagnostic,
} from "../protocol/playerViews.ts";
import {
  ArtifactExtensionHost,
  ArtifactExtensionMount,
  mountOrder,
  type FrontendPlayerViewPanelProjection,
} from "./ArtifactExtensionHost.tsx";
import { mountLabel } from "./playPresetEditorLabels.ts";
import { uiText } from "./i18n.ts";

interface PlayerViewPreview {
  worldId: string;
  head: string;
  playerViews: {
    views: RenderedPlayerView[];
    diagnostics: PlayerViewDiagnostic[];
  };
  panels: FrontendPlayerViewPanelProjection[];
}

/** Uses the production host with an explicitly selected, read-only world projection. */
export function InterfaceExtensionPreview({
  client,
  presetId,
  revision,
  files,
  structure,
  conflict,
  scriptsEnabled,
}: {
  client: { request<T>(request: V1Request): Promise<T> };
  presetId: string;
  revision: string;
  files: Record<string, string>;
  structure: Record<string, unknown> | undefined;
  conflict: boolean;
  scriptsEnabled: boolean;
}): React.JSX.Element {
  const [worlds, setWorlds] = useState<{ worldId: string; title: string }[]>(
    [],
  );
  const [worldId, setWorldId] = useState("");
  const [result, setResult] = useState<{
    key: string;
    preview: PlayerViewPreview;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestNumber = useRef(0);
  const key = JSON.stringify({
    presetId,
    revision,
    files,
    structure,
    worldId,
    conflict,
    scriptsEnabled,
  });
  const [previousKey, setPreviousKey] = useState(key);
  if (previousKey !== key) {
    setPreviousKey(key);
    setResult(null);
    setPending(false);
    setError(null);
  }
  const visible = result?.key === key ? result.preview : undefined;
  useEffect(() => {
    let active = true;
    void client
      .request<{ worlds: typeof worlds }>({ type: "workspace.read" })
      .then((workspace) => {
        if (active) setWorlds(workspace.worlds);
      })
      .catch((error: unknown) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
      requestNumber.current += 1;
    };
  }, [client]);

  useEffect(() => {
    requestNumber.current += 1;
  }, [key]);

  async function preview(): Promise<void> {
    if (worldId === "" || conflict) return;
    const number = ++requestNumber.current;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const snapshot = await client.request<{
        playerViewPreview: PlayerViewPreview;
      }>({
        type: "play.workbench.read",
        presetId,
        revision,
        worldId,
        draft: { files, ...(structure === undefined ? {} : { structure }) },
      });
      if (
        number === requestNumber.current &&
        snapshot.playerViewPreview.worldId === worldId
      )
        setResult({ key, preview: snapshot.playerViewPreview });
    } catch (error: unknown) {
      if (number === requestNumber.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (number === requestNumber.current) setPending(false);
    }
  }

  return (
    <section
      className="play-preset-structured-section interface-extension-preview"
      aria-label={uiText("纯界面预览")}
    >
      <h4>{uiText("纯界面预览")}</h4>
      <p>
        {uiText(
          "使用当前编辑内容与所选世界的已保存玩家视图，不调用模型，也不保存或修改世界。修改后请重新预览。",
        )}
      </p>
      <label>
        {uiText("预览世界")}
        <select
          aria-label={uiText("预览世界")}
          value={worldId}
          onChange={(event) => setWorldId(event.currentTarget.value)}
        >
          <option value="">{uiText("选择已有世界")}</option>
          {worlds.map((world) => (
            <option key={world.worldId} value={world.worldId}>
              {world.title}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={pending || worldId === "" || conflict}
        onClick={() => void preview()}
      >
        {uiText("预览界面")}
      </button>
      {pending ? <p role="status">{uiText("正在读取玩家视图…")}</p> : null}
      {conflict ? (
        <p role="alert">
          {uiText(
            "预设原文与表单均有修改，请先保留一种编辑结果并保存，再预览。",
          )}
        </p>
      ) : null}
      {error === null ? null : <p role="alert">{error}</p>}
      {visible === undefined ? null : (
        <>
          <datalist id="player-view-preview-sources">
            {visible.playerViews.views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.title}
              </option>
            ))}
          </datalist>
          <ArtifactExtensionHost
            worldId={visible.worldId}
            artifacts={[]}
            playerViewPanels={visible.panels}
            playerViews={visible.playerViews}
            onSetComposerDraft={() => undefined}
            onRefresh={preview}
          >
            {mountOrder
              .filter((mount) =>
                visible.panels.some((panel) => panel.frontend.mount === mount),
              )
              .map((mount) => (
                <section key={mount} aria-label={mountLabel(mount)}>
                  <h5>{mountLabel(mount)}</h5>
                  <ArtifactExtensionMount mount={mount} />
                </section>
              ))}
          </ArtifactExtensionHost>
          {visible.panels.length === 0 ? (
            <p>{uiText("当前没有玩家视图面板。")}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
