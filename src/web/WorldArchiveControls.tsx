import { useRef, useState } from "react";
import {
  worldArchiveLimits,
  type WorldArchiveDownload,
} from "../protocol/worldArchives.ts";
import type { V1Request } from "../protocol/v1.ts";
import { createClientId } from "./ClientId.ts";
import { RuntimeRequestError } from "./runtimeClient.ts";
import { uiText } from "./i18n.ts";

interface ArchiveClient {
  request(request: V1Request): Promise<unknown>;
}
export function WorldBackupExportButton({
  client,
  worldId,
  label = "导出世界备份",
  disabled = false,
  onBusyChange,
}: {
  client: ArchiveClient;
  worldId: string;
  label?: "导出世界备份" | "导出备份";
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [started, setStarted] = useState(false);
  async function exportBackup(): Promise<void> {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setStarted(true);
    setMessage(uiText("正在导出世界备份…"));
    try {
      const archive = (await client.request({
        type: "world.archive.export",
        worldId,
        operationId: createClientId("archive-export"),
      })) as WorldArchiveDownload;
      const link = document.createElement("a");
      link.href = `/api/runtime/v1/world-archives/${encodeURIComponent(archive.archiveId)}`;
      link.download = archive.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setMessage(uiText("世界备份已开始下载。"));
    } catch (error) {
      setMessage(archiveErrorMessage(error));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="world-archive-control">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void exportBackup()}
      >
        {busy ? uiText("正在导出…") : uiText(label)}
      </button>
      {started ? (
        <p>
          {uiText(
            "备份包含完整故事、世界文档和模型调用记录，不包含 API Key 和模型配置。",
          )}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}

export function WorldBackupImportButton({
  client,
  disabled = false,
  onBusyChange,
  onImported,
}: {
  client: ArchiveClient;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: () => Promise<void>;
}): React.JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function importBackup(file: File): Promise<void> {
    if (busy) return;
    if (file.size > worldArchiveLimits.archiveBytes) {
      setMessage(uiText("世界备份超过容量限制。"));
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setMessage(uiText("正在上传世界备份：{progress}%", { progress: 0 }));
    try {
      const { uploadId } = await uploadWorldBackup(file, (progress) =>
        setMessage(uiText("正在上传世界备份：{progress}%", { progress })),
      );
      setMessage(uiText("正在校验并导入世界备份…"));
      await client.request({
        type: "world.archive.import",
        operationId: createClientId("archive-import"),
        uploadId,
      });
      await onImported();
      setMessage(uiText("世界备份已导入，新世界已加入列表。"));
    } catch (error) {
      setMessage(archiveErrorMessage(error));
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (picker.current) picker.current.value = "";
    }
  }
  return (
    <div className="world-archive-control">
      <input
        ref={picker}
        className="visually-hidden"
        type="file"
        accept=".zip,application/zip"
        aria-label={uiText("世界备份 ZIP 文件")}
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void importBackup(file);
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => picker.current?.click()}
      >
        {busy ? uiText("正在导入…") : uiText("导入世界备份")}
      </button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}

function uploadWorldBackup(
  file: File,
  progress: (percent: number) => void,
): Promise<{ uploadId: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/runtime/v1/world-archives");
    request.setRequestHeader("Content-Type", "application/zip");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.round((100 * event.loaded) / event.total));
    };
    request.onerror = () =>
      reject(new Error(uiText("世界备份上传失败，请重试。")));
    request.onabort = request.onerror;
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText) as {
          uploadId: string;
          error?: { code?: string; message?: string };
        };
        if (request.status < 200 || request.status >= 300)
          reject(
            new RuntimeRequestError(
              result.error?.message ?? uiText("世界备份上传失败，请重试。"),
              { protocolCode: result.error?.code },
            ),
          );
        else resolve(result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    request.send(file);
  });
}
function archiveErrorMessage(error: unknown): string {
  const code =
    error instanceof RuntimeRequestError ? error.protocolCode : undefined;
  switch (code) {
    case "invalid_archive":
      return uiText("这不是有效的世界备份，请选择世界备份 ZIP。");
    case "unsupported_format":
      return uiText("此世界备份格式不受支持，请升级应用后重试。");
    case "limit_exceeded":
      return uiText("世界备份超过容量限制。");
    case "unsafe_path":
      return uiText("世界备份包含不安全或冲突的文件路径。");
    case "integrity_failed":
      return uiText("世界备份完整性校验失败，未创建世界。");
    case "operation_conflict":
      return uiText("请先等待生成结束，并应用或放弃世界修订，再导出备份。");
    case "inconsistent_materialization":
      return uiText("请先修复世界，再导出备份。");
    case undefined:
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
