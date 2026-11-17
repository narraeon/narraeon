import { useEffect, useRef, useState } from "react";
import type { V1Request } from "../protocol/v1.ts";
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
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const writeVersion = useRef(0);
  const writing = useRef(false);
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    writing.current = false;
    setPending(false);
    return () => {
      writeVersion.current += 1;
    };
  }, [client, kind, id]);
  useEffect(() => {
    if (writing.current) return;
    let active = true;
    const version = writeVersion.current;
    setStatus(null);
    setError("");
    void client
      .request(
        kind === "content"
          ? { type: "content.scripts.read", packageId: id }
          : { type: "world.package-scripts.read", worldId: id },
      )
      .then((result) => {
        if (active && version === writeVersion.current)
          setStatus(permissionStatus(result));
      })
      .catch((error) => {
        if (active && version === writeVersion.current) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [client, kind, id, dirty, readAttempt]);
  async function change(enabled: boolean): Promise<void> {
    if (writing.current) return;
    writing.current = true;
    const version = ++writeVersion.current;
    setPending(true);
    setError("");
    try {
      const result = await client.request(
        kind === "content"
          ? { type: "content.scripts.set", packageId: id, enabled }
          : { type: "world.package-scripts.set", worldId: id, enabled },
      );
      if (version === writeVersion.current) {
        setStatus(permissionStatus(result));
        onChange?.();
      }
    } catch (error) {
      if (version === writeVersion.current) setError(String(error));
    } finally {
      if (version === writeVersion.current) {
        writing.current = false;
        setPending(false);
      }
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
          disabled={dirty || pending || status === null}
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
      {error && (
        <div role="alert">
          {error}{" "}
          <button
            type="button"
            disabled={pending}
            onClick={() => setReadAttempt((value) => value + 1)}
          >
            {uiText("重试")}
          </button>
        </div>
      )}
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
