import {
  applyRegexPipeline,
  payloadToText,
  type FrontendPlayerViewPanelProjection,
  type ArtifactPayload,
  type FrontendExtensionBundle,
} from "./ArtifactExtensionHost.tsx";

export interface FrontendArtifactDebugRecord {
  recordId: string;
  sequence: number;
  operationId: string;
  worldId: string;
  playPresetId: string;
  playPresetRevision: string;
  parentHead: string;
  newHead: string | null;
  requestId: string;
  requestAttempt: number;
  output: string;
  channel: string;
  key?: string;
  contentType:
    "text/plain" | "text/markdown" | "application/json" | "text/html";
  save: "none" | "operation" | "commit";
  projection: "append" | "replace" | "upsert" | "transient" | "hidden";
  payloadBytes: number;
  payload: ArtifactPayload;
  payloadFingerprint: string;
  status: "pending" | "active" | "superseded" | "failed" | "cleared";
  frontend: FrontendExtensionBundle;
}

export interface FrontendArtifactExtensionSummary {
  operationId: string;
  status:
    | "not_started"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "budget_exceeded"
    | "unknown"
    | "recovery_required"
    | "superseded";
  message?: string;
  completedRequests: string[];
  coreCommitted: boolean;
  head?: string;
}

export function ArtifactDebugger({
  records,
  extensions = [],
  playerViewPanels = [],
  bridgeEvents = {},
}: {
  records: FrontendArtifactDebugRecord[];
  extensions?: FrontendArtifactExtensionSummary[];
  playerViewPanels?: FrontendPlayerViewPanelProjection[];
  bridgeEvents?: Record<string, string[]>;
}): React.JSX.Element | null {
  if (
    records.length === 0 &&
    extensions.length === 0 &&
    playerViewPanels.length === 0
  )
    return null;
  return (
    <section
      className="artifact-debugger"
      data-artifact-debugger="true"
      aria-label="产物调试器"
    >
      <header>
        <p className="eyebrow">EXTENSION DEBUG</p>
        <h2>产物调试器</h2>
      </header>
      {extensions.length === 0 ? null : (
        <section
          className="artifact-extension-statuses"
          data-artifact-extension-statuses="true"
          data-testid="artifact-extension-statuses"
          aria-label="扩展状态"
        >
          <h3>扩展状态</h3>
          {extensions.map((extension) => (
            <article
              className="artifact-extension-status"
              data-extension-operation={extension.operationId}
              data-extension-status={extension.status}
              key={extension.operationId}
            >
              <strong>{extension.status}</strong>
              <span>
                {extension.coreCommitted ? "核心已提交" : "核心未提交"}
              </span>
              <span>
                已完成请求：
                {extension.completedRequests.length === 0
                  ? "无"
                  : extension.completedRequests.join("、")}
              </span>
              {extension.head === undefined ? null : (
                <span>head：{extension.head}</span>
              )}
              {extension.message === undefined ? null : (
                <p>{extension.message}</p>
              )}
            </article>
          ))}
        </section>
      )}
      {playerViewPanels.length === 0 ? null : (
        <section
          className="player-view-panel-debug"
          data-player-view-panel-debug="true"
          aria-label="玩家视图面板诊断"
        >
          <h3>玩家视图面板</h3>
          {playerViewPanels.map((panel) => (
            <article key={panel.panelId}>
              <strong>{panel.panelId}</strong>
              <span>已提交玩家视图投影 · head：{panel.head}</span>
              <span>
                source：{panel.source.viewId} · current preset {panel.preset.id}
                /{panel.preset.revision}
              </span>
              {panel.diagnostics.length === 0 ? null : (
                <ul>
                  {panel.diagnostics.map((diagnostic, index) => (
                    <li key={String(index)}>{diagnostic.message}</li>
                  ))}
                </ul>
              )}
              <pre>{payloadToText(panel.payload, panel.contentType)}</pre>
              {(bridgeEvents[`player-view:${panel.panelId}`] ?? []).length ===
              0 ? null : (
                <details>
                  <summary>
                    bridge 事件（
                    {bridgeEvents[`player-view:${panel.panelId}`]!.length}）
                  </summary>
                  <ul>
                    {bridgeEvents[`player-view:${panel.panelId}`]!.map(
                      (event, index) => (
                        <li key={`${event}-${index}`}>{event}</li>
                      ),
                    )}
                  </ul>
                </details>
              )}
            </article>
          ))}
        </section>
      )}
      {records.map((record) => (
        <ArtifactDebugEntry
          key={`${record.recordId}-${record.sequence}`}
          record={record}
          bridgeEvents={bridgeEvents[record.recordId] ?? []}
        />
      ))}
    </section>
  );
}

function ArtifactDebugEntry({
  record,
  bridgeEvents,
}: {
  record: FrontendArtifactDebugRecord;
  bridgeEvents: string[];
}): React.JSX.Element {
  const pipeline = applyRegexPipeline({
    payload: record.payload,
    contentType: record.contentType,
    rules: record.frontend.regex,
  });
  return (
    <details
      className="artifact-debugger-entry"
      data-artifact-record={record.recordId}
    >
      <summary>
        {record.output} · {record.status} · {record.channel}
        {record.key === undefined ? "" : ` / ${record.key}`}
      </summary>
      <dl>
        <dt>来源</dt>
        <dd>
          {record.operationId} / {record.requestId} / attempt{" "}
          {record.requestAttempt}
        </dd>
        <dt>世界端点</dt>
        <dd>
          {record.parentHead} → {record.newHead ?? "未提交"}
        </dd>
        <dt>保存／投影</dt>
        <dd>
          {record.save} / {record.projection}
        </dd>
        <dt>raw bytes</dt>
        <dd>{record.payloadBytes}</dd>
        <dt>renderer revision</dt>
        <dd>{record.frontend.renderer?.revision ?? "built-in"}</dd>
        <dt>renderer 状态</dt>
        <dd>
          {record.frontend.status} / {record.frontend.fallback}
          {record.frontend.diagnostic === undefined
            ? ""
            : ` · ${record.frontend.diagnostic}`}
        </dd>
        <dt>authority</dt>
        <dd>{record.frontend.authority ?? "non_authoritative_artifact"}</dd>
      </dl>
      <p>raw payload</p>
      <pre>{payloadToText(record.payload, record.contentType)}</pre>
      <p>最终内容</p>
      <pre>{pipeline.final}</pre>
      <p>regex steps（structured_payload 以规范化 JSON 文本为输入）</p>
      <pre>{JSON.stringify(pipeline.steps, null, 2)}</pre>
      {bridgeEvents.length === 0 ? null : (
        <>
          <p>bridge events</p>
          <ul>
            {bridgeEvents.map((event, index) => (
              <li key={`${event}-${index}`}>{event}</li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
