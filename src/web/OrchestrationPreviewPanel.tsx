import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { V1Request } from "../protocol/v1.ts";
import type { ModelConnectionView } from "../protocol/modelConnections.ts";
import { fictionGameplay, type Gameplay } from "../protocol/gameplay.ts";
import type {
  OrchestrationAuthorTarget,
  OrchestrationPlaceholderKind,
  OrchestrationPreviewEntry,
  OrchestrationPreviewInput,
  OrchestrationPreviewResult,
  OrchestrationSurface,
} from "../protocol/orchestrationPreview.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { useReadTarget } from "./useReadTarget.ts";

type Version = "current" | "draft" | "candidate";
type PreviewRequest = Extract<
  V1Request,
  { type: "play.orchestration.preview" }
>;

const selectionDelayMs = 120;
const candidateDelayMs = 400;

const placeholderText: Record<OrchestrationPlaceholderKind, string> = {
  "world-instructions": "已启用的世界指令在此前缀位置展开，顺序来自世界框架。",
  "world-material":
    "全新上下文通过初始工具回执载入框架材料。追加沿用已载入的材料。",
  "world-turn-guide": "世界框架的尾部行在对应位置加入每次游玩的本轮提示。",
  "player-turn-note": "玩家本轮临时要求如有填写，会成为本轮提示的最后一行。",
  "author-target":
    "设定完善使用内容包身份与当前树。世界修订使用世界身份与独占期。创作工具与结算、创作建议、未来游玩参考随目标切换。",
  "author-preload":
    "有完整预载材料时，Runtime 会在作者提示块后加入一条 System 消息。",
};

export function OrchestrationPreviewPanel({
  client,
  presetId,
  currentRevision,
  draftRevision,
  candidateBaseRevision,
  candidate,
  candidateConflict,
  surface,
  connection,
}: {
  client: { request<T>(request: V1Request): Promise<T> };
  presetId: string;
  currentRevision: string;
  draftRevision: string | undefined;
  candidateBaseRevision: string;
  candidate: OrchestrationPreviewInput["candidate"];
  candidateConflict: boolean;
  surface: OrchestrationSurface;
  connection: ModelConnectionView | undefined;
}): React.JSX.Element {
  const titleId = useId();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<Version>();
  const [gameplay, setGameplay] = useState<Gameplay>(fictionGameplay);
  const [authorTarget, setAuthorTarget] =
    useState<OrchestrationAuthorTarget>("setting");
  const [ignoreConnection, setIgnoreConnection] = useState(false);
  const [result, setResult] = useState<{
    context: object;
    value: OrchestrationPreviewResult;
  }>();
  const selectedVersion =
    version === "current" ||
    (version === "draft" && draftRevision !== undefined) ||
    (version === "candidate" && candidate !== undefined)
      ? version
      : candidate !== undefined
        ? "candidate"
        : draftRevision !== undefined
          ? "draft"
          : "current";
  const revision =
    selectedVersion === "candidate"
      ? candidateBaseRevision
      : selectedVersion === "draft"
        ? draftRevision!
        : currentRevision;
  // Use the underlying draft references so sibling workbench renders do not
  // restart the preview or serialize the entire candidate on every keypress.
  const files = selectedVersion === "candidate" ? candidate?.files : undefined;
  const structure =
    selectedVersion === "candidate" ? candidate?.structure : undefined;
  const targetAssumption = surface === "author" ? authorTarget : undefined;
  const checkedConnection = ignoreConnection ? undefined : connection;
  const locale = getWebLocale();
  const context = useMemo(() => {
    if (!open) return null;
    const query: PreviewRequest = {
      type: "play.orchestration.preview",
      presetId,
      revision,
      ...(files === undefined
        ? {}
        : {
            candidate: {
              files,
              ...(structure === undefined ? {} : { structure }),
            },
          }),
      surface,
      gameplay,
      ...(targetAssumption === undefined
        ? {}
        : { authorTarget: targetAssumption }),
      connection: ignoreConnection ? "none" : "active",
    };
    return { query, currentRevision, checkedConnection, locale };
  }, [
    open,
    presetId,
    revision,
    files,
    structure,
    surface,
    gameplay,
    targetAssumption,
    ignoreConnection,
    currentRevision,
    checkedConnection,
    locale,
  ]);
  const active = useRef<typeof context>(null);
  const inFlight = useRef<Promise<OrchestrationPreviewResult> | null>(null);
  useLayoutEffect(() => {
    active.current = context;
    return () => {
      active.current = null;
    };
  }, [context]);

  const { target, syncFailed, syncError } = useReadTarget(
    useCallback(async () => {
      // A new selection may queue behind a slow read. On release only the
      // latest visible context can dispatch, regardless of how many changed.
      const prior = inFlight.current;
      if (prior !== null) await prior.catch(() => undefined);
      if (
        context === null ||
        active.current !== context ||
        !disclosure.current?.open
      )
        return null;
      const request = client.request<OrchestrationPreviewResult>(context.query);
      inFlight.current = request;
      try {
        return await request;
      } finally {
        inFlight.current = null;
      }
    }, [client, context]),
    useCallback(
      (value: OrchestrationPreviewResult | null) => {
        if (value !== null && context !== null && active.current === context)
          setResult({ context, value });
      },
      [context],
    ),
  );
  useEffect(() => {
    if (context === null) return;
    const delay =
      context.query.candidate === undefined
        ? selectionDelayMs
        : candidateDelayMs;
    const timer = setTimeout(() => void target.read(), delay);
    return () => clearTimeout(timer);
  }, [context, target]);

  const preview = result?.context === context ? result.value : undefined;
  return (
    <details
      className="preset-draft-preview"
      ref={disclosure}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{uiText("发送给 AI 的内容预览")}</summary>
      <section className="orchestration-preview" aria-labelledby={titleId}>
        <h4 id={titleId}>{uiText("编排预览")}</h4>
        <p>
          {uiText("按当前编排展开可确定的提示词。世界与创作目标只显示占位。")}
        </p>
        <div className="orchestration-preview-controls">
          <label>
            {uiText("预览版本")}
            <select
              value={selectedVersion}
              onChange={(event) => setVersion(event.target.value as Version)}
            >
              <option value="current">{uiText("当前版本")}</option>
              {draftRevision !== undefined && (
                <option value="draft">{uiText("已保存草稿")}</option>
              )}
              {candidate !== undefined && (
                <option value="candidate">{uiText("未保存候选")}</option>
              )}
            </select>
          </label>
          <label>
            {uiText("预览玩法")}
            <select
              value={gameplay.mode === "tabletop" ? gameplay.scheme : "fiction"}
              onChange={(event) => {
                const scheme = event.target.value;
                if (scheme === "d20" || scheme === "d100" || scheme === "bag")
                  setGameplay({ mode: "tabletop", scheme });
                else setGameplay(fictionGameplay);
              }}
            >
              <option value="fiction">{uiText("互动式小说")}</option>
              <option value="d20">{uiText("跑团 · d20")}</option>
              <option value="d100">{uiText("跑团 · d100")}</option>
              <option value="bag">{uiText("跑团 · 混乱袋")}</option>
            </select>
          </label>
          {surface === "author" && (
            <label>
              {uiText("创作目标")}
              <select
                value={authorTarget}
                onChange={(event) =>
                  setAuthorTarget(
                    event.target.value as OrchestrationAuthorTarget,
                  )
                }
              >
                <option value="setting">{uiText("设定完善")}</option>
                <option value="world-revision">{uiText("世界修订")}</option>
              </select>
            </label>
          )}
          {connection !== undefined && (
            <label>
              {uiText("连接条件")}
              <select
                value={ignoreConnection ? "none" : "active"}
                onChange={(event) =>
                  setIgnoreConnection(event.target.value === "none")
                }
              >
                <option value="active">{connection.name}</option>
                <option value="none">{uiText("无连接")}</option>
              </select>
            </label>
          )}
        </div>
        {candidateConflict && (
          <p>
            {uiText(
              "表单和原文均有修改。保留其中一种修改后，即可预览未保存版本。",
            )}
          </p>
        )}
        {open && preview === undefined && !syncFailed && (
          <p role="status">{uiText("正在生成预览…")}</p>
        )}
        {open && (
          <SyncNotice
            failed={syncFailed}
            reason={syncError}
            onRead={() => void target.recover()}
          />
        )}
        {preview !== undefined && <PreviewResult result={preview} />}
      </section>
    </details>
  );
}

function PreviewResult({ result }: { result: OrchestrationPreviewResult }) {
  const { selected, comparison } = result;
  const protocolText = {
    "not-checked": "未检查",
    compatible: "顺序检查通过",
    conditional: "顺序取决于实际载入的材料",
    incompatible: "System 必须排在 User 和 Assistant 之前",
  } as const;
  const turnGuide = selected.turnGuide;
  const worldLine = (
    <li key="world-turn-guide">
      <em>{uiText(placeholderText["world-turn-guide"])}</em>
    </li>
  );
  const visibleTurnGuide = turnGuide?.lines.map((line, index) => (
    <li key={line.entryId}>
      {line.text} <code>{line.source}</code>
      {turnGuide.warnings.some(
        (warning) => warning.kind === "line_length" && warning.index === index,
      ) && <strong> · {uiText("超出单行建议长度")}</strong>}
    </li>
  ));
  return (
    <div className="orchestration-preview-results">
      <h5>{uiText("预览结果")}</h5>
      <p role="status">
        {uiText("协议顺序检查")} ·{" "}
        {uiText(protocolText[selected.protocol.status])}
        {"provider" in selected.protocol && (
          <>
            {" "}
            · <code>{selected.protocol.provider}</code>
          </>
        )}
      </p>
      {"conflictingIds" in selected.protocol &&
        selected.protocol.conflictingIds.length > 0 && (
          <p>
            <code>{selected.protocol.conflictingIds.join(", ")}</code>
          </p>
        )}
      <details open>
        <summary>{uiText("发送角色与顺序")}</summary>
        {selected.messageOrder === "conditional" && (
          <p>{uiText("实际材料会影响消息分组。")}</p>
        )}
        <ol>
          {selected.messages.map(({ role, entryIds, conditional }, index) => (
            <li key={index}>
              <strong>{role}</strong> <code>{entryIds.join(" · ")}</code>
              {conditional && <small> · {uiText("条件性")}</small>}
            </li>
          ))}
        </ol>
      </details>
      <details open>
        <summary>{uiText("动态占位")}</summary>
        <ul>
          {selected.placeholders.map((placeholder) => (
            <li key={placeholder.kind}>
              <span>{uiText(placeholderText[placeholder.kind])}</span>{" "}
              <code>{placeholder.source}</code>
            </li>
          ))}
        </ul>
      </details>
      {turnGuide !== undefined && visibleTurnGuide !== undefined && (
        <details open>
          <summary>{uiText("已知的本轮提示行")}</summary>
          <ol>
            {visibleTurnGuide.toSpliced(
              turnGuide.worldLineInsertIndex,
              0,
              worldLine,
            )}
          </ol>
          <p>
            {uiText(
              turnGuide.lineCount === "over-limit"
                ? "已知行已超出建议数量（{lines} 行，每行建议 {chars} 字符）。"
                : "建议最多 {lines} 行，每行 {chars} 字符。总数还取决于世界和玩家提供的行。",
              {
                lines: turnGuide.limits.lines,
                chars: turnGuide.limits.lineLength,
              },
            )}
          </p>
        </details>
      )}
      <details>
        <summary>{uiText("全部编排条目")}</summary>
        <ol>
          {selected.entries.map((entry) => (
            <li key={entry.identity}>
              <Entry row={entry} />
            </li>
          ))}
        </ol>
      </details>
      <details open>
        <summary>
          {uiText(
            result.isCurrentPreset
              ? "与已应用版本比较"
              : "与该方案的当前版本比较",
          )}
        </summary>
        <p>
          <code>{comparison.baseRevision}</code> →{" "}
          <code>{comparison.selectedRevision}</code>
        </p>
        {comparison.mergeConsecutiveMessagesChanged && (
          <p>{uiText("相邻同角色合并设置已修改。")}</p>
        )}
        {comparison.changes.length === 0 &&
        !comparison.mergeConsecutiveMessagesChanged ? (
          <p>{uiText("此表面的编排一致。")}</p>
        ) : (
          <ul>
            {comparison.changes.map(({ identity, before, after }) => (
              <li key={identity}>
                <details>
                  <summary>
                    {after?.name ?? before?.name} ·{" "}
                    {uiText(
                      before === undefined
                        ? "新增"
                        : after === undefined
                          ? "移除"
                          : "修改",
                    )}
                  </summary>
                  {before !== undefined && (
                    <Entry row={before} label={uiText("修改前")} />
                  )}
                  {after !== undefined && (
                    <Entry row={after} label={uiText("修改后")} />
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

function Entry({
  row,
  label,
}: {
  row: OrchestrationPreviewEntry;
  label?: string;
}) {
  return (
    <details>
      <summary>
        {label && <>{label} · </>}
        {row.position}. {row.name}{" "}
        {row.messageRole && <strong>{row.messageRole}</strong>}{" "}
        <small>
          {uiText(
            !row.enabled ? "已停用" : !row.applies ? "此玩法不适用" : "已启用",
          )}
        </small>
      </summary>
      <p>
        <code>{row.id}</code> · <code>{row.source}</code>
      </p>
      {row.markdown !== undefined && <pre>{row.markdown}</pre>}
      {row.configuredMarkdown !== undefined && (
        <>
          <p>{uiText("此条目尚未产生消息。")}</p>
          <pre>{row.configuredMarkdown}</pre>
        </>
      )}
      {row.configuredTurnGuide !== undefined && (
        <p>
          {uiText("本轮尾部提示")} · {row.configuredTurnGuide}
        </p>
      )}
    </details>
  );
}
