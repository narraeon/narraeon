import { useCallback, useEffect, useMemo, useState } from "react";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
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
    context: object;
    preview: PlayerViewPreview;
  } | null>(null);
  const [pendingContext, setPendingContext] = useState<object | null>(null);
  const key = JSON.stringify({
    presetId,
    revision,
    files,
    structure,
    worldId,
    conflict,
    scriptsEnabled,
  });
  const context = useMemo(() => ({ key }), [key]);
  const visible = result?.context === context ? result.preview : undefined;
  const pending = pendingContext === context;
  const { target: worldsTarget, syncFailed: worldsSyncFailed } = useReadTarget(
    useCallback(
      () =>
        client.request<{ worlds: typeof worlds }>({ type: "workspace.read" }),
      [client],
    ),
    useCallback(
      (workspace: { worlds: typeof worlds }) => setWorlds(workspace.worlds),
      [],
    ),
  );
  useEffect(() => {
    void worldsTarget.read();
  }, [worldsTarget]);
  const { target, syncFailed, syncError } = useReadTarget(
    useCallback(() => {
      const input = JSON.parse(context.key) as {
        presetId: string;
        revision: string;
        worldId: string;
        files: Record<string, string>;
        structure?: Record<string, unknown>;
      };
      return client.request<{ playerViewPreview: PlayerViewPreview }>({
        type: "play.workbench.read",
        presetId: input.presetId,
        revision: input.revision,
        worldId: input.worldId,
        draft: {
          files: input.files,
          ...(input.structure === undefined
            ? {}
            : { structure: input.structure }),
        },
      });
    }, [client, context]),
    useCallback(
      (snapshot: { playerViewPreview: PlayerViewPreview }) => {
        if (
          snapshot.playerViewPreview.worldId ===
          (JSON.parse(context.key) as { worldId: string }).worldId
        )
          setResult({ context, preview: snapshot.playerViewPreview });
      },
      [context],
    ),
  );

  async function preview(): Promise<void> {
    if (worldId === "" || conflict) return;
    setPendingContext(context);
    try {
      await target.read();
    } finally {
      setPendingContext((current) => (current === context ? null : current));
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
      <SyncNotice
        failed={worldsSyncFailed}
        onRead={() => void worldsTarget.recover()}
      />
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
            "编排方案原文与表单均有修改，请先保留一种编辑结果并保存，再预览。",
          )}
        </p>
      ) : null}
      <SyncNotice
        failed={syncFailed}
        reason={syncError}
        onRead={() => void target.recover()}
      />
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
                  <ArtifactExtensionMount mount={mount} preview />
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
