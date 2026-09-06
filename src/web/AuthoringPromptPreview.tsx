import { useState } from "react";
import type {
  V1AuthoringRequestPreview,
  V1SettingPromptPreview,
} from "../protocol/v1.ts";
import { getWebLocale } from "./i18n.ts";

type Compilation = V1SettingPromptPreview["compilation"];

export function AuthoringPromptPreview({
  requests,
  onPreview,
}: {
  requests: V1AuthoringRequestPreview[];
  onPreview?: () => Promise<Compilation>;
}) {
  const zh = getWebLocale() === "zh-CN";
  const [candidate, setCandidate] = useState<Compilation | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  return (
    <section className="authoring-prompt-preview">
      {onPreview && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailure("");
              setCandidate(null);
              void onPreview()
                .then(setCandidate)
                .catch((error: unknown) =>
                  setFailure(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {zh ? "预览下一条请求" : "Preview next send"}
          </button>
          <details className="authoring-preview-help">
            <summary>{zh ? "预览说明" : "About this preview"}</summary>
            <p>
              {zh
                ? "候选预览读取当前已应用预设，不发送消息、不创建修订锁；发送时重新读取。"
                : "Candidate preview reads the currently applied preset without sending a message or opening a revision lock. Sending reads it again."}
            </p>
          </details>
        </>
      )}
      {failure && <p role="alert">{failure}</p>}
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
            <details
              key={`${request.legacyBootstrap ? "legacy:" : ""}${request.requestId}`}
            >
              <summary>
                {request.legacyBootstrap
                  ? zh
                    ? "旧会话原始提示"
                    : "Original legacy conversation prompt"
                  : zh
                    ? `发送请求 ${index + 1}`
                    : `Sent request ${index + 1}`}
              </summary>
              <CompiledPrompt compilation={request.compilation} />
            </details>
          ))}
        </details>
      )}
    </section>
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
