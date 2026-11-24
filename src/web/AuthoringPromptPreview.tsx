import { useCallback, useEffect, useRef, useState } from "react";
import type {
  V1AuthoringRequestPreview,
  V1AuthoringRequestIdentity,
  V1SettingPromptPreview,
} from "../protocol/v1.ts";
import { getWebLocale } from "./i18n.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { useReadTarget } from "./useReadTarget.ts";

type Compilation = V1SettingPromptPreview["compilation"];

export function AuthoringPromptPreview({
  requests,
  onPreview,
  onRequestPreview,
}: {
  requests: (V1AuthoringRequestIdentity | V1AuthoringRequestPreview)[];
  onRequestPreview?:
    | ((requestId: string) => Promise<V1AuthoringRequestPreview | null>)
    | undefined;
  onPreview?: () => Promise<Compilation | null>;
}) {
  const zh = getWebLocale() === "zh-CN";
  const [candidate, setCandidate] = useState<Compilation | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useRef(onPreview);
  useEffect(() => {
    preview.current = onPreview;
  }, [onPreview]);
  const load = useCallback(
    () => preview.current?.() ?? Promise.resolve(null),
    [],
  );
  const apply = useCallback(
    (value: Compilation | null) => setCandidate(value),
    [],
  );
  const { target, syncFailed, syncError } = useReadTarget(load, apply);
  const read = (recover = false) => {
    setBusy(true);
    void (recover ? target.recover() : target.read()).finally(() =>
      setBusy(false),
    );
  };
  return (
    <section className="authoring-prompt-preview">
      {onPreview && (
        <>
          <button type="button" disabled={busy} onClick={() => read()}>
            {zh ? "预览下一条请求" : "Preview next send"}
          </button>
          <details className="authoring-preview-help">
            <summary>{zh ? "预览说明" : "About this preview"}</summary>
            <p>
              {zh
                ? "候选预览读取当前已应用编排方案，不发送消息、不创建修订锁；发送时重新读取。"
                : "Candidate preview reads the currently applied orchestration without sending a message or opening a revision lock. Sending reads it again."}
            </p>
          </details>
        </>
      )}
      <SyncNotice
        failed={syncFailed}
        onRead={() => read(true)}
        reason={syncError}
      />
      {candidate && (
        <details open>
          <summary>
            {zh ? "下一次发送候选（未发送）" : "Next-send candidate (not sent)"}
          </summary>
          <CompiledPrompt compilation={candidate} />
        </details>
      )}
      {requests.length > 0 && (
        <details className="setting-request-previews">
          <summary>
            {zh ? "已发送请求的真实提示" : "Actual sent prompts"}
          </summary>
          <p>
            {zh
              ? "以下保留每次发送时的实际编排，不是下一次发送预览。"
              : "These retain each send's actual arrangement, not the next-send candidate."}
          </p>
          {requests.map((request, index) => (
            <RetainedPreview
              key={`${request.legacyBootstrap ? "legacy:" : ""}${request.requestId}`}
              request={request}
              load={onRequestPreview}
              label={
                request.legacyBootstrap
                  ? zh
                    ? "旧会话原始提示"
                    : "Original legacy conversation prompt"
                  : zh
                    ? `发送请求 ${index + 1}`
                    : `Sent request ${index + 1}`
              }
            />
          ))}
        </details>
      )}
    </section>
  );
}

function RetainedPreview({
  request,
  load,
  label,
}: {
  request: V1AuthoringRequestIdentity | V1AuthoringRequestPreview;
  load:
    | ((requestId: string) => Promise<V1AuthoringRequestPreview | null>)
    | undefined;
  label: string;
}) {
  const zh = getWebLocale() === "zh-CN";
  const [preview, setPreview] = useState<V1AuthoringRequestPreview | null>(
    "compilation" in request ? request : null,
  );
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  const { target, syncFailed, syncError } = useReadTarget(
    useCallback(
      () => loader.current?.(request.requestId) ?? Promise.resolve(null),
      [request.requestId],
    ),
    useCallback(
      (value: V1AuthoringRequestPreview | null) => setPreview(value),
      [],
    ),
  );
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && preview === null && load !== undefined)
          void target.read();
      }}
    >
      <summary>{label}</summary>
      <SyncNotice
        failed={syncFailed}
        reason={syncError}
        onRead={() => void target.recover()}
      />
      {preview === null ? null : (
        <>
          <CompiledPrompt compilation={preview.compilation} />
          {preview.wireRequest && (
            <details>
              <summary>
                {zh
                  ? "实际派发编码及 Runtime 来源"
                  : "Sent encoding and Runtime sources"}
              </summary>
              <p>
                {zh
                  ? "System 边界约束当前 epoch；历史中的 Runtime 通知标记切换位置。"
                  : "The System boundary governs the current epoch; Runtime notices locate transitions in history."}
              </p>
              {preview.wireRequest.redactedProviderContinuation && (
                <p>
                  {zh
                    ? "Provider 原生续传内容已隐藏。"
                    : "Provider-native continuation is hidden."}
                </p>
              )}
              <pre>{JSON.stringify(preview.wireRequest, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </details>
  );
}

function CompiledPrompt({ compilation }: { compilation: Compilation }) {
  const zh = getWebLocale() === "zh-CN";
  return (
    <>
      {compilation.logicalMessages.map((message, index) => (
        <article key={index}>
          <h4>{message.role}</h4>
          <pre>{message.markdown}</pre>
        </article>
      ))}
      <details>
        <summary>
          {zh ? "Provider 编码与工具定义" : "Provider encoding and tools"}
        </summary>
        <pre>
          {JSON.stringify(
            { provider: compilation.provider, tools: compilation.tools },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}
