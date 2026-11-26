import { useCallback, useEffect, useState } from "react";
import {
  isOrchestrationProvenanceRecord,
  type OrchestrationEntrySource,
} from "../protocol/orchestrationProvenance.ts";
import type { OrchestrationSurface } from "../protocol/orchestrationSession.ts";
import type { V1Request } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { useReadTarget } from "./useReadTarget.ts";

export function OrchestrationProvenance({
  record,
}: {
  record: unknown;
}): React.JSX.Element | null {
  if (!isOrchestrationProvenanceRecord(record)) return null;
  return (
    <details className="orchestration-provenance">
      <summary>
        {uiText("SillyTavern 提取出处")}
        {record.modified === "manual" && ` · ${uiText("提取后已手动修改")}`}
        {record.modified === "assistant" &&
          ` · ${uiText("提取后已由 AI 修改")}`}
        {record.requiresReview && ` · ${uiText("请核对条件变化")}`}
      </summary>
      <dl>
        <dt>{uiText("来源快照")}</dt>
        <dd>
          <code>{record.snapshotId}</code>
        </dd>
        <dt>{uiText("源顺序组")}</dt>
        <dd>{record.groupId}</dd>
        <dt>{uiText("原文片段（UTF-16 偏移）")}</dt>
        <dd>
          <ul>
            {record.fragments.map((fragment, index) => (
              <li key={index}>
                {fragment.name} <code>{fragment.entryId}</code> [
                {fragment.offset}, {fragment.end})
              </li>
            ))}
          </ul>
        </dd>
        <dt>{uiText("改写理由")}</dt>
        <dd>{record.rationale}</dd>
        {record.droppedConditions.length > 0 && (
          <>
            <dt>{uiText("未保留的原条件")}</dt>
            <dd>
              <ul>
                {record.droppedConditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

interface EntryProps {
  client: { request<T = unknown>(request: V1Request): Promise<T> };
  presetId: string;
  revision: string;
  surface: OrchestrationSurface;
  entryId: string;
  version: "current" | "draft";
}

export function OrchestrationEntryProvenance(
  props: EntryProps,
): React.JSX.Element {
  const { presetId, revision, surface, entryId, version } = props;
  return (
    <SavedEntryProvenance
      key={JSON.stringify([presetId, revision, surface, entryId, version])}
      {...props}
    />
  );
}

function SavedEntryProvenance({
  client,
  presetId,
  revision,
  surface,
  entryId,
  version,
}: EntryProps): React.JSX.Element {
  const [record, setRecord] = useState<OrchestrationEntrySource | null>(null);
  const { target, syncFailed } = useReadTarget(
    useCallback(
      () =>
        client.request<OrchestrationEntrySource | null>({
          type: "play.orchestration.provenance.read",
          presetId,
          revision,
          surface,
          entryId,
          target: version,
        }),
      [client, presetId, revision, surface, entryId, version],
    ),
    setRecord,
  );
  useEffect(() => {
    void target.read();
  }, [target]);
  return (
    <>
      <SyncNotice failed={syncFailed} onRead={() => void target.recover()} />
      <OrchestrationProvenance record={record?.source} />
    </>
  );
}
