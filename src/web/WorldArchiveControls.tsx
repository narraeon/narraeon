import { useRef, useState } from "react";
import {
  worldArchiveLimits,
  type WorldArchiveDownload,
} from "../protocol/worldArchives.ts";
import type { V1Request } from "../protocol/v1.ts";
import { createClientId } from "./ClientId.ts";
import { RuntimeRequestError } from "./runtimeClient.ts";
import { saveFile } from "./androidBridge.ts";
import { uiText } from "./i18n.ts";
import {
  runtimeErrorText,
  runtimeUnreadableResponseText,
} from "./RuntimeErrorText.ts";

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
      const path = `/api/runtime/v1/world-archives/${encodeURIComponent(archive.archiveId)}`;
      await confirmArchiveDownload(path);
      const outcome = await saveFile(archive.fileName, { path });
      setMessage(outcome === "cancelled" ? "" : uiText("世界备份已开始下载。"));
    } catch (error) {
      setMessage(archiveDownloadErrorMessage(error));
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
      let result: {
        uploadId: string;
        error?: { code?: string; message?: string };
      };
      try {
        result = JSON.parse(request.responseText) as typeof result;
      } catch {
        reject(
          new RuntimeRequestError(
            runtimeUnreadableResponseText(request.status),
          ),
        );
        return;
      }
      if (request.status < 200 || request.status >= 300)
        reject(
          new RuntimeRequestError(
            result.error?.message === undefined
              ? uiText("世界备份上传失败，请重试。")
              : runtimeErrorText(result.error.message),
            { protocolCode: result.error?.code },
          ),
        );
      else resolve(result);
    };
    request.send(file);
  });
}

/**
 * Asks the server whether the export at `path` can be downloaded, without
 * transferring it. The download itself is one-time and is started afterwards,
 * so a missing or failing export is reported here instead of by the browser.
 */
async function confirmArchiveDownload(path: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${path}/check`);
  } catch {
    throw new RuntimeRequestError(uiText("下载失败，请重试。"));
  }
  if (response.ok) return;
  const body = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string } } | undefined;
  throw new RuntimeRequestError(
    body?.error?.message === undefined
      ? uiText("下载失败，请重试。")
      : runtimeErrorText(body.error.message),
    { protocolCode: body?.error?.code },
  );
}

function archiveDownloadErrorMessage(error: unknown): string {
  return error instanceof RuntimeRequestError &&
    error.protocolCode === "invalid_archive"
    ? uiText("备份已失效或不存在，请重新导出。")
    : archiveErrorMessage(error);
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
