import { useCallback, useEffect, useState } from "react";
import type { V1Request } from "../protocol/v1.ts";
import type {
  SillyTavernSource as Source,
  SillyTavernSourceEntry,
} from "../shared/sillytavern-source.ts";
import { uiText } from "./i18n.ts";
import {
  explainSillyTavernDiagnostic,
  sillyTavernErrorMessage,
} from "./sillytavern-labels.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { useReadTarget } from "./useReadTarget.ts";

export function SillyTavernSource({
  client,
  presetId,
}: {
  client: { request<T = unknown>(request: V1Request): Promise<T> };
  presetId: string;
}): React.JSX.Element | null {
  const [source, setSource] = useState<Source>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const { target, syncFailed } = useReadTarget(
    useCallback(
      () =>
        client.request<Source>({
          type: "play.sillytavern.source.read",
          presetId,
        }),
      [client, presetId],
    ),
    setSource,
  );
  useEffect(() => {
    void target.read();
  }, [target]);
  if (source?.kind !== "legacy" && source?.kind !== "snapshot")
    return syncFailed ? (
      <SyncNotice failed onRead={() => void target.recover()} />
    ) : null;

  async function associate(file: File): Promise<void> {
    setPending(true);
    setError("");
    try {
      const text = await file.text();
      const next = await target.command(() =>
        client.request<Source>({
          type: "play.sillytavern.source.associate",
          presetId,
          source: text,
        }),
      );
      target.accept();
      setSource(next);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? sillyTavernErrorMessage(cause.message)
          : uiText("导入失败"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <details className="sillytavern-source">
      <summary>{uiText("SillyTavern 来源")}</summary>
      <SyncNotice failed={syncFailed} onRead={() => void target.recover()} />
      {source.kind === "legacy" ? (
        <>
          <p>
            {uiText(
              "此编排方案保留了旧版导入报告。选择匹配的源文件以恢复原文和顺序。",
            )}
          </p>
          <label>
            {uiText("重新关联 SillyTavern 源文件")}
            <input
              type="file"
              accept=".json,application/json"
              disabled={pending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file !== undefined) void associate(file);
              }}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <ul>
            {source.report
              .filter(({ code }) => code !== "ignored_setting")
              .map((item, index) => (
                <li key={index}>
                  {item.name ?? item.path} ·{" "}
                  {explainSillyTavernDiagnostic(item.code)} ·{" "}
                  {explainSillyTavernDiagnostic(item.result)}
                </li>
              ))}
          </ul>
        </>
      ) : (
        <>
          <p>
            {uiText("源顺序组")} <strong>{source.snapshot.groupId}</strong>
          </p>
          <ol
            className="sillytavern-source-entries"
            aria-label={uiText("源顺序")}
          >
            {source.snapshot.entries
              .filter(({ ordered }) => ordered)
              .map((entry) => (
                <SourceEntry key={entry.id} entry={entry} />
              ))}
          </ol>
          {source.snapshot.entries.some(({ ordered }) => !ordered) && (
            <ul
              className="sillytavern-source-entries"
              aria-label={uiText("未编排提示")}
            >
              {source.snapshot.entries
                .filter(({ ordered }) => !ordered)
                .map((entry) => (
                  <SourceEntry key={entry.id} entry={entry} />
                ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
}

function SourceEntry({
  entry,
}: {
  entry: SillyTavernSourceEntry;
}): React.JSX.Element {
  return (
    <li>
      <details>
        <summary>
          {entry.name} · {uiText("源启用状态")}{" "}
          {entry.enabled === undefined
            ? "—"
            : uiText(entry.enabled ? "已启用" : "已停用")}{" "}
          · {uiText(entry.selected ? "已选择" : "未选择")}
          {entry.marker && ` · ${uiText("动态占位")}`}
          {entry.missing && ` · ${uiText("缺失定义")}`}
        </summary>
        <p>
          {entry.id} · {entry.path}
          {entry.role && ` · ${uiText("发送角色")} ${entry.role}`}
        </p>
        {entry.content !== undefined && <pre>{entry.content}</pre>}
        {entry.reasons.map((reason) => (
          <p key={reason}>{explainSillyTavernDiagnostic(reason)}</p>
        ))}
        {entry.injectionPosition !== undefined && (
          <p>
            {uiText("注入位置")} {entry.injectionPosition}
          </p>
        )}
        {entry.injectionDepth !== undefined && (
          <p>
            {uiText("注入深度")} {entry.injectionDepth}
          </p>
        )}
        {entry.triggers?.length ? (
          <p>
            {uiText("触发条件")} {entry.triggers.join(", ")}
          </p>
        ) : null}
        {entry.macros.length > 0 && (
          <p>
            {uiText("宏")} {entry.macros.join(" ")}
          </p>
        )}
      </details>
    </li>
  );
}
