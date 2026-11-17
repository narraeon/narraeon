import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { V1Request } from "../protocol/v1.ts";
import { RuntimeRequestError } from "./RuntimeResponse.ts";
import { useReadTarget } from "./useReadTarget.ts";
import { SyncNotice } from "./SyncNotice.tsx";
import { uiText } from "./i18n.ts";

export function PackageScriptPermissionControl({
  client,
  kind,
  id,
  dirty = false,
  onChange,
}: {
  client: { request(request: V1Request): Promise<unknown> };
  kind: "content" | "world";
  id: string;
  dirty?: boolean;
  onChange?: () => void;
}): React.JSX.Element {
  const target = useMemo(() => ({ client, kind, id }), [client, kind, id]);
  const [result, setResult] = useState<{
    target: typeof target;
    enabled?: boolean;
    error?: string;
  } | null>(null);
  const [writeTarget, setWriteTarget] = useState<typeof target | null>(null);
  const pending = writeTarget === target;
  const status = result?.target === target ? result : null;
  const error = status?.error;
  const version = useRef(0);
  const {
    target: permissionTarget,
    syncFailed,
    syncError,
  } = useReadTarget(
    useCallback(
      async () =>
        permissionStatus(
          await client.request(
            kind === "content"
              ? { type: "content.scripts.read", packageId: id }
              : { type: "world.package-scripts.read", worldId: id },
          ),
        ),
      [client, kind, id],
    ),
    useCallback(
      (value: { enabled: boolean }) => setResult({ target, ...value }),
      [target],
    ),
  );
  useEffect(() => {
    void permissionTarget.read();
    return () => {
      version.current += 1;
    };
  }, [permissionTarget, dirty]);
  async function change(enabled: boolean): Promise<void> {
    if (pending) return;
    const writeVersion = ++version.current;
    setWriteTarget(target);
    try {
      const value = await client.request(
        kind === "content"
          ? { type: "content.scripts.set", packageId: id, enabled }
          : { type: "world.package-scripts.set", worldId: id, enabled },
      );
      if (writeVersion === version.current) {
        permissionTarget.accept();
        setResult({ target, ...permissionStatus(value) });
        onChange?.();
      }
    } catch (error) {
      if (writeVersion === version.current) {
        await permissionTarget.recover();
        if (error instanceof RuntimeRequestError && error.kind === "runtime")
          setResult((current) => ({
            ...(current?.target === target ? current : { target }),
            error: error.message,
          }));
      }
    } finally {
      if (writeVersion === version.current) version.current += 1;
      setWriteTarget((current) => (current === target ? null : current));
    }
  }
  return (
    <section className="package-script-permission">
      <h4 className="visually-hidden">{uiText("内容包脚本权限")}</h4>
      <p>
        {uiText(
          "仅授权此处已保存的资源代码。导入不会授权，资源修改后需要重新授权；关闭立即停止此来源脚本，HTML 和样式仍可显示。",
        )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={status?.enabled ?? false}
          disabled={dirty || pending || status?.enabled === undefined}
          onChange={(event) => void change(event.target.checked)}
        />
        {uiText("允许运行内容包脚本")}
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() => void change(false)}
      >
        {uiText("撤销全部包脚本授权")}
      </button>
      {dirty ? <p>{uiText("请先保存修改，再授权资源代码。")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <SyncNotice
        failed={syncFailed}
        reason={syncError}
        onRead={() => void permissionTarget.recover()}
      />
    </section>
  );
}
function permissionStatus(value: unknown): { enabled: boolean } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("Invalid package permission response");
  return { enabled: value.enabled };
}
