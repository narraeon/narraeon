import { useEffect, useState } from "react";
import type { V1Request } from "../protocol/v1.ts";
import type { PlayPresetWorkbenchSnapshot } from "./PlayPresetScreen.tsx";
import {
  validatePlayPresetArtifactPayload,
  type PlayPresetArtifactPayloadContract,
} from "../shared/artifact-payload-contract.ts";
import {
  ArtifactExtensionHost,
  ArtifactExtensionMount,
  applyRegexPipeline,
  type ArtifactPayload,
  type FrontendArtifactProjection,
} from "./ArtifactExtensionHost.tsx";
import { getWebLocale } from "./i18n.ts";
import { mountLabel } from "./playPresetEditorLabels.ts";
const t = (cn: string, en: string) => (getWebLocale() === "zh-CN" ? cn : en);
export function PresetDraftPreview({
  client,
  presetId,
  revision,
  files,
  structure,
  scriptsEnabled,
  requestId,
  output,
}: {
  client: { request<T>(request: V1Request): Promise<T> };
  presetId: string;
  revision: string;
  files: Record<string, string>;
  structure: Record<string, unknown>;
  scriptsEnabled: boolean;
  requestId: string;
  output: string;
}) {
  const key = JSON.stringify({
    presetId,
    revision,
    files,
    structure,
    scriptsEnabled,
    requestId,
    output,
  });
  const [result, setResult] = useState<{
    key: string;
    snapshot: PlayPresetWorkbenchSnapshot;
  }>();
  const [error, setError] = useState<{ key: string; message: string }>();
  const [sample, setSample] = useState<string>();
  const [draft, setDraft] = useState("");
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void client
        .request<PlayPresetWorkbenchSnapshot>({
          type: "play.workbench.read",
          presetId,
          revision,
          draft: { files, structure },
        })
        .then((snapshot) => {
          if (active) setResult({ key, snapshot });
        })
        .catch((error: unknown) => {
          if (active) setError({ key, message: String(error) });
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, key, presetId, revision, files, structure]);
  const snapshot = result?.key === key ? result.snapshot : undefined;
  const artifact = snapshot?.artifactPreviews.find(
    (a) => a.requestId === requestId && a.output === output,
  );
  let payload: ArtifactPayload = sample ?? artifact?.rawText ?? "";
  let validation = "";
  if (artifact?.declaration.contentType === "application/json") {
    try {
      payload = JSON.parse(
        sample ?? JSON.stringify(artifact.rawPayload, null, 2),
      ) as ArtifactPayload;
      const result = validatePlayPresetArtifactPayload(
        artifact.declaration.payloadContract as
          PlayPresetArtifactPayloadContract | undefined,
        payload,
      );
      validation = result.ok
        ? t("样例校验通过", "Sample valid")
        : result.message;
    } catch (error) {
      validation = String(error);
    }
  }
  const mount = snapshot?.structure.mounts.find(
    (m) => m.channel === artifact?.declaration.channel,
  )?.mount;
  const projection: FrontendArtifactProjection | undefined =
    artifact && mount
      ? {
          recordId: "preview",
          worldId: "preview",
          operationId: "preview",
          playPresetId: presetId,
          playPresetRevision: snapshot.revision,
          requestId,
          requestAttempt: 1,
          output,
          channel: artifact.declaration.channel,
          ...(artifact.declaration.key
            ? { key: artifact.declaration.key }
            : {}),
          contentType: artifact.declaration.contentType,
          payload,
          projection: artifact.declaration.strategy,
          save: artifact.declaration.save,
          sequence: 1,
          head: "preview",
          frontend: {
            status: "ready",
            preset: { id: presetId, revision: snapshot.revision },
            mount,
            regex: artifact.regex,
            ...(artifact.renderer ? { renderer: artifact.renderer } : {}),
            trustedLocalCode:
              artifact.renderer?.trustedLocalCode === true && scriptsEnabled,
            fallback: "none",
          },
        }
      : undefined;
  const processed = artifact
    ? applyRegexPipeline({
        contentType: artifact.declaration.contentType,
        payload,
        rules: artifact.regex,
      })
    : undefined;
  return (
    <details className="preset-draft-preview">
      <summary>
        {t("游玩效果预览 · 就地展开", "Play preview · expand here")}
      </summary>
      <p>
        {t(
          "预览当前修改与本页样例，不调用模型，也不改变世界。JavaScript 是否运行沿用此预设的脚本设置。",
          "Preview your current edits with this page's sample data, without model calls or world changes. JavaScript follows this preset's script settings.",
        )}
      </p>
      {error?.key === key ? (
        <p role="alert">{error.message}</p>
      ) : !snapshot ? (
        <p role="status">{t("正在解析当前草稿…", "Resolving draft…")}</p>
      ) : null}
      {artifact && (
        <>
          <label>
            {t("示例输入", "Sample input")}
            <textarea
              aria-label={t("示例输入", "Sample input")}
              rows={6}
              value={
                sample ??
                (artifact.declaration.contentType === "application/json"
                  ? JSON.stringify(artifact.rawPayload, null, 2)
                  : artifact.rawText)
              }
              onChange={(e) => setSample(e.target.value)}
            />
          </label>
          {artifact.declaration.contentType === "application/json" && (
            <div className="preset-inline">
              <button
                type="button"
                onClick={() =>
                  setSample(JSON.stringify(artifact.rawPayload, null, 2))
                }
              >
                {t("载入当前格式样例", "Load current format sample")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const sample: unknown = structuredClone(artifact.rawPayload);
                  const contract = artifact.declaration.payloadContract as
                    PlayPresetArtifactPayloadContract | undefined;
                  const target: unknown = Array.isArray(sample)
                    ? sample[0]
                    : sample;
                  const required = (
                    Array.isArray(sample) ? contract?.items : contract
                  )?.required?.[0];
                  if (required && target && typeof target === "object")
                    delete (target as Record<string, unknown>)[required];
                  setSample(JSON.stringify(sample, null, 2));
                }}
              >
                {t("移除首个必填字段", "Remove first required field")}
              </button>
            </div>
          )}
          {validation && <p role="status">{validation}</p>}
          <details>
            <summary>{t("处理后显示文本", "Processed display text")}</summary>
            <pre>{processed?.final}</pre>
          </details>
          <label>
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
            {t("预览禁交互状态", "Preview disabled interactions")}
          </label>
        </>
      )}
      {projection ? (
        <section className={`preset-preview-position position-${mount}`}>
          <h4>{mountLabel(mount!)}</h4>
          <ArtifactExtensionHost
            key={key}
            worldId="preview"
            artifacts={[projection]}
            playerViews={{ views: [] }}
            interactionDisabled={disabled}
            onSetComposerDraft={setDraft}
            onRefresh={() => setSample(sample)}
          >
            <ArtifactExtensionMount mount={mount!} />
          </ArtifactExtensionHost>
        </section>
      ) : artifact ? (
        <p>
          {t("此产物未设置显示位置。", "This output has no display position.")}
        </p>
      ) : null}
      <label>
        {t("本页输入草稿（尚未发送）", "Local input draft (not sent)")}
        <textarea
          aria-label={t(
            "本页输入草稿（尚未发送）",
            "Local input draft (not sent)",
          )}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
    </details>
  );
}
